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
//        receipts for what we send. Signed by Meta with the app secret:
//        anything whose X-Hub-Signature-256 does not match WHATSAPP_APP_SECRET
//        is refused. With no secret set, EVERY post is refused (503, so Meta
//        keeps delivering and nothing is lost once it is set) — the address
//        is public, and an unchecked post could fake a guest's message or an
//        arrival time (30 Oct review).
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
// Photos, voice notes, videos and files (30 Oct) are fetched from Meta with
// WHATSAPP_TOKEN and attached to the email, up to MAX_ATTACH bytes; anything
// bigger, or that cannot be fetched, is named in the email instead. A failed
// fetch never fails the delivery — the text still goes.
const crypto = require("crypto");

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "";
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || "";

const WA_TOKEN = process.env.WHATSAPP_TOKEN || "";
const GRAPH = "https://graph.facebook.com/v23.0";
const MAX_ATTACH = 10 * 1024 * 1024;
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

// The attachment on a message, as kept on its row: Meta's media id, type,
// file name and mime type.
function mediaOf(m) {
  const kinds = ["image", "audio", "video", "document", "sticker"];
  if (kinds.indexOf(m.type) === -1 || !m[m.type] || !m[m.type].id) return null;
  const x = m[m.type];
  return { type: m.type, id: String(x.id), mime: x.mime_type || "", name: x.filename || "" };
}

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "audio/ogg": "ogg", "audio/mpeg": "mp3",
  "audio/mp4": "m4a", "audio/aac": "aac", "video/mp4": "mp4", "video/3gpp": "3gp", "application/pdf": "pdf" };
function fileName(media) {
  if (media.name) return media.name.replace(/[\\/\r\n"]/g, "_").slice(0, 120);
  const base = { image: "whatsapp-photo", audio: "whatsapp-voice-note", video: "whatsapp-video", sticker: "whatsapp-sticker", document: "whatsapp-file" }[media.type] || "whatsapp-file";
  const ext = EXT[String(media.mime).split(";")[0].trim()] || "bin";
  return base + "." + ext;
}

// Fetch one attachment from Meta. Returns { filename, content (base64) } or
// { skipped: reason }.
async function fetchMedia(media) {
  if (!WA_TOKEN) return { skipped: "the app has no WhatsApp token" };
  try {
    const metaRes = await fetch(GRAPH + "/" + encodeURIComponent(media.id), { headers: { "Authorization": "Bearer " + WA_TOKEN } });
    if (!metaRes.ok) return { skipped: "Meta would not give it to us (" + metaRes.status + ")" };
    const info = await metaRes.json();
    if (info.file_size && Number(info.file_size) > MAX_ATTACH) return { skipped: "it is too big to attach (" + Math.round(info.file_size / 1048576) + "MB)" };
    const fileRes = await fetch(info.url, { headers: { "Authorization": "Bearer " + WA_TOKEN } });
    if (!fileRes.ok) return { skipped: "the download failed (" + fileRes.status + ")" };
    const buf = Buffer.from(await fileRes.arrayBuffer());
    if (buf.length > MAX_ATTACH) return { skipped: "it is too big to attach" };
    return { filename: fileName(Object.assign({}, media, { mime: media.mime || info.mime_type || "" })), content: buf.toString("base64") };
  } catch (e) {
    return { skipped: "the download failed" };
  }
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

// ── Arrival times ────────────────────────────────────────────────────────────
// The pre-arrival WhatsApp has tap-to-answer buttons whose payload names the
// booking and the arrival day ("eta|<id>@<day>|<n>", whatsapp-reminders). A
// tap is saved on the letting as arrivalEta { text, date, at, via }. The
// lettings array is shared, so this writes it the way the Airbnb reader does:
// a fresh read, the one field changed, and a PATCH that only lands if nobody
// wrote in between (updated_at unchanged) — tried again on a clash. The
// lettings form keeps arrivalEta from the server copy when it saves.
const ETA_RE = /^eta\|(.+)@(\d{4}-\d{2}-\d{2})\|(\d+)$/;
const ETA_LABELS = ["Before 6pm", "6pm to 9pm", "After 9pm"];   // as templates.js pre_arrival.quickReplies

function etaOf(m) {
  if (m.type !== "button" || !m.button) return null;
  const x = ETA_RE.exec(String(m.button.payload || ""));
  if (!x) return null;
  return { bookingId: x[1], date: x[2], text: m.button.text || ETA_LABELS[Number(x[3])] || "" };
}

async function saveEta(eta, at) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(SUPABASE_URL + "/rest/v1/app_data?key=eq." + KEYS.accom + "&select=value,updated_at", { headers: sbHeaders() });
    if (!res.ok) throw new Error("read lettings " + res.status);
    const rows = await res.json();
    if (!rows[0] || !Array.isArray(rows[0].value)) return { saved: false, why: "no lettings" };
    const list = rows[0].value;
    const b = list.filter(function (x) { return x && String(x.id) === String(eta.bookingId); })[0];
    if (!b) return { saved: false, why: "booking not found" };
    const cur = b.arrivalEta || {};
    if (cur.text === eta.text && cur.date === eta.date) return { saved: true, name: b.guestName || "" };
    b.arrivalEta = { text: eta.text, date: eta.date, at: at, via: "whatsapp" };
    const put = await fetch(SUPABASE_URL + "/rest/v1/app_data?key=eq." + KEYS.accom + "&updated_at=eq." + encodeURIComponent(rows[0].updated_at), {
      method: "PATCH", headers: sbHeaders({ "Prefer": "return=representation" }),
      body: JSON.stringify({ value: list, updated_at: new Date().toISOString() })
    });
    if (!put.ok) throw new Error("save lettings " + put.status);
    const done = await put.json();
    if (Array.isArray(done) && done.length) return { saved: true, name: b.guestName || "" };
    // Somebody saved in between: read again and retry.
  }
  return { saved: false, why: "the bookings kept changing" };
}

// ── The email ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
}

function prettyNumber(n) {
  return n.startsWith("44") && n.length === 12 ? "0" + n.slice(2, 6) + " " + n.slice(6) : "+" + n;
}

function buildEmail(row, att, eta) {
  const who = row.record_name || row.profile_name || prettyNumber(row.number);
  const media = MEDIA_WORDS[row.msg_type];
  const subject = eta ? "Arrival time from " + who + ": " + (row.body || "") : "WhatsApp from " + who;
  const lines = [];
  if (eta) lines.push("<p><em>" + (eta.saved ? "They tapped an arrival time on the pre-arrival WhatsApp — it is saved on the booking."
    : "They tapped an arrival time on the pre-arrival WhatsApp, but it could not be saved on the booking (" + esc(eta.why || "error") + ") — please add it by hand.") + "</em></p>");
  if (media && att && att.filename) lines.push("<p><em>They sent " + media + " — it is attached (" + esc(att.filename) + ").</em></p>");
  else if (media && att && att.skipped) lines.push("<p><em>They sent " + media + ", but it could not be attached: " + esc(att.skipped) +
    ". Please get in touch with them if it matters.</em></p>");
  else if (media) lines.push("<p><em>They sent " + media + ".</em></p>");
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

async function sendEmail(row, eta) {
  const att = row.media && row.media.id ? await fetchMedia(row.media) : null;
  const e = buildEmail(row, att, eta);
  const msg = { from: FROM_HEADER, to: FORWARD_TO, subject: e.subject, html: e.html };
  if (att && att.filename) msg.attachments = [{ filename: att.filename, content: att.content }];
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(msg)
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
    let recs = findRecords(lists, number);
    const text = messageText(x.m);
    // A tapped arrival time names its booking exactly — better than a phone match.
    const eta = etaOf(x.m);
    if (eta) {
      const b = (lists.accom || []).filter(function (r) { return r && String(r.id) === eta.bookingId; })[0];
      if (b) recs = [{ kind: "accom", id: String(b.id), name: recordName("accom", b) }];
    }
    return {
      id: String(x.m.id), direction: "in", number: number, profile_name: x.name,
      msg_type: String(x.m.type || "unknown"), body: text ? text.slice(0, 4000) : null,
      at: new Date(Number(x.m.timestamp || 0) * 1000 || Date.now()).toISOString(),
      media: mediaOf(x.m),
      record_kind: recs[0] ? recs[0].kind : null, record_id: recs[0] ? recs[0].id : null,
      record_name: recs.length ? recs.map(function (r) { return r.name; }).join(" / ") : null
    };
  });
  await insertMessages(rows);

  // Whatever is not yet emailed — new rows, or ones a failed email left.
  const pending = await unemailed(rows.map(function (r) { return r.id; }));
  const byId = {};
  msgs.forEach(function (x) { byId[String(x.m.id)] = x.m; });
  for (const row of pending) {
    // Save a tapped arrival time first; a failure is told in the email, never
    // a failed delivery (Meta would deliver it again and again).
    let etaNote = null;
    const eta = byId[row.id] ? etaOf(byId[row.id]) : null;
    if (eta) {
      try { etaNote = await saveEta(eta, row.at); }
      catch (e) { etaNote = { saved: false, why: "the save failed" }; console.error("whatsapp-webhook: eta " + e.message); }
    }
    await sendEmail(row, etaNote);
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
  if (!APP_SECRET) {
    console.error("whatsapp-webhook: WHATSAPP_APP_SECRET is not set — refusing (Meta will deliver again)");
    return { statusCode: 503, body: "Not configured" };
  }
  {
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
    console.log("whatsapp-webhook: " + n + " message(s), " + statuses + " status update(s)");
    return { statusCode: 200, body: "OK" };
  } catch (e) {
    // 500 makes Meta deliver again later; the row is kept, only the email is retried.
    console.error("whatsapp-webhook: " + e.message);
    return { statusCode: 500, body: "Try again" };
  }
};

exports._test = { normaliseNumber: normaliseNumber, findRecords: findRecords, messageText: messageText, buildEmail: buildEmail, mediaOf: mediaOf, fileName: fileName, etaOf: etaOf, saveEta: saveEta };
