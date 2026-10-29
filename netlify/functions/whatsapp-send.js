// netlify/functions/whatsapp-send.js
// Sends WhatsApp messages from the 01825 number through Meta's Cloud API.
// Admin only: the caller's Supabase session must belong to an active admin.
//
// Actions (POST JSON):
//   { action: "status" }          — is the token set? (never returns it)
//   { action: "test", to }        — Meta's ready-approved "hello_world"
//                                   template to one number, to prove the chain.
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

  if (req.action === "status") return json(200, { configured: !!WA_TOKEN, phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID });

  if (req.action === "test") {
    if (!WA_TOKEN) return json(500, { error: "WHATSAPP_TOKEN is not set in Netlify (and the site redeployed)." });
    const to = normaliseNumber(req.to);
    if (!to) return json(400, { error: "That doesn't look like a phone number." });
    try {
      const id = await sendTemplate(to, "hello_world", "en_US");
      const kept = await recordOut({ id: id, direction: "out", number: to, msg_type: "template",
        body: "hello_world (test, sent by " + me.who + ")", at: new Date().toISOString(), status: "accepted" });
      return json(200, { ok: true, id: id, to: to, recorded: kept });
    } catch (e) {
      return json(502, { error: e.message });
    }
  }

  return json(400, { error: "Unknown action" });
};
