// netlify/functions/email-archive/email-archive.js
//
// The email archive: every email to and from the people on our events,
// enquiries and lettings, read from the farm Gmail (hawthbushfarm@gmail.com)
// and kept in the database, so nobody has to "Connect Gmail" to see them.
//
// It uses the connection already made for the Airbnb emails (airbnb_mail_state,
// the sealed refresh token, gmail.readonly). Nothing is ever sent, moved or
// marked read.
//
//   POST {action:"sync"}        admin, or the half-hourly shim (x-admin-token)
//   POST {action:"attachment", gmail_id, part, folder}
//                               admin: copy one attachment of an archived email
//                               into the booking-files bucket and return its
//                               path — the app adds it to the record's Files
//
// A sync, inside Netlify's ten seconds:
//   1. copies in the emails the app sent itself (hbf_email_log_v1 keeps only the
//      last 500);
//   2. looks at what arrived or was sent since the last good run (from two days
//      before it): each new message's From/To/Cc is read, and only one with an
//      address on a record is read in full and stored — the rest are noted as
//      seen, so they are not looked at again;
//   3. reads back to 1 Jan 2025, a few record addresses at a time, for every
//      address not read back yet — which is how a new enquiry gets the emails
//      that came before anybody typed it in. Taking its time is the point: the
//      first run has hundreds of addresses, and Gmail allows each mailbox about
//      250 units a second (a read costs 5). Three reads at a time, paced, and a
//      429 stops the run as "throttled", not failed;
//   4. once a day, deletes emails of enquiries that never booked once they are
//      two years old (email_purge, given the list of addresses to keep).
//
// What is kept of an email: who, when, which way, the subject, the plain text
// with the quoted history cut off (parse.js), and the LIST of its real
// attachments — no signature logos. A file is copied only when somebody
// presses "Save to files" on the record.
//
// Required env vars: SUPABASE_SERVICE_KEY, HBF_ADMIN_TOKEN, GOOGLE_CLIENT_SECRET.

"use strict";

const crypto = require("crypto");
const P = require("./parse.js");

const SUPABASE_URL  = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || "631658172216-bh6vocim7t41lf8nhr21bdpb2ss2n1mm.apps.googleusercontent.com";
const BUCKET        = "booking-files";
const KEYS          = { events: "hawthbush_bookings_v6", enquiries: "hbf_enquiries_v1", accom: "hbf_accom_v1", log: "hbf_email_log_v1" };
const SCAN_FROM     = "2025/01/01";        // Toby's choice: the start of 2025
const READ_BUDGET_MS = 5500;
const PARALLEL      = 3;
const PACE_MS       = 120;
const BATCH         = 8;                   // addresses per backfill search
const KEEP_DAYS     = 730;                 // enquiries that never booked: two years
const MAX_ATTACHMENT = 45 * 1024 * 1024;   // the bucket takes 50MB

function serviceKey() { return process.env.SUPABASE_SERVICE_KEY; }
function adminToken() { return process.env.HBF_ADMIN_TOKEN; }
function json(code, obj) { return { statusCode: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) }; }

// ── Supabase (service role) ─────────────────────────────────────────────────
async function sb(path, opts) {
  opts = opts || {};
  const res = await fetch(SUPABASE_URL + path, {
    method: opts.method || "GET",
    headers: Object.assign({ apikey: serviceKey(), Authorization: "Bearer " + serviceKey(), "Content-Type": "application/json" }, opts.headers || {}),
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error("Supabase " + (opts.method || "GET") + " " + path.split("?")[0] + " failed (" + res.status + "): " + text.slice(0, 200));
  return text ? JSON.parse(text) : null;
}
const rpc = (fn, args) => sb("/rest/v1/rpc/" + fn, { method: "POST", body: args || {} });
// The read a write depends on: throws on failure, null only when never saved.
async function appDataStrict(key) {
  const rows = await sb("/rest/v1/app_data?key=eq." + encodeURIComponent(key) + "&select=value");
  if (!Array.isArray(rows)) throw new Error("app_data read of " + key + " returned no list");
  return rows[0] ? rows[0].value : null;
}
async function getState() {
  const rows = await sb("/rest/v1/email_archive_state?id=eq.1&select=*");
  if (!rows || !rows[0]) throw new Error("email_archive_state is missing — has migration 2026-10-28s been applied?");
  return rows[0];
}
const setState = (patch) => sb("/rest/v1/email_archive_state?id=eq.1", { method: "PATCH", body: patch });

// Which of these Gmail ids are already stored, or already looked at.
async function knownIds(ids) {
  const known = {};
  const chunks = [];
  for (let i = 0; i < ids.length; i += 150) chunks.push(ids.slice(i, i + 150));
  await Promise.all(chunks.map(async (c) => {
    const list = c.map(encodeURIComponent).join(",");
    const [a, b] = await Promise.all([
      sb("/rest/v1/email_messages?select=gmail_id&gmail_id=in.(" + list + ")"),
      sb("/rest/v1/email_archive_seen?select=gmail_id&gmail_id=in.(" + list + ")")
    ]);
    (a || []).concat(b || []).forEach((r) => { known[r.gmail_id] = true; });
  }));
  return known;
}

// ── The farm Gmail (the Airbnb-mail connection) ─────────────────────────────
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
async function farmGmailAccess() {
  const rows = await sb("/rest/v1/airbnb_mail_state?id=eq.1&select=token_enc,account_email");
  const row = rows && rows[0];
  if (!row || !row.token_enc) { const e = new Error("the farm Gmail is not connected (Lettings → Settings → Airbnb Sync)"); e.notConnected = true; throw e; }
  const t = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      grant_type: "refresh_token", refresh_token: openSealedToken(row.token_enc) }).toString()
  });
  const data = await t.json().catch(() => ({}));
  if (!t.ok || !data.access_token) throw new Error("Google refused the stored Gmail access (" + (data.error || t.status) + ") — connect Gmail again in Lettings → Settings → Airbnb Sync");
  return { access: data.access_token, account: row.account_email || "" };
}
async function gmail(access, path) {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, { headers: { Authorization: "Bearer " + access } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || "";
    const e = new Error("Gmail " + path.split("?")[0] + " failed (" + res.status + "): " + msg);
    e.status = res.status;
    e.quota = res.status === 429 || (res.status === 403 && /quota|rate ?limit/i.test(msg + JSON.stringify(data.error || {})));
    throw e;
  }
  return data;
}
async function listIds(access, q, max) {
  const out = [];
  let page = null;
  do {
    const d = await gmail(access, "messages?maxResults=500&q=" + encodeURIComponent(q) + (page ? "&pageToken=" + page : ""));
    (d.messages || []).forEach((m) => { if (out.indexOf(m.id) === -1) out.push(m.id); });
    page = d.nextPageToken || null;
  } while (page && out.length < max);
  return out;
}
const META = "?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc";

// A few at a time, paced, until the deadline or Gmail says slow down.
async function pool(items, deadline, fn) {
  const done = {};
  let next = 0, failed = 0, throttled = false;
  async function worker() {
    while (!throttled && next < items.length && Date.now() < deadline) {
      const it = items[next++];
      try { await fn(it); done[it] = true; }
      catch (e) {
        if (e.quota) { throttled = true; break; }
        failed++;
        console.error("[email-archive] " + it + ": " + e.message);
      }
      await new Promise((r) => setTimeout(r, PACE_MS));
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return { done, failed, throttled };
}

// Gmail no longer has it (deleted between the list and the read: 404, or a
// bad id: 400), or it cannot be made into a row: noted as seen, with a log
// line, rather than failed. A failed email is tried again next run, and one
// that ALWAYS fails used to hold the read-back (and the recent look-back) up
// for good (28 Oct review).
async function readOrSkip(id, seen, fn) {
  try { return await fn(); }
  catch (e) {
    if (e.quota) throw e;
    if (e.status === 404 || e.status === 400 || e.unreadable) {
      console.error("[email-archive] skipped " + id + ": " + e.message);
      seen.push(id);
      return;
    }
    throw e;
  }
}
function rowOf(msg) {
  try { return P.buildRow(msg); }
  catch (e) { const err = new Error("could not read the email: " + e.message); err.unreadable = true; throw err; }
}

function ymd(d) { return d.getUTCFullYear() + "/" + String(d.getUTCMonth() + 1).padStart(2, "0") + "/" + String(d.getUTCDate()).padStart(2, "0"); }

// ── One sync ────────────────────────────────────────────────────────────────
async function runSync() {
  const started = Date.now();
  const deadline = started + READ_BUDGET_MS;
  const now = new Date().toISOString();
  const state = await getState();

  const [events, enquiries, accom, log] = await Promise.all([KEYS.events, KEYS.enquiries, KEYS.accom, KEYS.log].map(appDataStrict));
  const rec = P.recordAddresses(events, enquiries, accom);
  const allAddrs = Object.keys(rec.all).sort();

  // 1. The app's own emails.
  const appRows = P.logRows(log, state.app_log_upto);
  const newestApp = (Array.isArray(log) ? log : []).reduce((m, e) => (e && e.sentAt && e.sentAt > m ? e.sentAt : m), state.app_log_upto || "");

  const rows = [], seen = [], addressesDone = [];
  let g = null, gmailError = null, throttled = false, failed = 0, recentDone = false, recentLeft = 0;
  try { g = await farmGmailAccess(); }
  catch (e) { gmailError = e.message; }

  if (g) {
    try {
      // 2. What is new since the last good run.
      const lastOk = state.last_ok_at ? Date.parse(state.last_ok_at) : Date.now();
      const back = Math.min(60, Math.max(4, Math.ceil((Date.now() - lastOk) / 86400000) + 2));
      const recentIds = await listIds(g.access, "after:" + ymd(new Date(Date.now() - back * 86400000)) + " -from:airbnb.com -in:chats", 1500);
      const known = await knownIds(recentIds);
      const fresh = recentIds.filter((id) => !known[id]);
      const r = await pool(fresh, deadline, (id) => readOrSkip(id, seen, async () => {
        const meta = await gmail(g.access, "messages/" + id + META);
        if (P.isDraft(meta) || !P.messageAddrs(meta).some((a) => rec.all[a])) { seen.push(id); return; }
        const row = rowOf(await gmail(g.access, "messages/" + id + "?format=full"));
        if (row) rows.push(row); else seen.push(id);
      }));
      failed += r.failed; throttled = r.throttled;
      recentLeft = fresh.filter((id) => !r.done[id]).length;
      recentDone = recentLeft === 0;

      // 3. Read back each address not read back yet, a few at a time.
      if (!throttled && Date.now() < deadline) {
        const doneRows = await sb("/rest/v1/email_archive_addresses?select=addr&limit=10000");
        const doneSet = {};
        (doneRows || []).forEach((x) => { doneSet[x.addr] = true; });
        const pending = allAddrs.filter((a) => !doneSet[a]);
        for (let i = 0; i < pending.length && !throttled && Date.now() < deadline; i += BATCH) {
          const batch = pending.slice(i, i + BATCH);
          const ids = await listIds(g.access, P.addressQuery(batch, SCAN_FROM), 3000);
          const have = await knownIds(ids);
          const need = ids.filter((id) => !have[id] && !rows.some((x) => x.gmail_id === id) && seen.indexOf(id) === -1);
          const b = await pool(need, deadline, (id) => readOrSkip(id, seen, async () => {
            const row = rowOf(await gmail(g.access, "messages/" + id + "?format=full"));
            if (row) rows.push(row); else seen.push(id);
          }));
          failed += b.failed; throttled = throttled || b.throttled;
          if (need.every((id) => b.done[id]) && !b.failed) {
            batch.forEach((a) => addressesDone.push({ addr: a, found: ids.length }));
          } else break;
        }
      }
    } catch (e) {
      if (e.quota) throttled = true;
      else { gmailError = e.message; console.error("[email-archive] " + e.message); }
    }
  }

  const stored = (appRows.length || rows.length || seen.length || addressesDone.length)
    ? await rpc("email_ingest", { p: P.scrubDeep({ messages: appRows.concat(rows), seen: seen, addresses_done: addressesDone }) })
    : { messages: 0, seen: 0, addresses: 0 };

  // 4. Two years, then gone — once a day, never from an empty keep list.
  let purged = null;
  const purgeDue = !state.last_purge_at || Date.now() - Date.parse(state.last_purge_at) > 20 * 3600000;
  if (purgeDue && Array.isArray(events) && events.length && Array.isArray(accom) && accom.length && rec.keep.length) {
    try { purged = await rpc("email_purge", { p_keep: rec.keep, p_before: new Date(Date.now() - KEEP_DAYS * 86400000).toISOString() }); }
    catch (e) { console.error("[email-archive] purge: " + e.message); }
  }

  const doneCount = await sb("/rest/v1/email_archive_addresses?select=addr&limit=10000");
  const doneAll = {};
  (doneCount || []).forEach((x) => { doneAll[x.addr] = true; });
  const pendingLeft = allAddrs.filter((a) => !doneAll[a]).length;

  const result = { stored: stored.messages || 0, app: appRows.length, seen: stored.seen || 0, addressesRead: addressesDone.length,
    addresses: allAddrs.length, pending: pendingLeft, recentLeft: recentLeft, failed: failed, throttled: throttled,
    purged: purged, ms: Date.now() - started };
  const error = gmailError ? gmailError
    : throttled ? "Gmail asked us to slow down; the next run carries on where this one stopped."
    : failed ? failed + " email(s) could not be read; they will be tried again" : null;
  await setState({ last_sync_at: now, last_ok_at: g && recentDone && !failed && !throttled ? now : state.last_ok_at,
    last_error: error, last_result: result, app_log_upto: newestApp || null });
  console.log("[email-archive] " + JSON.stringify(result) + (error ? " — " + error : ""));
  return Object.assign({ ok: true, connected: !!g, account: g ? g.account : null, error: error,
    more: !!g && !gmailError && (pendingLeft > 0 || recentLeft > 0) }, result);
}

// ── One attachment into a record's Files ────────────────────────────────────
async function saveAttachment(body) {
  const gmailId = String(body.gmail_id || "");
  const part = String(body.part || "");
  const folder = String(body.folder || "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(gmailId) || !part) return json(400, { error: "which email and attachment?" });
  if (!/^[a-z]{3,20}s\/[A-Za-z0-9_.@-]{1,100}$/.test(folder)) return json(400, { error: "bad folder" });
  // Only an attachment of an email in the archive — never anything else in the mailbox.
  const rows = await sb("/rest/v1/email_messages?gmail_id=eq." + encodeURIComponent(gmailId) + "&select=gmail_id,direction,attachments");
  const row = rows && rows[0];
  const att = row && (row.attachments || []).find((a) => String(a.part) === part);
  if (!att) return json(404, { error: "That attachment is not in the email archive." });

  const g = await farmGmailAccess();
  const msg = await gmail(g.access, "messages/" + gmailId + "?format=full");
  // Gmail's attachment ids change between reads; the part number does not.
  const p = P.findPartById(msg.payload, part);
  if (!p || !p.body) return json(404, { error: "Gmail no longer has that attachment." });
  const data = p.body.data || (await gmail(g.access, "messages/" + gmailId + "/attachments/" + encodeURIComponent(p.body.attachmentId))).data;
  const buf = Buffer.from(String(data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (!buf.length) return json(502, { error: "Gmail sent the attachment back empty." });
  if (buf.length > MAX_ATTACHMENT) return json(413, { error: "That file is too big to keep (over 45MB)." });

  const safe = String(att.name || "attachment").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
  const path = folder + "/" + Date.now() + "_" + safe;
  const up = await fetch(SUPABASE_URL + "/storage/v1/object/" + BUCKET + "/" + path, {
    method: "POST",
    headers: { apikey: serviceKey(), Authorization: "Bearer " + serviceKey(), "Content-Type": att.mime || "application/octet-stream", "x-upsert": "false" },
    body: buf
  });
  if (!up.ok) return json(502, { error: "Storing the file failed (" + up.status + "): " + (await up.text()).slice(0, 160) });
  return json(200, { ok: true, path: path, name: att.name, mime: att.mime || "", size: buf.length, direction: row.direction });
}

// ── Who is calling (copied, not shared, like every helper here) ─────────────
async function resolveStaff(event, roles) {
  const key = serviceKey();
  const h = (event && event.headers) || {};
  const jwt = String(h["authorization"] || h["Authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt || !key) return null;
  try {
    const res = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { apikey: key, Authorization: "Bearer " + jwt } });
    if (!res.ok) return null;
    const user = await res.json();
    if (!user || !user.id) return null;
    const pr = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + encodeURIComponent(user.id) + "&select=role,active", {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
    if (!pr.ok) return null;
    const rows = await pr.json();
    const p = Array.isArray(rows) ? rows[0] : null;
    if (!p || p.active === false || roles.indexOf(p.role) === -1) return null;
    return { id: user.id, role: p.role };
  } catch (e) {
    console.error("resolveStaff failed:", e.message);
    return null;
  }
}
function tokenMatches(given, expected) {
  if (!expected || typeof given !== "string" || !given) return false;
  const a = Buffer.from(given, "utf8"), b = Buffer.from(String(expected), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

exports.handler = async function (event) {
  try {
    if (!serviceKey()) return json(500, { error: "SUPABASE_SERVICE_KEY is not set" });
    if (event.httpMethod !== "POST") return json(405, { error: "Use POST" });
    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "bad JSON" }); }
    const action = String(body.action || "sync");
    const h = event.headers || {};
    const fromCron = tokenMatches(h["x-admin-token"] || "", adminToken());
    // Guests' emails are personal: admins only. Bar and cleaner logins are
    // staff, and are refused here as the database refuses them.
    const staff = fromCron ? null : await resolveStaff(event, ["admin"]);
    if (!staff && !(fromCron && action === "sync")) return json(401, { error: "Admins only" });
    if (action === "sync") return json(200, await runSync());
    if (action === "attachment") return await saveAttachment(body);
    return json(400, { error: "unknown action" });
  } catch (e) {
    console.error("[email-archive] " + (e && e.stack || e));
    try { await setState({ last_error: String(e.message || e).slice(0, 300), last_sync_at: new Date().toISOString() }); } catch (e2) { /* nothing more to do */ }
    return json(500, { error: String(e.message || e) });
  }
};
