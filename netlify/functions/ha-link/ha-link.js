// netlify/functions/ha-link/ha-link.js
//
// The link between the farm's Home Assistant and this app (3 Nov, Toby).
// Home Assistant is the only caller: it holds a long random token, and the
// table ha_link (RLS on, no policies, service role only) holds its SHA-256.
// No Netlify setting is involved, so the token is changed by writing a new
// hash there — and nothing here can read the token back.
//
//   POST, x-ha-token: <token>
//     { action: "today" }
//         Whether each property is in use / has guests arriving, and whether
//         the Grain Store has an event — feed.js. No names, numbers or money.
//     { action: "alert", title, message }
//         The estate_alert WhatsApp to ha_link.alert_to. Day or night (no quiet
//         hours: these are alarms). The same title at most once a London hour
//         (wa_sent_marks kind "ha", marked BEFORE sending, unmarked if
//         WhatsApp refuses). Sends only while estate_alert is switched ON in
//         Settings → WhatsApp → Messages. Until Meta approves the template it
//         falls back to a plain text, which WhatsApp delivers only within 24
//         hours of the recipient messaging the 01825 number — reported as
//         such, never as delivered. Kept in wa_messages like every send.
//
// Required env vars: SUPABASE_SERVICE_KEY, WHATSAPP_TOKEN

"use strict";

const crypto = require("crypto");
const T = require("../whatsapp-reminders/templates.js");
const F = require("./feed.js");

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const GRAPH = "https://graph.facebook.com/v23.0";
const PHONE_NUMBER_ID = "1454490917738977";   // the 01825 number (as in whatsapp-send.js)
const SETTINGS_KEY = "hbf_whatsapp_settings_v1";
const SUBMITTED_KEY = "hbf_whatsapp_submitted_v1";
const TEMPLATE = "estate_alert";

function json(statusCode, body) {
  return { statusCode: statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}
function sh(extra) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return Object.assign({ "apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json" }, extra || {});
}
async function rest(path, opts) {
  const o = opts || {};
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + path, { method: o.method || "GET", headers: sh(o.headers), body: o.body });
  const text = await res.text();
  if (!res.ok) throw new Error(path.split("?")[0] + " " + res.status + " " + text.slice(0, 200));
  return text ? JSON.parse(text) : null;
}
async function appData(key) {
  const rows = await rest("app_data?key=eq." + encodeURIComponent(key) + "&select=value");
  if (!Array.isArray(rows)) throw new Error("read " + key + ": not a list");
  return rows[0] ? rows[0].value : null;
}

// The caller's token against the stored hash, in constant time.
async function linkFor(event) {
  const h = (event && event.headers) || {};
  const token = String(h["x-ha-token"] || h["X-Ha-Token"] || "").trim();
  if (token.length < 32) return null;
  const rows = await rest("ha_link?id=eq.1&select=token_hash,alert_to");
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || !row.token_hash) return null;
  const want = Buffer.from(String(row.token_hash), "hex");
  const got = crypto.createHash("sha256").update(token).digest();
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  return { alertTo: (row.alert_to || []).map(String).filter(function (n) { return /^\d{10,15}$/.test(n); }) };
}

async function graphSend(payload) {
  const res = await fetch(GRAPH + "/" + PHONE_NUMBER_ID + "/messages", {
    method: "POST",
    headers: { "Authorization": "Bearer " + process.env.WHATSAPP_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({ messaging_product: "whatsapp" }, payload))
  });
  const d = await res.json().catch(function () { return null; });
  if (!res.ok || !d || !d.messages || !d.messages[0]) {
    const e = new Error("WhatsApp " + res.status + (d && d.error ? ": " + (d.error.error_user_msg || d.error.message) : ""));
    e.code = d && d.error && d.error.code;
    throw e;
  }
  return d.messages[0].id;
}

async function sendAlert(link, title, message, now) {
  const settings = (await appData(SETTINGS_KEY)) || {};
  const tpl = (settings.templates || {})[TEMPLATE] || {};
  if (tpl.on !== true) return { sent: 0, skipped: "estate_alert is switched off in Settings → WhatsApp → Messages" };
  if (!link.alertTo.length) return { sent: 0, skipped: "no numbers on the Home Assistant link" };
  if (!process.env.WHATSAPP_TOKEN) return { sent: 0, error: "WHATSAPP_TOKEN is not set" };

  const ref = F.alertRef(title, now);
  const mark = await rest("wa_sent_marks?on_conflict=kind,ref", {
    method: "POST", headers: { "Prefer": "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify([{ kind: "ha", ref: ref }])
  });
  if (!mark || !mark.length) return { sent: 0, skipped: "the same alert already went this hour" };

  const submitted = ((await appData(SUBMITTED_KEY)) || {})[TEMPLATE] || null;
  const order = T.sendOrder(TEMPLATE, submitted);
  const values = { title: title, message: message };
  const body = T.render(submitted && submitted.body ? submitted.body : T.TEMPLATES[TEMPLATE].body, values);
  const out = { sent: 0, via: null, failed: [] };
  let firstId = null;
  for (const to of link.alertTo) {
    let id = null, via = "template";
    try {
      id = await graphSend({ to: to, type: "template", template: {
        name: TEMPLATE, language: { code: T.TEMPLATES[TEMPLATE].language },
        components: [{ type: "body", parameters: order.map(function (k) { return { type: "text", text: T.cleanParam(values[k], 900) }; }) }] } });
    } catch (e) {
      // Not approved yet (132000/132001): plain text, delivered only inside
      // the 24-hour window. Anything else is a real failure.
      if (e.code === 132001 || e.code === 132000 || /13200[01]/.test(e.message)) {
        try { id = await graphSend({ to: to, type: "text", text: { body: body.slice(0, 4000) } }); via = "text"; }
        catch (e2) { out.failed.push(e2.message); continue; }
      } else { out.failed.push(e.message); continue; }
    }
    out.sent++; out.via = via; firstId = firstId || id;
    await rest("wa_messages", { method: "POST", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({
      id: id, direction: "out", number: to, to_name: "Home Assistant alert", template: via === "template" ? TEMPLATE : null,
      msg_type: via, body: body.slice(0, 4000), at: now.toISOString(), status: "accepted",
      record_kind: "ha", record_id: ref, record_name: String(title).slice(0, 200) }) }).catch(function () {});
  }
  if (!out.sent) {
    await rest("wa_sent_marks?kind=eq.ha&ref=eq." + encodeURIComponent(ref), { method: "DELETE", headers: { "Prefer": "return=minimal" } }).catch(function () {});
  } else {
    await rest("wa_sent_marks?kind=eq.ha&ref=eq." + encodeURIComponent(ref), {
      method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ wa_id: firstId }) }).catch(function () {});
  }
  if (out.via === "text") out.note = "Sent as plain text (template not approved yet): WhatsApp delivers it only within 24 hours of you messaging the 01825 number.";
  return out;
}

async function today(now) {
  const until = new Date(now.getTime() + (F.AHEAD_DAYS + 1) * 86400000).toISOString();
  const [accom, properties, events, boxEvents] = await Promise.all([
    appData("hbf_accom_v1"), appData("hbf_properties_v1"), appData("hawthbush_bookings_v6"),
    rest("box_events?status=neq.draft&starts_at=gte." + encodeURIComponent(new Date(now.getTime() - 86400000).toISOString()) +
      "&starts_at=lte." + encodeURIComponent(until) + "&select=id,name,status,starts_at")
  ]);
  // A failed or empty read is an error, never "nobody is coming" — Home
  // Assistant would otherwise stand the heating down for real guests.
  if (!Array.isArray(accom) || !Array.isArray(properties) || !properties.length || !Array.isArray(events)) {
    throw new Error("bookings could not be read");
  }
  return F.feed({ now: now, accom: accom, properties: properties, events: events, boxEvents: boxEvents || [] });
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  let link;
  try { link = await linkFor(event); } catch (e) { return json(500, { error: "Could not check the token" }); }
  if (!link) return json(401, { error: "Not allowed" });
  let req;
  try { req = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Bad request" }); }
  const now = new Date();
  try {
    if (req.action === "today") return json(200, Object.assign({ ok: true }, await today(now)));
    if (req.action === "alert") {
      const title = T.cleanParam(req.title, 120), message = T.cleanParam(req.message, 900);
      if (title === "—") return json(400, { error: "An alert needs a title" });
      return json(200, Object.assign({ ok: true }, await sendAlert(link, title, message, now)));
    }
    return json(400, { error: "Unknown action" });
  } catch (e) {
    console.error("[ha-link] " + (e && e.message ? e.message : e));
    return json(500, { ok: false, error: String(e && e.message ? e.message : e) });
  }
};

exports._test = { linkFor, sendAlert, today };
