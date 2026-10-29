// netlify/functions/whatsapp-webhook.js
// The address Meta calls for the WhatsApp Cloud API (the 01825 number).
//
//   https://hawthbushfarm.netlify.app/.netlify/functions/whatsapp-webhook
//
// GET  — Meta's one-off check when the callback URL is saved in the developer
//        app. It sends hub.mode=subscribe, hub.verify_token and hub.challenge;
//        we answer with the challenge only if the token matches
//        WHATSAPP_VERIFY_TOKEN (a Netlify environment variable).
// POST — every message a guest sends to the 01825 number, and the delivery
//        receipts for what we send. Signed by Meta with the app secret: once
//        WHATSAPP_APP_SECRET is set, anything whose X-Hub-Signature-256 does
//        not match is refused.
//
// A guest's message (Toby, 29 Oct 2026): replies are allowed and are read in
// office hours by email. Each one is
//   1. kept in wa_messages (id = Meta's message id, so a retried delivery
//      never makes a second row), matched by phone number to a letting, an
//      event or an enquiry where one has that number;
//   2. emailed to the farm inbox (FORWARD_TO). emailed_at is set only once
//      Resend has accepted it. If the email fails we answer 500, Meta delivers
//      the same message again later, the insert is a no-op and the email is
//      tried again — so nothing a guest sends is lost to a failed email.
// No auto-reply: the template footer says replies go to email.
//
// Delivery receipts update the status on our own outbound rows.
//
// Nothing a guest writes is logged to Netlify's function log. Counts only.
// Photos, voice notes and files are not fetched yet: the email says one came
// and asks the office to get in touch (the WhatsApp itself is on no phone).
const crypto = require("crypto");

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "";
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || "";

const FORWARD_TO = "hawthbushfarm@gmail.com";
const FROM_HEADER = "Hawthbush Farm <hello@hawthbushfarm.co.uk>";
const KEYS = { accom: "hbf_accom_v1", event: "hawthbush_bookings_v6", enquiry: "hbf_enquiries_v1" };

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

function rawBody(event) {
  if (!event.body) return Buffer.alloc(0);
  return event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body, "utf8");
}

// ── Phone numbers ────────────────────────────────────────────────────────────
// WhatsApp gives the sender as bare international digits (447415740704). The
// records hold whatever was typed: "07415 740704", "+44 7415 740704",
// "7415740704" (the 0 dropped), "Becky 07415 740704". All UK numbers come out
// as 44…; anything under 10 digits (an email typed in the phone box) is no
// number at all.
function normaliseNumber(s) {
  let d = String(s || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = "44" + d.slice(1);
  else if (d.length === 10 && d.startsWith("7")) d = "44" + d;
  return d.length >= 10 ? d : "";
}

function recordName(kind, r) {
  if (kind === "accom") return (r.guestName || "Guest") + " letting";
  if (kind === "event") return (r.couple || r.name || "Event") + " event";
  return (r.name || "Enquiry") + " enquiry";
}

// Every record with this number, lettings first, then events, then enquiries.
// Deleted / cancelled records are still matched — the office would rather
// know who it is than not.
function findRecords(lists, number) {
  const out = [];
  ["accom", "event", "enquiry"].forEach(function (kind) {
    (lists[kind] || []).forEach(function (r) {
      if (r && normaliseNumber(r.phone) === number) {
        out.push({ kind: kind, id: String(r.id), name: recordName(kind, r) });
      }
    });
  });
  return out;
}

// What a message says, as text. Media carries only its caption.
function messageText(m) {
  if (m.type === "text") return (m.text && m.text.body) || "";
  if (m.type === "button") return (m.button && m.button.text) || "";
  if (m.type === "interactive") {
    const i = m.interactive || {};
    return (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || "";
  }
  const media = m[m.type];
  return (media && media.caption) || "";
}

const MEDIA_WORDS = { image: "a photo", audio: "a voice note", video: "a video", document: "a file",
  sticker: "a sticker", location: "a location", contacts: "a contact card" };

// ── Supabase ─────────────────────────────────────────────────────────────────
function sbHeaders(extra) {
  return Object.assign({ "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY,
    "Content-Type": "application/json" }, extra || {});
}

async function sbGetKey(key) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data?key=eq." + key + "&select=value", { headers: sbHeaders() });
  if (!res.ok) throw new Error("read " + key + " failed: " + res.status);
  const rows = await res.json();
  return rows[0] && Array.isArray(rows[0].value) ? rows[0].value : [];
}

async function insertMessages(rows) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/wa_messages?on_conflict=id", {
    method: "POST",
    headers: sbHeaders({ "Prefer": "resolution=ignore-duplicates,return=minimal" }),
    body: JSON.stringify(rows)
  });
  if (!res.ok) throw new Error("insert failed: " + res.status + " " + (await res.text()).slice(0, 200));
}

async function unemailed(ids) {
  const list = ids.map(function (i) { return '"' + i.replace(/"/g, "") + '"'; }).join(",");
  const res = await fetch(SUPABASE_URL + "/rest/v1/wa_messages?select=*&emailed_at=is.null&direction=eq.in&id=in.(" +
    encodeURIComponent(list) + ")", { headers: sbHeaders() });
  if (!res.ok) throw new Error("read back failed: " + res.status);
  return res.json();
}

async function markEmailed(id) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/wa_messages?id=eq." + encodeURIComponent(id), {
    method: "PATCH", headers: sbHeaders({ "Prefer": "return=minimal" }),
    body: JSON.stringify({ emailed_at: new Date().toISOString() })
  });
  if (!res.ok) throw new Error("mark emailed failed: " + res.status);
}

async function setStatus(id, status) {
  // Only ever on our own outbound rows; an unknown id matches nothing.
  await fetch(SUPABASE_URL + "/rest/v1/wa_messages?direction=eq.out&id=eq." + encodeURIComponent(id), {
    method: "PATCH", headers: sbHeaders({ "Prefer": "return=minimal" }), body: JSON.stringify({ status: status })
  });
}

// ── The email ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
}

function prettyNumber(n) {
  return n.startsWith("44") && n.length === 12 ? "0" + n.slice(2, 6) + " " + n.slice(6) : "+" + n;
}

function buildEmail(row) {
  const who = row.record_name || row.profile_name || prettyNumber(row.number);
  const media = MEDIA_WORDS[row.msg_type];
  const subject = "WhatsApp from " + who;
  const lines = [];
  if (media) lines.push("<p><em>They sent " + media + ". Photos, voice notes and files can't be passed on yet — " +
    "please get in touch with them if it matters.</em></p>");
  if (row.body) lines.push('<p style="font-size:16px;line-height:1.5;border-left:3px solid #b8a88a;padding-left:12px">' +
    esc(row.body) + "</p>");
  else if (!media) lines.push("<p><em>(A " + esc(row.msg_type) + " message with no text.)</em></p>");
  lines.push('<p style="color:#7a7060;font-size:13px">From ' + esc(row.profile_name || "—") + " · " +
    esc(prettyNumber(row.number)) + "<br>" +
    (row.record_name ? "On the app as: " + esc(row.record_name) : "This number isn't on any letting, event or enquiry.") +
    "<br>Sent " + esc(new Date(row.at).toLocaleString("en-GB", { timeZone: "Europe/London" })) + "</p>");
  lines.push('<p style="color:#7a7060;font-size:13px">This came to the 01825 WhatsApp number, which nobody reads. ' +
    "Reply by email or phone — a reply to this email goes nowhere useful.</p>");
  return { subject: subject, html: '<div style="font-family:Helvetica,Arial,sans-serif;color:#2d2a25">' + lines.join("") + "</div>" };
}

async function sendEmail(row) {
  const e = buildEmail(row);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_HEADER, to: FORWARD_TO, subject: e.subject, html: e.html })
  });
  if (!res.ok) throw new Error("email failed: " + res.status);
}

// ── The handler ──────────────────────────────────────────────────────────────
async function handleInbound(changes) {
  const msgs = [];
  changes.forEach(function (v) {
    const names = {};
    (v.contacts || []).forEach(function (c) { names[c.wa_id] = c.profile && c.profile.name; });
    (v.messages || []).forEach(function (m) { msgs.push({ m: m, name: names[m.from] || null }); });
  });
  if (!msgs.length) return 0;

  // A failed read of the records must not stop the message being kept and
  // forwarded — it just arrives without a match.
  let lists = {};
  try {
    const got = await Promise.all([sbGetKey(KEYS.accom), sbGetKey(KEYS.event), sbGetKey(KEYS.enquiry)]);
    lists = { accom: got[0], event: got[1], enquiry: got[2] };
  } catch (e) { console.error("whatsapp-webhook: record read failed, forwarding unmatched: " + e.message); }

  const rows = msgs.map(function (x) {
    const number = normaliseNumber(x.m.from) || String(x.m.from || "");
    const recs = findRecords(lists, number);
    const text = messageText(x.m);
    return {
      id: String(x.m.id), direction: "in", number: number, profile_name: x.name,
      msg_type: String(x.m.type || "unknown"), body: text ? text.slice(0, 4000) : null,
      at: new Date(Number(x.m.timestamp || 0) * 1000 || Date.now()).toISOString(),
      record_kind: recs[0] ? recs[0].kind : null, record_id: recs[0] ? recs[0].id : null,
      record_name: recs.length ? recs.map(function (r) { return r.name; }).join(" / ") : null
    };
  });
  await insertMessages(rows);

  // Whatever is not yet emailed — new rows, or ones a failed email left.
  const pending = await unemailed(rows.map(function (r) { return r.id; }));
  for (const row of pending) {
    await sendEmail(row);
    await markEmailed(row.id);
  }
  return msgs.length;
}

exports.handler = async (event) => {
  if (event.httpMethod === "GET") {
    const q = event.queryStringParameters || {};
    if (!VERIFY_TOKEN) {
      console.error("whatsapp-webhook: WHATSAPP_VERIFY_TOKEN is not set");
      return { statusCode: 500, body: "Not configured" };
    }
    if (q["hub.mode"] === "subscribe" && safeEqual(q["hub.verify_token"], VERIFY_TOKEN)) {
      return { statusCode: 200, headers: { "Content-Type": "text/plain" }, body: String(q["hub.challenge"] || "") };
    }
    return { statusCode: 403, body: "Forbidden" };
  }

  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const body = rawBody(event);
  if (APP_SECRET) {
    const h = event.headers || {};
    const sig = String(h["x-hub-signature-256"] || h["X-Hub-Signature-256"] || "");
    const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(body).digest("hex");
    if (!safeEqual(sig, expected)) return { statusCode: 401, body: "Bad signature" };
  }

  let payload;
  try { payload = JSON.parse(body.toString("utf8")); } catch (e) { return { statusCode: 400, body: "Bad JSON" }; }

  const changes = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) if (change.value) changes.push(change.value);
  }

  let statuses = 0;
  try {
    for (const v of changes) {
      for (const s of v.statuses || []) { statuses++; await setStatus(String(s.id), String(s.status || "")); }
    }
    const n = await handleInbound(changes);
    console.log("whatsapp-webhook: " + n + " message(s), " + statuses + " status update(s)" +
      (APP_SECRET ? "" : " (signature not checked: WHATSAPP_APP_SECRET not set)"));
    return { statusCode: 200, body: "OK" };
  } catch (e) {
    // 500 makes Meta deliver again later; the row is kept, only the email is retried.
    console.error("whatsapp-webhook: " + e.message);
    return { statusCode: 500, body: "Try again" };
  }
};

exports._test = { normaliseNumber: normaliseNumber, findRecords: findRecords, messageText: messageText, buildEmail: buildEmail };
