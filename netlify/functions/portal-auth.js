// netlify/functions/portal-auth.js
//
// Sign-in links for the wedding client portal — minted here and sent through
// Resend, rather than left to Supabase's own mailer.
//
// WHY THIS EXISTS. wp_grant_access records who may sign in; it never sent
// anything, and no invite email had been built. So adding an email address in
// the admin screen did nothing visible at all, which is a poor way for a
// feature to behave and exactly how it was found. Supabase's built-in email
// would have been the other option, but it is unbranded, heavily rate-limited,
// and lands in spam often enough that a couple would simply never get in.
//
// Two actions:
//
//   invite       staff only. Creates the auth account if it does not exist,
//                mints a magic link and emails it. Use it right after giving
//                somebody access.
//
//   request-link public, and the one the portal's sign-in form calls. It sends
//                a link ONLY to an address that already has portal access, so
//                a stranger cannot create an account by typing an email — which
//                also closes the open-signup gap the first version of the
//                portal had. It answers identically either way, so it cannot be
//                used to discover which addresses are on the system, and the
//                database throttles it to one link a minute per address.
//
// Required env vars: SUPABASE_SERVICE_KEY, RESEND_API_KEY

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const SITE_ORIGIN  = "https://hawthbushfarm.netlify.app";
const PORTAL_URL   = SITE_ORIGIN + "/portal";
const FROM_EMAIL   = "hello@hawthbushfarm.co.uk";
const FROM_HEADER  = "Hawthbush Farm <" + FROM_EMAIL + ">";
const EMAIL_LOG_KEY = "hbf_email_log_v1";

function ok(d)     { return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) }; }
function bad(m, c) { return { statusCode: c || 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: m }) }; }

// ── Supabase helpers ────────────────────────────────────────────────────────

async function sbRest(path, opts) {
  var o = opts || {};
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    method: o.method || "GET",
    headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY,
               "Content-Type": "application/json", Prefer: o.prefer || "return=representation" },
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  var text = await res.text();
  if (!res.ok) throw new Error("supabase " + res.status + ": " + text);
  try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
}

async function sbRpc(fn, args) {
  return sbRest("rpc/" + fn, { method: "POST", body: args || {} });
}

async function sbAuthAdmin(path, opts) {
  var o = opts || {};
  var res = await fetch(SUPABASE_URL + "/auth/v1/admin" + path, {
    method: o.method || "GET",
    headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json" },
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  var text = await res.text();
  var json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) {}
  return { ok: res.ok, status: res.status, body: json, text: text };
}

// Only a signed-in member of staff, verified with Supabase rather than believed
// from the browser.
async function resolveStaff(event) {
  var auth = event.headers["authorization"] || event.headers["Authorization"] || "";
  var jwt = auth.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return null;
  var res = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + jwt }
  });
  if (!res.ok) return null;
  var user = await res.json();
  if (!user || !user.id) return null;
  var rows = await sbRest("profiles?id=eq." + user.id + "&select=role,active,name,email");
  var p = rows && rows[0];
  if (!p || p.active === false) return null;
  if (["admin", "bar", "cleaner"].indexOf(p.role) === -1) return null;
  return { id: user.id, who: p.name || p.email || "staff" };
}

// ── The link itself ─────────────────────────────────────────────────────────

// The account has to exist before a magic link can be minted for it, so this
// creates it if needed. email_confirm is set because we are the ones who
// decided this address is legitimate — they were added to a booking by hand.
async function ensureUser(email) {
  var created = await sbAuthAdmin("/users", {
    method: "POST",
    body: { email: email, email_confirm: true, user_metadata: { role: "client" } }
  });
  if (created.ok) return true;
  // 422 means it already exists, which is a perfectly good outcome.
  if (created.status === 422 || created.status === 409) return true;
  throw new Error("could not create the account: " + created.text.slice(0, 200));
}

// We build the link ourselves out of the token, rather than sending the
// action_link Supabase hands back.
//
// WHY, because it looks like the long way round. The action_link points at
// Supabase, which verifies the token and then REDIRECTS to whatever URL it is
// given — but only if that URL is on the project's redirect allowlist. If it is
// not, GoTrue silently falls back to the project's Site URL, and the first real
// invite ever sent landed on localhost, because that is what Site URL happened
// to be. The token was spent getting there, so the link could not be retried.
//
// A configuration setting in a dashboard that nobody looks at should not be
// able to break every sign-in link silently. So the link points at our own
// page, carrying the hashed token in the fragment, and the portal calls
// verifyOtp itself. No redirect, no allowlist, nothing to get wrong later.
//
// The fragment is deliberate: it is never sent to a server, unlike a query
// string, and it is what the portal strips out of the address bar on arrival.
async function mintLink(email) {
  var r = await sbAuthAdmin("/generate_link", {
    method: "POST",
    body: { type: "magiclink", email: email, options: { redirect_to: PORTAL_URL } }
  });
  if (!r.ok) throw new Error("could not create a sign-in link: " + r.text.slice(0, 200));
  var props = (r.body && r.body.properties) || r.body || {};
  var token = props.hashed_token || "";
  if (!token) throw new Error("Supabase returned no sign-in token");
  return PORTAL_URL + "#t=" + encodeURIComponent(token);
}

// ── Email ───────────────────────────────────────────────────────────────────
// The shell is copied rather than imported, as every other sending function in
// this codebase does — Netlify functions cannot share local modules without a
// bundler step. If the shell changes, change it here too.

const BRAND = {
  logo: SITE_ORIGIN + "/email-logo.png",
  site: "https://www.hawthbushfarm.co.uk",
  bg: "#f9f6f1", panel: "#ffffff", text: "#2d2a25", muted: "#7a7060", border: "#e8e2d9"
};

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildEmailHtml(bodyText, buttonUrl, buttonLabel) {
  var inner = String(bodyText || "").split(/\n\s*\n/).map(function (p) {
    return '<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:' + BRAND.text + '">' +
      escapeHtml(p).replace(/\n/g, "<br>") + "</p>";
  }).join("");

  if (buttonUrl) {
    inner += '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 6px">' +
      '<tr><td align="center" bgcolor="' + BRAND.text + '" style="border-radius:8px">' +
      '<a href="' + buttonUrl + '" style="display:inline-block;padding:13px 30px;font-family:Helvetica,Arial,sans-serif;' +
      'font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px">' +
      escapeHtml(buttonLabel || "Open your planner") + "</a></td></tr></table>";
  }

  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>Hawthbush Farm</title></head>" +
    '<body style="margin:0;padding:0;background:' + BRAND.bg + ';">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + BRAND.bg + ';padding:26px 12px">' +
    '<tr><td align="center">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%">' +
    '<tr><td align="center" style="padding:0 0 20px">' +
    '<a href="' + BRAND.site + '"><img src="' + BRAND.logo + '" alt="Hawthbush Farm" width="110" ' +
    'style="display:block;border:0;width:110px;height:auto"></a></td></tr>' +
    '<tr><td style="background:' + BRAND.panel + ";border:1px solid " + BRAND.border + ";border-radius:14px;padding:30px 34px;" +
    'font-family:Helvetica,Arial,sans-serif">' + inner + "</td></tr>" +
    '<tr><td align="center" style="padding:20px 16px 0;font-family:Helvetica,Arial,sans-serif">' +
    '<p style="margin:0 0 4px;font-size:12px;line-height:1.6;color:' + BRAND.muted + '">' +
    "Hawthbush Farm, Gun Hill, Heathfield, East Sussex &middot; " +
    '<a href="mailto:' + FROM_EMAIL + '" style="color:' + BRAND.muted + '">' + FROM_EMAIL + "</a></p>" +
    '<p style="margin:0;font-size:12px;color:' + BRAND.muted + '">' +
    '<a href="' + BRAND.site + '" style="color:' + BRAND.muted + '">hawthbushfarm.co.uk</a></p>' +
    "</td></tr></table></td></tr></table></body></html>";
}

async function sendEmail(to, subject, bodyText, link, label) {
  if (!RESEND_KEY) return { ok: false, error: "RESEND_API_KEY not set" };
  var res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_HEADER, to: to, subject: subject,
                           html: buildEmailHtml(bodyText, link, label) })
  });
  if (!res.ok) return { ok: false, error: "Resend failed: " + (await res.text()).slice(0, 300) };
  return { ok: true };
}

// Appended so the invite appears in Recent Automated Emails with everything
// else. Re-reads first: this is a shared array, and writing one back from a
// stale copy is how records have been lost here before.
//
// The sign-in link itself is NOT logged. It is a credential, and the log is
// readable by every member of staff.
async function logEmail(subject, to, type, bookingId, bodyText) {
  try {
    var rows = await sbRest("app_data?key=eq." + EMAIL_LOG_KEY + "&select=value");
    var log = (rows && rows[0] && rows[0].value) || [];
    log.push({
      id: "el" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      sentAt: new Date().toISOString(), subject: subject, to: to,
      template: type, bookingId: bookingId == null ? "" : String(bookingId),
      body: String(bodyText || "").slice(0, 8000)
    });
    await sbRest("app_data", {
      method: "POST", prefer: "resolution=merge-duplicates",
      body: { key: EMAIL_LOG_KEY, value: log.slice(-500), updated_at: new Date().toISOString() }
    });
  } catch (e) { console.error("logEmail failed:", e.message); }
}

// ── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return bad("Method not allowed", 405);
  if (!SERVICE_KEY) return bad("Not configured — SUPABASE_SERVICE_KEY is missing", 500);

  var body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return bad("Invalid JSON"); }

  var email = String(body.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad("That does not look like an email address.");

  // ── staff sending an invite ───────────────────────────────────────────────
  if (body.action === "invite") {
    var me = await resolveStaff(event);
    if (!me) return bad("Only a member of staff can send an invite.", 403);

    var allowed;
    try { allowed = await sbRpc("wp_may_send_link", { p_email: email, p_min_seconds: 5 }); }
    catch (e) { return bad("Could not check that address.", 502); }
    if (!allowed || allowed.ok !== true) {
      return bad(allowed && allowed.reason === "not_invited"
        ? "Give this address access to a wedding first, then send the invite."
        : "A link was sent to that address a moment ago — give it a minute.", 409);
    }

    try {
      await ensureUser(email);
      var inviteLink = await mintLink(email);
      var inviteBody =
        "We have opened your wedding planner at Hawthbush Farm.\n\n" +
        "It is where you can tell us your numbers, work up your timings, choose " +
        "your suppliers and lay out the tables — all in one place, and all at your " +
        "own pace. Nothing needs doing today.\n\n" +
        "The button below takes you straight in. There is no password to set up or " +
        "remember: whenever you come back, go to " + PORTAL_URL + " and we will email " +
        "you a fresh link.\n\n" +
        "If anything looks wrong, just reply to this email.";

      var sent = await sendEmail(email, "Your wedding planner at Hawthbush Farm",
                                 inviteBody, inviteLink, "Open your planner");
      if (!sent.ok) return bad(sent.error, 502);

      await logEmail("Your wedding planner at Hawthbush Farm", email,
                     "portal-invite", allowed.event_id, inviteBody);
      return ok({ sent: true });
    } catch (e) {
      return bad(e.message || "Could not send the invite.", 502);
    }
  }

  // ── a couple asking for a link from the sign-in page ──────────────────────
  if (body.action === "request-link") {
    // Answers the same whatever happens, so this cannot be used to find out
    // which addresses have access.
    var quiet = ok({ sent: true });

    var may;
    try { may = await sbRpc("wp_may_send_link", { p_email: email, p_min_seconds: 60 }); }
    catch (e) { console.warn("link check failed: " + e.message); return quiet; }
    if (!may || may.ok !== true) return quiet;

    try {
      await ensureUser(email);
      var link = await mintLink(email);
      var signinBody =
        "Here is your link into the Hawthbush Farm wedding planner.\n\n" +
        "It signs you in on whatever device you open it on, and it is good for one " +
        "use. If it has expired by the time you get to it, go to " + PORTAL_URL +
        " and ask for another — we will send one straight away.\n\n" +
        "If you did not ask for this, you can ignore it and nothing will happen.";

      var r2 = await sendEmail(email, "Your sign-in link", signinBody, link, "Sign in");
      if (!r2.ok) console.warn("sign-in email failed: " + r2.error);
      else await logEmail("Your sign-in link", email, "portal-signin", may.event_id, signinBody);
    } catch (e) {
      console.warn("sign-in link failed for " + email + ": " + e.message);
    }
    return quiet;
  }

  return bad("Unknown action");
};
