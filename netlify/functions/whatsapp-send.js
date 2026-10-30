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
//   { action: "createTemplate", name }
//                          — submit one of TEMPLATES below to Meta for review.
//
// Templates for guests, couples and cleaners come next, once Meta has
// approved them. Every message sent is kept in wa_messages (direction "out");
// the webhook moves its status on as receipts arrive.
//
// Env: WHATSAPP_TOKEN (permanent system-user token — secret), SUPABASE_SERVICE_KEY.
// The phone number id and account id are not secret and live here.
const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WA_TOKEN = process.env.WHATSAPP_TOKEN || "";
const GRAPH = "https://graph.facebook.com/v23.0";
const PHONE_NUMBER_ID = "1454490917738977";   // the 01825 number
const WABA_ID = "970274439005564";            // Hawthbush Farm WhatsApp account (templates)

// The templates the app uses, exactly as they are submitted to Meta. Changing
// the wording of one Meta has approved means submitting it again under a new
// name — an approved template cannot be edited into something else here.
// Footer (Toby, 29 Oct): replies are read by email in office hours.
const FOOTER = "Replies go to our email, read in office hours";
const TEMPLATES = {
  checklist_reminder: {
    label: "Checklist reminder (staff)",
    language: "en_GB", category: "UTILITY",
    components: [
      { type: "BODY",
        text: "Hi {{1}}, a reminder from Hawthbush Farm: you have {{2}} on the {{3}} checklist, due by {{4}}: {{5}}. Please tick them off in the app.",
        example: { body_text: [["Rosanna", "2 items", "Arrival – Emma Juner letting", "3:00pm today", "Welcome hamper · Heating on"]] } },
      { type: "FOOTER", text: FOOTER },
      { type: "BUTTONS", buttons: [{ type: "URL", text: "Open the app", url: "https://hawthbushfarm.netlify.app/" }] }
    ]
  }
};

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
      const t = await graphGet("/" + WABA_ID + "/message_templates?fields=name,language,status,category,components&limit=100");
      out.templates = (t.data || []).map(function (x) {
        return { name: x.name, language: x.language, status: x.status, category: x.category, needsValues: needsValues(x) };
      });
    } catch (e) { out.templatesError = e.message; }
    out.catalogue = Object.keys(TEMPLATES).map(function (k) {
      const on = (out.templates || []).filter(function (t) { return t.name === k; })[0];
      return { name: k, label: TEMPLATES[k].label, language: TEMPLATES[k].language, status: on ? on.status : (out.templatesError ? "unknown" : "not submitted") };
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

  if (req.action === "createTemplate") {
    if (!WA_TOKEN) return json(500, { error: "WHATSAPP_TOKEN is not set in Netlify." });
    const def = TEMPLATES[String(req.name || "")];
    if (!def) return json(400, { error: "Unknown template." });
    const res = await fetch(GRAPH + "/" + WABA_ID + "/message_templates", {
      method: "POST",
      headers: { "Authorization": "Bearer " + WA_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ name: req.name, language: def.language, category: def.category, components: def.components })
    });
    const d = await res.json().catch(function () { return {}; });
    if (!res.ok) return json(502, { error: "Meta said " + res.status + (d.error ? ": " + (d.error.error_user_msg || d.error.message) : "") });
    return json(200, { ok: true, status: d.status || "PENDING", category: d.category || def.category });
  }

  return json(400, { error: "Unknown action" });
};
