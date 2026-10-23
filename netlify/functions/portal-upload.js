// netlify/functions/portal-upload.js
//
// Photos and films a client sends us through the portal (a wake's slideshow
// pictures, a film for the screen), and staff or the client opening and
// removing them again.
//
// THE SHAPE — the same two identities as portal-file.js, for the same reason:
//
//   1. Every permission question is asked AS THE USER, with their own JWT, so
//      wp_my_event_id() resolves to their event and no other (staff get any).
//      The database decides the storage path itself — <event_id>/<uuid>.<ext> —
//      so a client never names a path or a bucket.
//   2. Only then is the service key used, for exactly that one path.
//
// The file itself never comes through here: Netlify functions take 6MB and a
// film is hundreds. "start" hands back a one-use signed UPLOAD token and the
// browser sends the file straight to storage. "finish" then checks the object
// really exists before the row is marked ready — a row means a file.
//
// Actions: start {name, size, type} · finish {id} · view {id} · delete {id}
//
// Required env vars: SUPABASE_SERVICE_KEY

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const BUCKET       = "portal-uploads";
const VIEW_SECONDS = 900;   // long enough to watch a film through, short enough to be useless if shared

function ok(data)  { return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }; }
function bad(m, c, extra) {
  return { statusCode: c || 400, headers: { "Content-Type": "application/json" },
           body: JSON.stringify(Object.assign({ error: m }, extra || {})) };
}
function encPath(p) { return String(p).split("/").map(encodeURIComponent).join("/"); }

// A database function, called either as the person (their JWT) or as the
// service. Throws on anything but a 2xx — an unchecked response is never a yes.
async function rpc(fn, args, bearer) {
  var res = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + fn, {
    method: "POST",
    headers: { "apikey": SERVICE_KEY, "Authorization": "Bearer " + bearer, "Content-Type": "application/json" },
    body: JSON.stringify(args || {})
  });
  var text = await res.text();
  if (!res.ok) { var e = new Error(fn + " " + res.status); e.status = res.status; throw e; }
  try { return text ? JSON.parse(text) : null; } catch (x) { return null; }
}

function storage(path, method, body) {
  var h = { "apikey": SERVICE_KEY, "Authorization": "Bearer " + SERVICE_KEY };
  if (body !== undefined) h["Content-Type"] = "application/json";
  return fetch(SUPABASE_URL + "/storage/v1" + path, {
    method: method, headers: h, body: body === undefined ? undefined : JSON.stringify(body)
  });
}

var CLIENT_ERRORS = {
  not_available: "Sending photos and films isn't open for this booking.",
  bad_type: "Only photos (JPEG, PNG, HEIC, WebP) and films (MP4, MOV, WebM) can be sent.",
  too_big: "That file is too large.",
  too_many: "That's the most files one booking can hold — talk to us.",
  not_found: "That file isn't yours to open.",
  not_ready: "That file hasn't finished sending."
};

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") return bad("Method not allowed", 405);
  if (!SERVICE_KEY) return bad("Not configured — SUPABASE_SERVICE_KEY is missing", 500);

  var auth = event.headers["authorization"] || event.headers["Authorization"] || "";
  var jwt = auth.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return bad("Please sign in.", 401);

  var body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return bad("Invalid JSON"); }
  var action = body.action;

  try {
    // ── start: reserve a path, then sign an upload for exactly that path ──────
    if (action === "start") {
      var slot = await rpc("wp_upload_slot", {
        p_name: String(body.name || "").slice(0, 200),
        p_size: Number(body.size) || 0,
        p_mime: String(body.type || "")
      }, jwt);
      if (!slot || slot.ok !== true) {
        var code = (slot && slot.error) || "refused";
        return bad(CLIENT_ERRORS[code] || "We couldn't take that file.", 400, { code: code, max_mb: slot && slot.max_mb });
      }
      var s = await storage("/object/upload/sign/" + BUCKET + "/" + encPath(slot.path), "POST", {});
      var st = await s.text();
      if (!s.ok) {
        console.warn("upload sign failed", s.status, st.slice(0, 200));
        // Leave nothing half-made behind.
        await rpc("wp_upload_forget", { p_id: slot.id }, SERVICE_KEY).catch(function(){});
        return bad("We couldn't start that upload just now.", 502);
      }
      var signed = JSON.parse(st);
      var token = new URL(SUPABASE_URL + "/storage/v1" + signed.url).searchParams.get("token");
      if (!token) return bad("We couldn't start that upload just now.", 502);
      return ok({ id: slot.id, path: slot.path, bucket: BUCKET, token: token });
    }

    // Everything else is about one existing upload, checked as the person.
    var id = String(body.id || "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return bad("No file named.");
    var who = await rpc("wp_upload_path", { p_id: id, p_for: action === "view" ? "view" : "delete" }, jwt);
    if (!who || who.ok !== true) {
      var c2 = (who && who.error) || "not_found";
      return bad(CLIENT_ERRORS[c2] || "That file isn't yours to open.", c2 === "not_found" ? 403 : 400, { code: c2 });
    }

    // ── finish: the file must really be there before the row counts ─────────
    if (action === "finish") {
      var head = await storage("/object/authenticated/" + BUCKET + "/" + encPath(who.path), "HEAD");
      if (!head.ok) return bad("That file didn't arrive — please try sending it again.", 409);
      var size = Number(head.headers.get("content-length")) || null;
      var done = await rpc("wp_upload_confirm", { p_id: id, p_size: size }, SERVICE_KEY);
      if (!done || done.ok !== true) return bad("Sent, but we couldn't file it. Please tell us.", 500);
      return ok({ ok: true });
    }

    // ── view: a short-lived link to that one file ───────────────────────────
    if (action === "view") {
      var v = await storage("/object/sign/" + BUCKET + "/" + encPath(who.path), "POST", { expiresIn: VIEW_SECONDS });
      var vt = await v.text();
      if (!v.ok) return bad("We couldn't open that just now.", 502);
      return ok({ url: SUPABASE_URL + "/storage/v1" + JSON.parse(vt).signedURL, expires_in: VIEW_SECONDS });
    }

    // ── delete: the file first, then the row (a row without a file would
    //    show as something that cannot be opened) ──────────────────────────
    if (action === "delete") {
      var d = await storage("/object/" + BUCKET + "/" + encPath(who.path), "DELETE");
      if (!d.ok) {
        // Already gone (an abandoned upload) is fine; any other refusal is not.
        var dt = await d.text();
        if (!(d.status === 404 || /not.?found/i.test(dt))) return bad("We couldn't remove that just now.", 502);
      }
      await rpc("wp_upload_forget", { p_id: id }, SERVICE_KEY);
      return ok({ ok: true });
    }

    return bad("Unknown action");
  } catch (e) {
    if (e && e.status === 401) return bad("Please sign in again.", 401);
    console.error("portal-upload", action, e && e.message);
    return bad("Something went wrong — please try again.", 502);
  }
};
