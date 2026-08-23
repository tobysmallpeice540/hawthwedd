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

        // SignWell answers { templates: [...], total_count, ... }. Both other
        // shapes are kept as fallbacks rather than replaced, so a future
        // change to their response doesn't empty this silently.
        var items = (list.body && list.body.templates)
                 || (Array.isArray(list.body) ? list.body : null)
                 || (list.body && list.body.data)
                 || [];

        // The list does not carry the fields — those come from fetching each
        // template. Rate limit is 5 requests per 30 seconds, so this is capped
        // and sequential rather than fired off in parallel.
        var details = [];
        for (var d = 0; d < Math.min(items.length, 4); d++) {
          var one = await signwell("/document_templates/" + items[d].id + "/");
          details.push({ id: items[d].id, ok: one.ok, status: one.status, body: one.body || one.text });
        }
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

        // Fields live on the detail, so read them from there when we have it.
        summary.forEach(function(t) {
          var det = details.find(function(x) { return x.id === t.id; });
          var b = det && det.body;
          if (!b || typeof b !== "object") return;
          ["fields", "template_fields", "placeholders"].forEach(function(k) {
            var arr = b[k];
            if (!Array.isArray(arr)) return;
            // fields can be an array of arrays, one per page
            var flat = arr.every(function(x) { return Array.isArray(x); }) ? [].concat.apply([], arr) : arr;
            flat.forEach(function(f) {
              if (!f || typeof f !== "object") return;
              t.fields.push({ api_id: f.api_id || f.name || f.id, type: f.type, required: f.required });
            });
          });
          if (Array.isArray(b.recipients) && !t.recipients.length) {
            t.recipients = b.recipients.map(function(r) { return { id: r.id, name: r.name, email: r.email }; });
          }
        });

        return ok({ count: items.length, templates: summary, raw: details.length ? details : items });
      }

      // Send the contract. The field values arrive from the Contract tab, where
      // they were prefilled and then whatever the office changed. Nothing is
      // computed here — this posts what a person approved on screen.
      case "create": {
        if (!body.templateId) return bad("No template chosen.");
        var recips = (body.recipients || []).filter(function(r) { return r && r.email; });
        if (!recips.length) return bad("A contract needs at least one recipient.");

        var payload = {
          test_mode: !!body.testMode,
          template_id: body.templateId,
          // draft leaves it in SignWell unsent, for a look before it goes.
          draft: !!body.draft,
          subject: body.subject || undefined,
          message: body.message || undefined,
          recipients: recips.map(function(r, i) {
            return {
              id: String(i + 1),
              placeholder_name: r.placeholder_name,
              name: r.name || "",
              email: r.email
            };
          }),
          // Only fields with something in them. Sending an empty value would
          // overwrite whatever default the template carries.
          template_fields: (body.fields || [])
            .filter(function(f) { return f && f.api_id && f.value !== "" && f.value != null; })
            .map(function(f) { return { api_id: f.api_id, value: f.value }; })
        };

        var made = await signwell("/document_templates/documents/", { method: "POST", body: payload });
        if (!made.ok) return bad("SignWell refused the document: " + made.status + " " + made.text, 502);
        return ok({ document: made.body });
      }

      // Where a sent contract has got to, and — once signed — what the clients
      // put in their own fields.
      // Recent documents, whether or not the app created them. A contract sent
      // straight from SignWell has no id stored against any event, so without
      // this there is no way to look at what came back.
      case "documents": {
        var ds = await signwell("/documents/");
        if (!ds.ok) return bad("Could not list documents: " + ds.status + " " + ds.text, 502);
        var arr = ds.body && (ds.body.documents || ds.body.data || ds.body);
        if (!Array.isArray(arr)) arr = [];
        return ok({
          documents: arr.slice(0, 40).map(function(d) {
            return {
              id: d.id, name: d.name, status: d.status,
              created: d.created_at || d.created,
              recipients: (d.recipients || []).map(function(r) {
                return { name: r.name, email: r.email, status: r.status };
              })
            };
          })
        });
      }

      case "document": {
        if (!body.documentId) return bad("No document id.");
        var doc = await signwell("/documents/" + body.documentId + "/");
        if (!doc.ok) return bad("Could not read that document: " + doc.status + " " + doc.text, 502);

        // Field values come back nested per page, same as the template.
        var flat = [];
        var raw = (doc.body && doc.body.fields) || [];
        (Array.isArray(raw) ? raw : []).forEach(function(pageOrField) {
          if (Array.isArray(pageOrField)) pageOrField.forEach(function(f) { flat.push(f); });
          else flat.push(pageOrField);
        });
        var values = {};
        flat.forEach(function(f) { if (f && f.api_id) values[f.api_id] = f.value; });

        return ok({
          id: doc.body && doc.body.id,
          status: doc.body && doc.body.status,
          name: doc.body && doc.body.name,
          recipients: (doc.body && doc.body.recipients) || [],
          values: values,
          raw: doc.body
        });
      }

      // The template is visibly there in the SignWell UI but did not come back
      // from the endpoint I guessed. Rather than guess again, ask SignWell
      // several plausible questions and report exactly what it says to each.
      case "probe": {
        var paths = [
          "/document_templates/",
          "/document_templates",
          "/document_templates/?page=1",
          "/document_templates/?archived=false",
          "/templates/",
          "/documents/?type=template",
          "/documents/",
          "/me"
        ];
        var out = [];
        for (var i = 0; i < paths.length; i++) {
          var r = await signwell(paths[i]);
          var shape = "—";
          if (r.body) {
            if (Array.isArray(r.body)) shape = "array(" + r.body.length + ")";
            else shape = "object{" + Object.keys(r.body).slice(0, 8).join(",") + "}";
          }
          out.push({
            path: paths[i],
            status: r.status,
            shape: shape,
            // First 400 characters is enough to recognise the answer without
            // dragging a whole contract through the response.
            sample: (r.text || "").slice(0, 400)
          });
        }
        return ok({ probes: out });
      }

      default:
        return bad("Unknown action: " + body.action);
    }
  } catch (err) {
    console.error("signwell error:", body.action, err && err.message ? err.message : err);
    return bad(String(err.message || err), 500);
  }
};
