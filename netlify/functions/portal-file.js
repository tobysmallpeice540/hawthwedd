// netlify/functions/portal-file.js
//
// Hands a wedding client a short-lived link to one of their own documents.
//
// The booking-files bucket is private, so nothing can be linked directly and
// the stored `url` on each file is useless to a client. This mints a signed URL
// instead — but only after the database has said yes.
//
// THE SHAPE THAT MATTERS. Two different identities are used, deliberately:
//
//   1. The permission question is asked AS THE USER. wp_may_read_file() is
//      called with the client's own JWT, so auth.uid() is theirs and
//      wp_my_event_id() resolves to their wedding and no other. The path is
//      checked against that event's files and against the docType allowlist.
//      Asking with the service key instead would make the check meaningless,
//      because every path would belong to "the service".
//
//   2. Only once that returns true is the service key used, and only to sign
//      the one path that was approved. The caller never names a bucket, and
//      nothing else in storage is reachable through here.
//
// So a client cannot fetch another couple's contract by pasting its path, and
// cannot fetch a timesheet or an untyped file on their own event either — both
// are asserted in supabase/portal-phase02b-form-documents-test.sql.
//
// Required env vars: SUPABASE_SERVICE_KEY

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const BUCKET       = "booking-files";
const LINK_SECONDS = 300;   // long enough to open, short enough to be useless if shared

function ok(data)  { return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }; }
function bad(m, c) { return { statusCode: c || 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: m }) }; }

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") return bad("Method not allowed", 405);
  if (!SERVICE_KEY) return bad("Not configured — SUPABASE_SERVICE_KEY is missing", 500);

  var auth = event.headers["authorization"] || event.headers["Authorization"] || "";
  var jwt = auth.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return bad("Please sign in.", 401);

  var body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return bad("Invalid JSON"); }

  var path = String(body.path || "").trim();
  if (!path) return bad("No document asked for.");

  // ── 1. Ask the database, as the user ──────────────────────────────────────
  var allowed;
  try {
    var check = await fetch(SUPABASE_URL + "/rest/v1/rpc/wp_may_read_file", {
      method: "POST",
      headers: {
        "apikey": SERVICE_KEY,               // identifies the project
        "Authorization": "Bearer " + jwt,    // identifies the PERSON — this is the point
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ p_path: path })
    });
    if (!check.ok) {
      // An expired or invented token lands here. Never treat an unchecked
      // response as a yes.
      return bad("Please sign in again.", 401);
    }
    allowed = await check.json();
  } catch (e) {
    return bad("Could not check that document.", 502);
  }

  if (allowed !== true) return bad("That document isn't yours to open.", 403);

  // ── 2. Only now, and only for that exact path ─────────────────────────────
  try {
    var sign = await fetch(
      SUPABASE_URL + "/storage/v1/object/sign/" + BUCKET + "/" + path.split("/").map(encodeURIComponent).join("/"),
      {
        method: "POST",
        headers: {
          "apikey": SERVICE_KEY,
          "Authorization": "Bearer " + SERVICE_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ expiresIn: LINK_SECONDS })
      }
    );
    var text = await sign.text();
    if (!sign.ok) {
      console.warn("storage sign failed", sign.status, text.slice(0, 200));
      return bad("We couldn't open that document just now.", 502);
    }
    var data = JSON.parse(text);
    // Supabase returns a project-relative signed path.
    var url = SUPABASE_URL + "/storage/v1" + data.signedURL;
    return ok({ url: url, expires_in: LINK_SECONDS });
  } catch (e) {
    return bad("We couldn't open that document just now.", 502);
  }
};
