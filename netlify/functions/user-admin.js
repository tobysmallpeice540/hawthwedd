// netlify/functions/user-admin.js
// Staff logins: create, change role, switch off, reset a password.
//
// Separate from box-admin.js because it is not box office — it governs who can
// sign in to anything. Same authorisation shape though: a verified Supabase
// session, and the role read from the profiles table rather than from anything
// the browser sent. **Admin only**, with no exceptions: an account that could
// change its own role would make every other permission decorative.
//
// The office key (HBF_ADMIN_TOKEN) is deliberately NOT accepted here. It is a
// shared secret with no person attached, and creating logins is exactly the
// action that should be attributable to somebody.
//
// Required env vars: SUPABASE_SERVICE_KEY

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;

const ROLES = ["admin", "bar", "cleaner"];

// Long enough to be meaningless as a ban duration and short enough to be a
// valid interval — Supabase treats any future ban as "cannot sign in".
const BAN_FOREVER = "876000h";

async function sbRest(path, opts) {
  var o = opts || {};
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    method: o.method || "GET",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json",
      "Prefer": o.prefer || "return=representation"
    },
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  var text = await res.text();
  if (!res.ok) throw new Error("supabase " + res.status + ": " + text);
  try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
}

// Supabase's admin endpoints, which is the only way to make an account without
// the person signing themselves up.
async function sbAuthAdmin(path, opts) {
  var o = opts || {};
  var res = await fetch(SUPABASE_URL + "/auth/v1/admin" + path, {
    method: o.method || "GET",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json"
    },
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  var text = await res.text();
  var json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) {}
  return { ok: res.ok, status: res.status, body: json, text: text };
}

function ok(data)  { return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }; }
function bad(m, c) { return { statusCode: c || 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: m }) }; }

// Only a signed-in admin. Verified with Supabase, so a JWT invented in the
// browser is rejected rather than believed.
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

  return { id: user.id, role: p.role, who: p.name || p.email || "admin" };
}

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") return bad("Method not allowed", 405);
  if (!SERVICE_KEY) return bad("Not configured — SUPABASE_SERVICE_KEY is missing", 500);

  var body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return bad("Invalid JSON"); }

  var me = await resolveAdmin(event);
  if (!me) return bad("Only an administrator can manage logins.", 403);

  try {
    switch (body.action) {

      // Profiles are the source of truth for roles; the auth side supplies
      // when each person last signed in, which is the useful thing to see
      // when wondering whether an account is still in use.
      case "users.list": {
        var profiles = await sbRest("profiles?select=*&order=role.asc,email.asc");
        var authList = await sbAuthAdmin("/users?per_page=200");
        var meta = {};
        if (authList.ok && authList.body && authList.body.users) {
          authList.body.users.forEach(function(u) {
            meta[u.id] = { last_sign_in_at: u.last_sign_in_at, banned_until: u.banned_until };
          });
        }
        return ok({
          users: (profiles || []).map(function(p) {
            return Object.assign({}, p, meta[p.id] || {});
          }),
          me: me.id
        });
      }

      case "users.create": {
        var email = String(body.email || "").trim().toLowerCase();
        var password = String(body.password || "");
        var role = ROLES.indexOf(body.role) !== -1 ? body.role : "bar";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad("That doesn't look like an email address.");
        if (password.length < 10) return bad("Use a password of at least 10 characters.");

        // email_confirm so the person can sign in straight away — these are
        // accounts you are handing out, not strangers signing themselves up.
        var made = await sbAuthAdmin("/users", {
          method: "POST",
          body: {
            email: email,
            password: password,
            email_confirm: true,
            user_metadata: { name: String(body.name || "").trim(), role: role }
          }
        });
        if (!made.ok) {
          var msg = (made.body && (made.body.msg || made.body.message)) || made.text;
          if (/already/i.test(msg || "")) return bad("There is already an account for that address.", 409);
          return bad(msg || "Could not create that account.", made.status || 500);
        }

        // The signup trigger creates the profile. Set the role again here in
        // case this project's trigger predates the metadata handling.
        await sbRest("profiles?id=eq." + made.body.id, {
          method: "PATCH", prefer: "return=minimal",
          body: { role: role, name: String(body.name || "").trim(), email: email }
        });
        return ok({ id: made.body.id, email: email, role: role });
      }

      case "users.setRole": {
        if (ROLES.indexOf(body.role) === -1) return bad("Unknown role.");
        // The last admin must not be able to demote themselves out of the
        // building — there would then be nobody who could put it right.
        if (body.id === me.id && body.role !== "admin") {
          return bad("You can't remove your own administrator access.", 409);
        }
        var upd = await sbRest("profiles?id=eq." + body.id, { method: "PATCH", body: { role: body.role } });
        return ok({ user: upd && upd[0] });
      }

      case "users.setActive": {
        var active = body.active !== false;
        if (body.id === me.id && !active) return bad("You can't switch off your own account.", 409);

        await sbRest("profiles?id=eq." + body.id, {
          method: "PATCH", prefer: "return=minimal", body: { active: active }
        });
        // The profile flag alone stops the app; banning stops the password
        // working at all. A leaver should be out in both senses.
        await sbAuthAdmin("/users/" + body.id, {
          method: "PUT",
          body: { ban_duration: active ? "none" : BAN_FOREVER }
        });
        return ok({ id: body.id, active: active });
      }

      // Sends the same reset email the sign-in screen does, so a password is
      // never typed by one person and read by another.
      case "users.sendReset": {
        var who = await sbRest("profiles?id=eq." + body.id + "&select=email");
        var addr = who && who[0] && who[0].email;
        if (!addr) return bad("That account has no email address.");
        var r = await fetch(SUPABASE_URL + "/auth/v1/recover", {
          method: "POST",
          headers: { "apikey": SERVICE_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ email: addr })
        });
        if (!r.ok) return bad("Could not send the reset email: " + await r.text(), 502);
        return ok({ sent: addr });
      }

      // Deleting is for an account created by mistake. For somebody who has
      // left, switch them off instead — it keeps the record of who did what.
      case "users.delete": {
        if (body.id === me.id) return bad("You can't delete your own account.", 409);
        var del = await sbAuthAdmin("/users/" + body.id, { method: "DELETE" });
        if (!del.ok) return bad(del.text || "Could not delete that account.", del.status || 500);
        return ok({ deleted: body.id });
      }

      default:
        return bad("Unknown action: " + body.action);
    }
  } catch (err) {
    console.error("user-admin error:", body.action, err && err.message ? err.message : err);
    return bad(String(err.message || err), 500);
  }
};
