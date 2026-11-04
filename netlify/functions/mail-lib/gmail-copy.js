// netlify/functions/mail-lib/gmail-copy.js — shared code, not a function.
//
// Files a copy of an email the app has just sent (through Resend) in the farm
// Gmail's Sent folder, so the office sees every automated email to a customer
// exactly where it would see one typed by hand, and the customer's reply
// threads under it (4 Nov 2026, Toby). Resend still does the delivering.
//
// It uses the farm Gmail connection made in Lettings → Settings → Airbnb email
// (the sealed refresh token in airbnb_mail_state), which must have been given
// Gmail's "insert" permission. Without it, nothing is filed and the send is
// unaffected.
//
// The copy carries the SAME Message-ID as the email Resend delivered — read
// back from Resend (GET /emails/:id → message_id) — because Gmail threads the
// customer's reply by the Message-ID it answers.
//
// fileSentCopy NEVER throws and never holds a send up for long: it gives up
// after COPY_BUDGET_MS. A copy that does not happen costs only the copy — the
// email went, and the app's own log still has it (the archive copies log
// entries that have no gmailId).
//
// Not for: sign-in links and codes (portal-auth, the contract invite) — they
// are credentials, never written anywhere staff can read; box office tickets
// (Toby: high volume, all alike); emails to the office or to staff.

"use strict";

const crypto = require("crypto");

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "631658172216-bh6vocim7t41lf8nhr21bdpb2ss2n1mm.apps.googleusercontent.com";
const COPY_SCOPES = [
  "https://www.googleapis.com/auth/gmail.insert",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://mail.google.com/"
];
const COPY_BUDGET_MS = 4000;
const RESEND_PAUSE_MS = process.env.HBF_TEST_FAST ? 0 : 600;
const FROM_EMAIL = "hello@hawthbushfarm.co.uk";
const FROM_NAME = "Hawthbush Farm";

function serviceKey() { return process.env.SUPABASE_SERVICE_KEY; }
function adminToken() { return process.env.HBF_ADMIN_TOKEN; }

// Same sealing as airbnb-mail.js.
function openSealedToken(sealed) {
  const s = String(sealed || "");
  if (!s.startsWith("v1:")) throw new Error("stored Gmail token is in an unknown form");
  if (!adminToken()) throw new Error("HBF_ADMIN_TOKEN is not set");
  const key = crypto.createHash("sha256").update(adminToken() + "|airbnb-gmail-refresh-token").digest();
  const buf = Buffer.from(s.slice(3), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(function () { c.abort(); }, Math.max(1, ms));
  return { signal: c.signal, done: function () { clearTimeout(t); } };
}

// One access token per warm function instance, until shortly before it lapses.
let cached = null;   // { access, scope, until }
async function copyAccess(deadline) {
  if (cached && cached.until > Date.now()) return cached;
  const left = deadline - Date.now();
  if (left < 200) throw new Error("out of time");
  const t1 = withTimeout(left);
  try {
    const res = await fetch(SUPABASE_URL + "/rest/v1/airbnb_mail_state?id=eq.1&select=token_enc", {
      headers: { apikey: serviceKey(), Authorization: "Bearer " + serviceKey() }, signal: t1.signal
    });
    if (!res.ok) throw new Error("reading the Gmail connection: " + res.status);
    const row = (await res.json())[0];
    if (!row || !row.token_enc) throw new Error("the farm Gmail is not connected");
    const t = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: t1.signal,
      body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
        grant_type: "refresh_token", refresh_token: openSealedToken(row.token_enc) }).toString()
    });
    const data = await t.json().catch(function () { return {}; });
    if (!t.ok || !data.access_token) throw new Error("Google refused the stored access (" + (data.error || t.status) + ")");
    cached = { access: data.access_token, scope: String(data.scope || ""),
      until: Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000 - 120000 };
    return cached;
  } finally { t1.done(); }
}
function canCopy(scope) {
  const have = String(scope || "").split(" ");
  return COPY_SCOPES.some(function (s) { return have.indexOf(s) !== -1; });
}

// Whether copies can be filed now: { ok, why }. For previews and status.
async function copyReady() {
  try {
    const a = await copyAccess(Date.now() + COPY_BUDGET_MS);
    return canCopy(a.scope) ? { ok: true }
      : { ok: false, why: "filing in Sent was not allowed when Gmail was connected — connect it again in Lettings → Settings → Airbnb email" };
  } catch (e) { return { ok: false, why: String(e.message || e) }; }
}

// ── The message ──────────────────────────────────────────────────────────────
function mimeWord(s) {
  s = String(s == null ? "" : s).replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7e]*$/.test(s) ? s : "=?UTF-8?B?" + Buffer.from(s, "utf8").toString("base64") + "?=";
}
function b64Lines(buf) { return buf.toString("base64").replace(/.{76}/g, "$&\r\n"); }
function cleanAddr(a) { return String(a || "").replace(/[\r\n<>,;"]/g, "").trim(); }
function list(x) { return (Array.isArray(x) ? x : (x ? String(x).split(",") : [])).map(cleanAddr).filter(Boolean); }
function htmlToText(h) {
  return String(h || "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\n{3,}/g, "\n\n").trim();
}
function mimeType(name) {
  const n = String(name || "").toLowerCase();
  if (/\.pdf$/.test(n)) return "application/pdf";
  if (/\.png$/.test(n)) return "image/png";
  if (/\.jpe?g$/.test(n)) return "image/jpeg";
  if (/\.gif$/.test(n)) return "image/gif";
  if (/\.webp$/.test(n)) return "image/webp";
  if (/\.ics$/.test(n)) return "text/calendar";
  return "application/octet-stream";
}
// attachments: Resend's shape — [{ filename, content (base64) }].
function buildMime(o) {
  const alt = "alt-" + crypto.randomBytes(10).toString("hex");
  const mix = "mix-" + crypto.randomBytes(10).toString("hex");
  const text = o.text ? String(o.text) : htmlToText(o.html);
  const atts = (o.attachments || []).filter(function (a) { return a && a.content && a.filename; });
  // Addresses are cleaned here too, whoever calls: a line break in one would
  // otherwise start a header of its own.
  const to = list(o.to), cc = list(o.cc), bcc = list(o.bcc);
  const head = [
    "From: " + mimeWord(FROM_NAME) + " <" + FROM_EMAIL + ">",
    "To: " + to.join(", ")
  ];
  if (cc.length) head.push("Cc: " + cc.join(", "));
  if (bcc.length) head.push("Bcc: " + bcc.join(", "));
  head.push("Subject: " + mimeWord(o.subject));
  head.push("Date: " + new Date(o.date || Date.now()).toUTCString().replace("GMT", "+0000"));
  head.push("Message-ID: " + String(o.messageId || "").replace(/[\r\n]+/g, ""));
  head.push("MIME-Version: 1.0");
  const altBody = "--" + alt + "\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" +
    b64Lines(Buffer.from(text, "utf8")) + "\r\n" +
    (o.html ? "--" + alt + "\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" +
      b64Lines(Buffer.from(String(o.html), "utf8")) + "\r\n" : "") +
    "--" + alt + "--\r\n";
  if (!atts.length) {
    return head.concat(["Content-Type: multipart/alternative; boundary=\"" + alt + "\""]).join("\r\n") + "\r\n\r\n" + altBody;
  }
  let body = "--" + mix + "\r\nContent-Type: multipart/alternative; boundary=\"" + alt + "\"\r\n\r\n" + altBody;
  atts.forEach(function (a) {
    const name = String(a.filename).replace(/[\r\n"]/g, "");
    body += "--" + mix + "\r\nContent-Type: " + (a.contentType || mimeType(name)) + "; name=\"" + mimeWord(name) + "\"\r\n" +
      "Content-Disposition: attachment; filename=\"" + mimeWord(name) + "\"\r\nContent-Transfer-Encoding: base64\r\n\r\n" +
      b64Lines(Buffer.from(String(a.content), "base64")) + "\r\n";
  });
  body += "--" + mix + "--\r\n";
  return head.concat(["Content-Type: multipart/mixed; boundary=\"" + mix + "\""]).join("\r\n") + "\r\n\r\n" + body;
}

// The Message-ID Resend gave the email, so the copy threads with the reply.
// Resend allows about 2 requests a second for the whole account, and this
// lookup follows a send straight away: wait a moment first (which also gives
// Resend time to have the id), and back off on 429, so it never crowds out the
// next send.
const sleep = function (ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); };
async function resendMessageId(resendId, deadline) {
  const key = process.env.RESEND_API_KEY;
  if (!resendId || !key) return null;
  if (deadline - Date.now() > RESEND_PAUSE_MS + 900) await sleep(RESEND_PAUSE_MS);
  for (let i = 0; i < 2; i++) {
    const left = deadline - Date.now();
    if (left < 300) return null;
    const t = withTimeout(left - 100);
    try {
      const r = await fetch("https://api.resend.com/emails/" + encodeURIComponent(resendId), {
        headers: { Authorization: "Bearer " + key }, signal: t.signal
      });
      if (r.ok) {
        const d = await r.json().catch(function () { return {}; });
        const id = String(d.message_id || "").trim();
        if (/^<[^<>\s]+@[^<>\s]+>$/.test(id)) return id;
      }
      if (r.status === 429) { if (deadline - Date.now() > 1500) await sleep(1000); continue; }
    } catch (e) { /* fall through */ } finally { t.done(); }
    await sleep(250);
  }
  return null;
}

// o: { to, cc?, bcc?, subject, html, text?, attachments?, resendId?, date? }
// → { ok: true, gmailId } | { ok: false, why }. Never throws.
async function fileSentCopy(o) {
  const deadline = Date.now() + (o && o.budgetMs ? o.budgetMs : COPY_BUDGET_MS);
  try {
    const to = list(o && o.to);
    if (!to.length) return { ok: false, why: "no recipient" };
    const a = await copyAccess(deadline);
    if (!canCopy(a.scope)) return { ok: false, why: "no permission to file in Sent" };
    const messageId = (await resendMessageId(o.resendId, deadline)) ||
      "<hbf-" + crypto.randomUUID() + "@hawthbushfarm.co.uk>";
    const raw = buildMime({ to: to, cc: list(o.cc), bcc: list(o.bcc), subject: o.subject || "", html: o.html || "",
      text: o.text || "", attachments: o.attachments || [], messageId: messageId, date: o.date });
    const boundary = "rel-" + crypto.randomBytes(10).toString("hex");
    const payload = "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify({ labelIds: ["SENT"] }) + "\r\n--" + boundary + "\r\nContent-Type: message/rfc822\r\n\r\n" +
      raw + "\r\n--" + boundary + "--";
    const left = deadline - Date.now();
    if (left < 300) return { ok: false, why: "out of time" };
    const t = withTimeout(left);
    try {
      const r = await fetch("https://gmail.googleapis.com/upload/gmail/v1/users/me/messages?uploadType=multipart&internalDateSource=dateHeader", {
        method: "POST", signal: t.signal,
        headers: { Authorization: "Bearer " + a.access, "Content-Type": "multipart/related; boundary=" + boundary },
        body: payload
      });
      if (!r.ok) {
        if (r.status === 401) cached = null;
        return { ok: false, why: "Gmail " + r.status + ": " + (await r.text()).slice(0, 200) };
      }
      const d = await r.json().catch(function () { return {}; });
      return { ok: true, gmailId: d.id || null, messageId: messageId };
    } finally { t.done(); }
  } catch (e) {
    return { ok: false, why: String((e && e.name === "AbortError") ? "out of time" : (e && e.message) || e) };
  }
}

// The id Resend gives an accepted email, from its send response.
async function resendIdOf(res) {
  try {
    const r = res && typeof res.clone === "function" ? res.clone() : res;
    const d = await r.json();
    return d && d.id ? String(d.id) : null;
  } catch (e) { return null; }
}

module.exports = { fileSentCopy, copyReady, resendIdOf, buildMime, canCopy, COPY_SCOPES,
  _reset: function () { cached = null; } };
