// netlify/functions/whatsapp-send.js
// Sends WhatsApp messages from the 01825 number through Meta's Cloud API.
// Admin only: the caller's Supabase session must belong to an active admin.
//
// Actions (POST JSON):
//   { action: "status" }   — is the token set (never returns it); which number
//                            we send from and its name review; the templates
//                            the WhatsApp account holds and their approval.
//   { action: "test", to, template, language }
//                          — one approved template with no variables.
//   { action: "test", to, text: true }
//                          — a plain text message. WhatsApp only delivers it
//                            within 24 hours of that person messaging the
//                            01825 number (the customer service window).
//
// Meta's sample "hello_world" is NOT on every new account (30 Oct 2026: error
// 132001 "Template name does not exist in the translation"), so the test no
// longer assumes it.
//
//   { action: "subscribe" } — link the WhatsApp account to this app so Meta
//                            passes incoming messages to whatsapp-webhook. A
//                            verified callback URL is NOT enough on its own.
//   { action: "submit", name, body }
//                          — send a template's wording (named merge fields)
//                            to Meta for review: a new template is created, an
//                            existing one is edited (Meta reviews it again and
//                            allows about one edit a day). What was submitted,
//                            and its field order, is kept in app_data
//                            hbf_whatsapp_submitted_v1 — the order messages
//                            are filled in until Meta has a newer version.
//   { action: "log", number? }
//                          — the WhatsApps sent (and received), newest first,
//                            and who they went to, for the Sent list.
//
// The templates themselves live in whatsapp-reminders/templates.js, shared
// with the sender. Every message sent is kept in wa_messages (direction
// "out"); the webhook moves its status on as receipts arrive.
//
// Env: WHATSAPP_TOKEN (permanent system-user token — secret), SUPABASE_SERVICE_KEY.
// The phone number id and account id are not secret and live here.
const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WA_TOKEN = process.env.WHATSAPP_TOKEN || "";
const GRAPH = "https://graph.facebook.com/v23.0";
const PHONE_NUMBER_ID = "1454490917738977";   // the 01825 number
const WABA_ID = "970274439005564";            // Hawthbush Farm WhatsApp account (templates)

const T = require("./whatsapp-reminders/templates.js");
const SUBMITTED_KEY = "hbf_whatsapp_submitted_v1";

const json = (status, obj) => ({ statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

// Copied from handle-viewing.js, like every helper in this folder.
async function resolveStaff(event, roles) {
  var h = (event && event.headers) || {};
  var jwt = String(h["authorization"] || h["Authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt || !SUPABASE_KEY) return null;
  try {
    var res = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + jwt }
    });
    if (!res.ok) return null;
    var user = await res.json();
    if (!user || !user.id) return null;
    var pr = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + encodeURIComponent(user.id) + "&select=role,active,name,email", {
      headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY }
    });
    if (!pr.ok) return null;
    var rows = await pr.json();
    var p = Array.isArray(rows) ? rows[0] : null;
    if (!p || p.active === false || roles.indexOf(p.role) === -1) return null;
    return { id: user.id, role: p.role, who: p.name || p.email || user.email || "" };
  } catch (e) {
    console.error("resolveStaff failed:", e.message);
    return null;
  }
}

// Same rule as the webhook: UK numbers become 44…, under 10 digits is no number.
function normaliseNumber(s) {
  let d = String(s || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = "44" + d.slice(1);
  else if (d.length === 10 && d.startsWith("7")) d = "44" + d;
  return d.length >= 10 ? d : "";
}

async function sendTemplate(to, name, lang, components) {
  const res = await fetch(GRAPH + "/" + PHONE_NUMBER_ID + "/messages", {
    method: "POST",
    headers: { "Authorization": "Bearer " + WA_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", to: to, type: "template",
      template: Object.assign({ name: name, language: { code: lang } }, components ? { components: components } : {})
    })
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok || !data || !data.messages || !data.messages[0]) {
    const err = data && data.error ? (data.error.error_user_msg || data.error.message || "") : "";
    throw new Error("WhatsApp refused it (" + res.status + ")" + (err ? ": " + err : ""));
  }
  return data.messages[0].id;
}

async function graphGet(path) {
  const res = await fetch(GRAPH + path, { headers: { "Authorization": "Bearer " + WA_TOKEN } });
  let data = null;
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) {
    const err = data && data.error ? (data.error.error_user_msg || data.error.message || "") : "";
    throw new Error("Meta said " + res.status + (err ? ": " + err : ""));
  }
  return data || {};
}

// A template needs values filled in if any of its parts carries {{1}}, or it
// has a header picture/video/document (which must be supplied each send).
function needsValues(t) {
  return (t.components || []).some(function (c) {
    if (c.type === "HEADER" && c.format && c.format !== "TEXT") return true;
    if (/\{\{\s*\w+\s*\}\}/.test(c.text || "")) return true;
    return (c.buttons || []).some(function (b) { return /\{\{/.test(b.url || ""); });
  });
}

async function sendText(to, body) {
  const res = await fetch(GRAPH + "/" + PHONE_NUMBER_ID + "/messages", {
    method: "POST",
    headers: { "Authorization": "Bearer " + WA_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: to, type: "text", text: { body: body } })
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok || !data || !data.messages || !data.messages[0]) {
    const err = data && data.error ? (data.error.error_user_msg || data.error.message || "") : "";
    throw new Error("WhatsApp refused it (" + res.status + ")" + (err ? ": " + err : ""));
  }
  return data.messages[0].id;
}

async function recordOut(row) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/wa_messages", {
    method: "POST",
    headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json", "Prefer": "return=minimal" },
    body: JSON.stringify(row)
  });
  // The message has gone either way; a failed record is reported, not thrown.
  return res.ok;
}

async function appData(key) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/app_data?key=eq." + encodeURIComponent(key) + "&select=value",
    { headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY } });
  if (!r.ok) throw new Error("read " + key + " " + r.status);
  const rows = await r.json();
  return rows[0] ? rows[0].value : null;
}
async function putAppData(key, value) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/app_data?on_conflict=key", {
    method: "POST",
    headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY, "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ key: key, value: value, updated_at: new Date().toISOString() }])
  });
  if (!r.ok) throw new Error("write " + key + " " + r.status);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  const me = await resolveStaff(event, ["admin"]);
  if (!me) return json(401, { error: "Admins only" });

  let req;
  try { req = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Bad request" }); }

  if (req.action === "status") {
    const out = { configured: !!WA_TOKEN, phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID };
    if (!WA_TOKEN) return json(200, out);
    // Each look-up is reported on its own: one failing must not hide the others.
    try {
      const n = await graphGet("/" + PHONE_NUMBER_ID + "?fields=display_phone_number,verified_name,name_status,quality_rating");
      out.number = { display: n.display_phone_number || "", name: n.verified_name || "", nameStatus: n.name_status || "", quality: n.quality_rating || "" };
    } catch (e) { out.numberError = e.message; }
    try {
      const p = await graphGet("/" + WABA_ID + "/phone_numbers?fields=id,display_phone_number");
      out.numberOnAccount = (p.data || []).some(function (x) { return String(x.id) === PHONE_NUMBER_ID; });
      out.accountNumbers = (p.data || []).map(function (x) { return { id: String(x.id), display: x.display_phone_number || "" }; });
    } catch (e) { out.accountError = e.message; }
    try {
      const a = await graphGet("/" + WABA_ID + "/subscribed_apps");
      out.linkedApps = (a.data || []).map(function (x) {
        const d = x.whatsapp_business_api_data || {};
        return d.name || d.id || "an app";
      });
    } catch (e) { out.linkedAppsError = e.message; }
    try {
      const t = await graphGet("/" + WABA_ID + "/message_templates?fields=id,name,language,status,category,components,rejected_reason&limit=100");
      out.templates = (t.data || []).map(function (x) {
        return { id: x.id, name: x.name, language: x.language, status: x.status, category: x.category,
          rejectedReason: x.rejected_reason && x.rejected_reason !== "NONE" ? x.rejected_reason : "", needsValues: needsValues(x) };
      });
    } catch (e) { out.templatesError = e.message; }
    let submitted = {};
    try { submitted = (await appData(SUBMITTED_KEY)) || {}; } catch (e) { out.submittedError = e.message; }
    out.catalogue = Object.keys(T.TEMPLATES).map(function (k) {
      const def = T.TEMPLATES[k];
      const on = (out.templates || []).filter(function (t) { return t.name === k; })[0];
      const sub = submitted[k] || null;
      return { name: k, label: def.label, audience: def.audience, when: def.when, language: def.language,
        fields: def.fields, defaultBody: def.body, footer: T.FOOTER, button: def.button ? def.button.text : "",
        status: on ? on.status : (out.templatesError ? "unknown" : "not submitted"),
        rejectedReason: on ? on.rejectedReason : "",
        submitted: sub ? { body: sub.body, at: sub.at, by: sub.by } : null };
    });
    // Who would get reminders: active office logins and whether each has a mobile.
    try {
      const r = await fetch(SUPABASE_URL + "/rest/v1/profiles?role=eq.admin&active=eq.true&select=id,name,email,mobile&order=name.asc",
        { headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY } });
      if (!r.ok) throw new Error("profiles " + r.status);
      out.staff = (await r.json()).map(function (p) { return { name: p.name || p.email, hasMobile: !!p.mobile }; });
    } catch (e) { out.staffError = e.message; }
    return json(200, out);
  }

  if (req.action === "test") {
    if (!WA_TOKEN) return json(500, { error: "WHATSAPP_TOKEN is not set in Netlify (and the site redeployed)." });
    const to = normaliseNumber(req.to);
    if (!to) return json(400, { error: "That doesn't look like a phone number." });
    try {
      let id, body, type;
      if (req.text) {
        body = "Test message from Hawthbush Farm, sent from the app by " + (me.who || "the office") + ". Replies go to our email, read in office hours.";
        id = await sendText(to, body); type = "text";
      } else {
        const name = String(req.template || "").trim();
        const lang = String(req.language || "").trim();
        if (!/^[a-z0-9_]{1,512}$/.test(name) || !/^[A-Za-z_]{2,10}$/.test(lang)) return json(400, { error: "Choose a template to test with." });
        id = await sendTemplate(to, name, lang);
        body = name + " (test, sent by " + me.who + ")"; type = "template";
      }
      const kept = await recordOut({ id: id, direction: "out", number: to, msg_type: type,
        body: body, at: new Date().toISOString(), status: "accepted" });
      return json(200, { ok: true, id: id, to: to, recorded: kept });
    } catch (e) {
      // 131047: more than 24 hours since they last messaged us — text needs a template.
      const hint = /131047|24 hours|re-engagement/i.test(e.message)
        ? " A plain message only goes to someone who has messaged the 01825 number in the last 24 hours — send it a WhatsApp from that phone first."
        : "";
      return json(502, { error: e.message + hint });
    }
  }

  if (req.action === "subscribe") {
    if (!WA_TOKEN) return json(500, { error: "WHATSAPP_TOKEN is not set in Netlify." });
    const res = await fetch(GRAPH + "/" + WABA_ID + "/subscribed_apps", { method: "POST", headers: { "Authorization": "Bearer " + WA_TOKEN } });
    const d = await res.json().catch(function () { return {}; });
    if (!res.ok || !d.success) return json(502, { error: "Meta said " + res.status + (d.error ? ": " + (d.error.error_user_msg || d.error.message) : "") });
    return json(200, { ok: true });
  }

  if (req.action === "submit") {
    if (!WA_TOKEN) return json(500, { error: "WHATSAPP_TOKEN is not set in Netlify." });
    const name = String(req.name || "");
    const def = T.TEMPLATES[name];
    if (!def) return json(400, { error: "Unknown template." });
    const body = String(req.body || def.body);
    let built;
    try { built = T.components(name, body); } catch (e) { return json(400, { error: e.message }); }
    // Is it on Meta already? Then this is an edit of that template.
    let existing = null;
    try {
      const t = await graphGet("/" + WABA_ID + "/message_templates?name=" + encodeURIComponent(name) + "&fields=id,name,status,language");
      existing = (t.data || []).filter(function (x) { return x.name === name && x.language === def.language; })[0] || null;
    } catch (e) { return json(502, { error: e.message }); }
    if (existing && existing.status === "PENDING") return json(409, { error: "Meta is still reviewing the last version — wait for its answer before changing it." });
    const url = existing ? GRAPH + "/" + existing.id : GRAPH + "/" + WABA_ID + "/message_templates";
    const payload = existing ? { category: def.category, components: built.components }
      : { name: name, language: def.language, category: def.category, components: built.components };
    const res = await fetch(url, { method: "POST", headers: { "Authorization": "Bearer " + WA_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const d = await res.json().catch(function () { return {}; });
    if (!res.ok) return json(502, { error: "Meta said " + res.status + (d.error ? ": " + (d.error.error_user_msg || d.error.message) : "") });
    // Record what Meta now has, so messages are filled in its order. Re-read
    // first: only this template's entry changes.
    try {
      const all = (await appData(SUBMITTED_KEY)) || {};
      all[name] = { body: body, order: built.order, at: new Date().toISOString(), by: me.who || "" };
      await putAppData(SUBMITTED_KEY, all);
    } catch (e) {
      return json(500, { error: "Meta has it, but the app could not record what was submitted (" + e.message + "). Submit it once more tomorrow." });
    }
    return json(200, { ok: true, edited: !!existing, status: d.status || "PENDING" });
  }

  if (req.action === "log") {
    const num = normaliseNumber(req.number);
    const q = "wa_messages?select=id,direction,number,to_name,template,msg_type,body,at,status,record_kind,record_name,media" +
      (num ? "&number=eq." + num : "") + "&order=at.desc&limit=300";
    const r = await fetch(SUPABASE_URL + "/rest/v1/" + q, { headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY } });
    if (!r.ok) return json(500, { error: "Could not read the log (" + r.status + ")" });
    const rows = await r.json();
    // Everyone ever messaged, for the filter: number → the best name we have.
    const pr = await fetch(SUPABASE_URL + "/rest/v1/wa_messages?select=number,to_name,record_name,direction&order=at.desc&limit=2000",
      { headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY } });
    const people = {};
    if (pr.ok) (await pr.json()).forEach(function (x) {
      const p = people[x.number] = people[x.number] || { number: x.number, name: "", count: 0 };
      p.count++;
      if (!p.name) p.name = x.to_name || (x.direction === "in" ? x.record_name : "") || "";
    });
    return json(200, { ok: true, messages: rows, people: Object.values(people).sort(function (a, b) { return (a.name || "~").localeCompare(b.name || "~"); }) });
  }

  return json(400, { error: "Unknown action" });
};
