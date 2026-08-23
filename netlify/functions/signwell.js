// netlify/functions/signwell.js
// Contracts, through SignWell.
//
// Admin only, and the API key never leaves the server — the same shape as
// box-admin.js and user-admin.js. A verified Supabase session, with the role
// read from the profiles table rather than from anything the browser sent.
//
// This first version is deliberately read-only: it lists the templates in the
// account and reports exactly what fields each one expects. Prepopulating a
// contract means writing to those field names, and they have to be discovered
// rather than assumed — a template field that is silently mis-named produces a
// contract that looks right and says the wrong thing.
//
// Required env vars: SUPABASE_SERVICE_KEY · SIGNWELL_API_KEY

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const SIGNWELL_KEY = process.env.SIGNWELL_API_KEY;
const SIGNWELL_API = "https://www.signwell.com/api/v1";

async function sbRest(path) {
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    headers: { "apikey": SERVICE_KEY, "Authorization": "Bearer " + SERVICE_KEY }
  });
  var text = await res.text();
  if (!res.ok) throw new Error("supabase " + res.status + ": " + text);
  try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
}

function ok(d)      { return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) }; }
function bad(m, c)  { return { statusCode: c || 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: m }) }; }

async function resolveAdmin(event) {
  var auth = event.headers["authorization"] || event.headers["Authorization"] || "";
  var jwt = auth.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return null;
  var res = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: { "apikey": SERVICE_KEY, "Authorization": "Bearer " + jwt }
  });
  if (!res.ok) return null;
  var user = await res.json();
  if (!user || !user.id) return null;
  var rows = await sbRest("profiles?id=eq." + user.id + "&select=role,active,name,email");
  var p = rows && rows[0];
  if (!p || p.active === false || p.role !== "admin") return null;
  return { id: user.id, who: p.name || p.email };
}

async function signwell(path, opts) {
  var o = opts || {};
  var res = await fetch(SIGNWELL_API + path, {
    method: o.method || "GET",
    headers: { "X-Api-Key": SIGNWELL_KEY, "Content-Type": "application/json", "Accept": "application/json" },
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  var text = await res.text();
  var json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) {}
  return { ok: res.ok, status: res.status, body: json, text: text };
}

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") return bad("Method not allowed", 405);
  if (!SIGNWELL_KEY) return bad("SIGNWELL_API_KEY is not set in Netlify.", 500);
  if (!SERVICE_KEY)  return bad("SUPABASE_SERVICE_KEY is not set.", 500);

  var body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return bad("Invalid JSON"); }

  var me = await resolveAdmin(event);
  if (!me) return bad("Only an administrator can work with contracts.", 403);

  try {
    switch (body.action) {

      // Does the key work, and what is in the account?
      case "ping": {
        var r = await signwell("/me");
        if (!r.ok) return bad("SignWell refused the key: " + r.status + " " + r.text, 502);
        return ok({ connected: true, account: r.body });
      }

      // The templates, and — the point of this — the field names each expects.
      // Returned raw as well as summarised, because the summary is my reading
      // of their shape and the raw is the truth.
      case "templates": {
        var list = await signwell("/document_templates/");
        if (!list.ok) return bad("Could not list templates: " + list.status + " " + list.text, 502);

        var items = Array.isArray(list.body) ? list.body : (list.body && list.body.data) || [];
        var summary = items.map(function(t) {
          var fields = [];
          // SignWell has moved this around between versions, so look in the
          // places it might be rather than insisting on one.
          ["fields", "template_fields", "placeholders"].forEach(function(k) {
            if (Array.isArray(t[k])) t[k].forEach(function(f) {
              fields.push({ api_id: f.api_id || f.name || f.id, type: f.type, required: f.required });
            });
          });
          var recipients = (t.placeholders || t.recipients || []).map(function(r) {
            return { id: r.id, name: r.name, email: r.email };
          });
          return { id: t.id, name: t.name, fields: fields, recipients: recipients };
        });

        return ok({ count: items.length, templates: summary, raw: items });
      }

      default:
        return bad("Unknown action: " + body.action);
    }
  } catch (err) {
    console.error("signwell error:", body.action, err && err.message ? err.message : err);
    return bad(String(err.message || err), 500);
  }
};
