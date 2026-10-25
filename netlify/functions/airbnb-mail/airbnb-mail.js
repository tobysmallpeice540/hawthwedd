// netlify/functions/airbnb-mail/airbnb-mail.js
//
// Reads the Airbnb emails in Toby's Gmail and puts what they say on the
// lettings bookings: the guest's full name, the payout (net of every fee —
// what Airbnb actually pays us), the guests, the star rating, the messages
// with the guest, and a cancellation the iCal feed does not tell us about.
//
// Read only. The Gmail permission is gmail.readonly, given once by Toby
// through Google's own sign-in (Settings → Airbnb email). The refresh token is
// kept encrypted in airbnb_mail_state, which only the service role can read;
// the key is derived from HBF_ADMIN_TOKEN, so a copy of the database alone is
// not enough to use it.
//
//   GET  ?code=…&state=…          Google sends Toby back here after he agrees
//   POST {action:"start"}         admin: returns the Google sign-in address
//   POST {action:"sync"}          admin, or the hourly shim (x-admin-token)
//   POST {action:"disconnect"}    admin: forgets the token and revokes it
//   POST {action:"reread"}        admin: read every email again (after a fix)
//
// A sync reads emails within a time budget (Netlify stops a function at 10s)
// and says "more": true when there are more to read — the hourly run picks up
// where the last one stopped, and Settings' "Sync now" keeps calling until done.
//
// What is written on a booking, and when, is decided in parse.js
// (planBookingPatches): a field is filled only where it holds a placeholder or
// what an earlier sync put there. Typing over it stops the sync touching it.
// A cancellation is recorded and shown; nothing is ever cancelled or deleted.
//
// Required env vars: SUPABASE_SERVICE_KEY, HBF_ADMIN_TOKEN, GOOGLE_CLIENT_SECRET
// (the secret of the same Google OAuth client the app's Gmail button uses).
// Optional: GOOGLE_CLIENT_ID, GMAIL_REDIRECT_URI.

"use strict";

const crypto = require("crypto");
const P = require("./parse.js");

const SUPABASE_URL  = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const ACCOM_KEY     = "hbf_accom_v1";
const PROPS_KEY     = "hbf_properties_v1";
const SITE          = "https://hawthbushfarm.netlify.app";
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || "631658172216-bh6vocim7t41lf8nhr21bdpb2ss2n1mm.apps.googleusercontent.com";
const REDIRECT_URI  = process.env.GMAIL_REDIRECT_URI || (SITE + "/.netlify/functions/airbnb-mail");
const SCOPE         = "https://www.googleapis.com/auth/gmail.readonly";
// Bookings that stay in 2026 were often made in 2025, so the first read goes
// back to the start of 2025. Only bookings that end in 2026 or later are
// changed (FIRST_STAY_END).
const SCAN_FROM      = "2025/01/01";
const FIRST_STAY_END = "2026-01-01";
const READ_BUDGET_MS = 5000;
const PARALLEL       = 6;

function serviceKey() { return process.env.SUPABASE_SERVICE_KEY; }
function adminToken() { return process.env.HBF_ADMIN_TOKEN; }

// ── Supabase (service role) ─────────────────────────────────────────────────
async function sb(path, opts) {
  opts = opts || {};
  const res = await fetch(SUPABASE_URL + path, {
    method: opts.method || "GET",
    headers: Object.assign({ apikey: serviceKey(), Authorization: "Bearer " + serviceKey(), "Content-Type": "application/json" }, opts.headers || {}),
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error("Supabase " + (opts.method || "GET") + " " + path.split("?")[0] + " failed (" + res.status + "): " + text.slice(0, 200));
  return text ? JSON.parse(text) : null;
}
const rpc = (fn, args) => sb("/rest/v1/rpc/" + fn, { method: "POST", body: args || {} });

// The read a write depends on: throws on failure; null only when the key has
// never been saved.
async function appDataStrict(key) {
  const rows = await sb("/rest/v1/app_data?key=eq." + encodeURIComponent(key) + "&select=value");
  if (!Array.isArray(rows)) throw new Error("app_data read of " + key + " returned no list");
  return rows[0] ? rows[0].value : null;
}
async function appDataSet(key, value) {
  await sb("/rest/v1/app_data", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: { key: key, value: value } });
}
async function getState() {
  const rows = await sb("/rest/v1/airbnb_mail_state?id=eq.1&select=*");
  if (!rows || !rows[0]) throw new Error("airbnb_mail_state is missing — has migration 2026-10-25q been applied?");
  return rows[0];
}
async function setState(patch) {
  await sb("/rest/v1/airbnb_mail_state?id=eq.1", { method: "PATCH", body: patch });
}

// ── The token, encrypted at rest ────────────────────────────────────────────
function tokenKey() {
  if (!adminToken()) throw new Error("HBF_ADMIN_TOKEN is not set");
  return crypto.createHash("sha256").update(adminToken() + "|airbnb-gmail-refresh-token").digest();
}
function sealToken(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", tokenKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
function openToken(sealed) {
  const s = String(sealed || "");
  if (!s.startsWith("v1:")) throw new Error("stored Gmail token is in an unknown form");
  const buf = Buffer.from(s.slice(3), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", tokenKey(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

// ── Signed state for the Google round trip ──────────────────────────────────
function b64url(buf) { return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function signState(obj) {
  const body = b64url(JSON.stringify(obj));
  const sig = b64url(crypto.createHmac("sha256", tokenKey()).update("state|" + body).digest());
  return body + "." + sig;
}
function readState(state) {
  const parts = String(state || "").split(".");
  if (parts.length !== 2) return null;
  const want = b64url(crypto.createHmac("sha256", tokenKey()).update("state|" + parts[0]).digest());
  const a = Buffer.from(parts[1]), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(parts[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return obj && obj.e > Date.now() ? obj : null;
  } catch (e) { return null; }
}

// ── Who is calling (copied, not shared, like every helper in this folder) ───
async function resolveStaff(event, roles) {
  const key = serviceKey();
  const h = (event && event.headers) || {};
  const jwt = String(h["authorization"] || h["Authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt || !key) return null;
  try {
    const res = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { apikey: key, Authorization: "Bearer " + jwt } });
    if (!res.ok) return null;
    const user = await res.json();
    if (!user || !user.id) return null;
    const pr = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + encodeURIComponent(user.id) + "&select=role,active,name,email", {
      headers: { apikey: key, Authorization: "Bearer " + key }
    });
    if (!pr.ok) return null;
    const rows = await pr.json();
    const p = Array.isArray(rows) ? rows[0] : null;
    if (!p || p.active === false || roles.indexOf(p.role) === -1) return null;
    return { id: user.id, role: p.role, who: p.name || p.email || user.email || "" };
  } catch (e) {
    console.error("resolveStaff failed:", e.message);
    return null;
  }
}
function tokenMatches(given, expected) {
  if (!expected || typeof given !== "string" || !given) return false;
  const a = Buffer.from(given, "utf8"), b = Buffer.from(String(expected), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Google ──────────────────────────────────────────────────────────────────
async function googleToken(params) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(Object.assign({ client_id: CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET || "" }, params)).toString()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error("Google said " + (data.error || res.status) + (data.error_description ? ": " + data.error_description : ""));
    e.code = data.error || "google_error";
    throw e;
  }
  return data;
}
async function gmail(access, path) {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, { headers: { Authorization: "Bearer " + access } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Gmail " + path.split("?")[0] + " failed (" + res.status + "): " + ((data.error && data.error.message) || ""));
  return data;
}
async function listIds(access, q, max) {
  const out = [];
  let page = null;
  do {
    const d = await gmail(access, "messages?maxResults=500&q=" + encodeURIComponent(q) + (page ? "&pageToken=" + page : ""));
    (d.messages || []).forEach((m) => out.push(m.id));
    page = d.nextPageToken || null;
  } while (page && out.length < max);
  return out;
}

function decodePart(data) {
  return Buffer.from(String(data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
function findPart(part, mime) {
  if (!part) return null;
  if (part.mimeType === mime && part.body && part.body.data) return part;
  for (const p of part.parts || []) { const f = findPart(p, mime); if (f) return f; }
  return null;
}
function htmlToText(h) {
  return String(h || "").replace(/<(br|\/p|\/div|\/tr|\/h\d)[^>]*>/gi, "\n").replace(/<a [^>]*href="([^"]+)"[^>]*>/gi, " $1 ")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;|&rsquo;/g, "’").replace(/&quot;/g, '"');
}
async function fetchMessage(access, id) {
  const d = await gmail(access, "messages/" + id + "?format=full");
  const headers = {};
  ((d.payload && d.payload.headers) || []).forEach((h) => { headers[h.name.toLowerCase()] = h.value; });
  const plain = findPart(d.payload, "text/plain");
  const html = plain ? null : findPart(d.payload, "text/html");
  return {
    id: d.id,
    date: new Date(Number(d.internalDate) || Date.now()).toISOString(),
    from: headers["from"] || "", to: headers["to"] || "", subject: headers["subject"] || "",
    template: headers["x-template"] || "", labels: d.labelIds || [],
    text: plain ? decodePart(plain.body.data) : (html ? htmlToText(decodePart(html.body.data)) : "")
  };
}

// ── One sync ────────────────────────────────────────────────────────────────
function ymd(d) { return d.getUTCFullYear() + "/" + String(d.getUTCMonth() + 1).padStart(2, "0") + "/" + String(d.getUTCDate()).padStart(2, "0"); }

// Turn parsed emails into the ingest payload.
function toIngest(results) {
  const out = { seen: [], reservations: [], cancellations: [], alterations: [], payouts: [], reviews: [], messages: [] };
  results.forEach(({ id, r }) => {
    out.seen.push({ id: id, kind: r.kind, reason: r.reason || null });
    if (r.kind === "confirmation" || r.kind === "reminder") {
      out.reservations.push({ code: r.code, thread_id: r.threadId, room_id: r.roomId, listing: r.listing, guest_name: r.guestName,
        check_in: r.checkIn || null, check_out: r.checkOut || null, guests: r.guests, guest_count: r.guestCount,
        payout: r.payout, confirmed: r.kind === "confirmation", at: r.at });
    } else if (r.kind === "cancellation") {
      out.cancellations.push({ code: r.code, at: r.at, check_in: r.checkIn, check_out: r.checkOut });
    } else if (r.kind === "alteration") {
      out.alterations.push({ code: r.code, at: r.at });
    } else if (r.kind === "payout") {
      r.items.forEach((it) => {
        out.payouts.push({ gmail_id: id, code: it.code, amount: it.amount, sent_on: String(r.at || "").slice(0, 10) || null, payout_id: r.payoutId || null });
        out.reservations.push({ code: it.code, room_id: it.roomId, listing: it.listing, guest_name: it.guestName,
          check_in: it.checkIn, check_out: it.checkOut, at: r.at });
      });
    } else if (r.kind === "review") {
      out.reviews.push({ gmail_id: id, listing: r.listing, check_in: r.checkIn, check_out: r.checkOut, stars: r.stars, guest_first: r.guestFirst, at: r.at });
    } else if (r.kind === "digest" || r.kind === "enquiry" || r.kind === "sent" || r.kind === "request") {
      (r.messages || []).forEach((m, i) => out.messages.push({
        gmail_id: id, idx: i, thread_id: r.threadId || null, code: r.code || null, kind: r.threadKind || "reservation",
        sent_at: r.at, direction: m.direction, author: m.author, role: m.role, body: m.body }));
    }
  });
  return out;
}

function stayEnd(b) {
  const s = (b && b.stays && b.stays.length) ? b.stays : [b || {}];
  return s.reduce((m, x) => (x && x.checkOut && x.checkOut > m ? x.checkOut : m), "");
}

// Put what the emails say on the bookings. Separate from reading, and run on
// every sync: a booking the iCal import adds after its email was read still
// gets its name and payout on the next run.
//
// Planned against a fresh read and written only if nobody has written the
// bookings since that read (app_data.updated_at, which the app's saves and
// the iCal sync both move). On a clash it reads again and re-plans.
async function readAccom() {
  const rows = await sb("/rest/v1/app_data?key=eq." + ACCOM_KEY + "&select=value,updated_at");
  if (!Array.isArray(rows)) throw new Error("app_data read of " + ACCOM_KEY + " returned no list");
  return rows[0] ? { list: Array.isArray(rows[0].value) ? rows[0].value : [], stamp: rows[0].updated_at || null } : null;
}
async function writeAccomIfUnchanged(list, stamp) {
  const cond = stamp ? "&updated_at=eq." + encodeURIComponent(stamp) : "&updated_at=is.null";
  const rows = await sb("/rest/v1/app_data?key=eq." + ACCOM_KEY + cond, {
    method: "PATCH", headers: { Prefer: "return=representation" },
    body: { value: list, updated_at: new Date().toISOString() }
  });
  return Array.isArray(rows) && rows.length === 1;
}

async function applyToBookings(now) {
  const since = "2025-12-01";
  const [reservations, reviews, props] = await Promise.all([
    sb("/rest/v1/airbnb_reservations?select=code,thread_id,room_id,listing,guest_name,check_in,check_out,guests,guest_count,payout_expected,confirmed_at,cancelled_at,altered_at,booking_id&or=(check_out.gte." + since + ",check_out.is.null)&limit=1000"),
    sb("/rest/v1/airbnb_reviews?select=listing,check_in,check_out,stars,at&check_out=gte." + since + "&limit=1000"),
    appDataStrict(PROPS_KEY)
  ]);
  // Payout lines only for these reservations (PostgREST caps an unfiltered
  // read at 1,000 rows without saying so).
  const codes = (reservations || []).map((r) => r.code);
  const payouts = [];
  const chunks = [];
  for (let i = 0; i < codes.length; i += 100) chunks.push(codes.slice(i, i + 100));
  (await Promise.all(chunks.map((c) => sb("/rest/v1/airbnb_payouts?select=code,amount&code=in.(" + c.join(",") + ")"))))
    .forEach((rows) => (rows || []).forEach((r) => payouts.push(r)));

  let applied = 0, planned = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const fresh = await readAccom();
    if (!fresh) return { bookingsUpdated: 0, patchesPlanned: 0 };
    const scope = fresh.list.filter((b) => b && b.source === "airbnb" && stayEnd(b) >= FIRST_STAY_END);
    planned = P.planBookingPatches(scope, { reservations, payouts, reviews, properties: props || [] }, now);
    if (!planned.length) break;
    const res = P.applyPatches(fresh.list, planned);
    if (!res.applied) break;
    if (await writeAccomIfUnchanged(res.list, fresh.stamp)) { applied = res.applied; break; }
    console.log("[airbnb-mail] the bookings changed while planning — reading again");
    if (attempt === 2) throw new Error("the lettings bookings kept changing; the Airbnb details will be added on the next run");
  }
  const known = {};
  (reservations || []).forEach((r) => { known[r.code] = r.booking_id; });
  const newLinks = planned.filter((p) => p.code && known[p.code] !== String(p.id)).map((p) => ({ code: p.code, booking_id: String(p.id) }));
  if (applied && newLinks.length) await rpc("airbnb_ingest", { p: { links: newLinks } });
  return { bookingsUpdated: applied, patchesPlanned: planned.length };
}

const MAIN_Q = "from:(automated@airbnb.com OR express@airbnb.com) -subject:\"confirmation code is\"";
const SENT_Q = "in:sent to:reply.airbnb.com";

async function runSync() {
  const started = Date.now();
  const now = new Date().toISOString();
  const state = await getState();
  if (!state.token_enc) return { ok: true, connected: false, note: "Gmail is not connected" };

  let access;
  try {
    access = (await googleToken({ grant_type: "refresh_token", refresh_token: openToken(state.token_enc) })).access_token;
  } catch (e) {
    const msg = e.code === "invalid_grant"
      ? "Google no longer accepts the Gmail permission (it was withdrawn, or has expired). Connect Gmail again."
      : "Could not get access to Gmail: " + e.message;
    await setState({ last_error: msg, last_sync_at: now });
    return { ok: false, error: msg };
  }

  const props = (await appDataStrict(PROPS_KEY)) || [];
  const ourRooms = props.map(P.roomOfProperty).filter(Boolean);

  // What is new: back to two days before the last good run (at least four
  // days, at most sixty), so an outage of a few days loses nothing.
  const lastOk = state.last_ok_at ? Date.parse(state.last_ok_at) : Date.now();
  const back = Math.min(60, Math.max(4, Math.ceil((Date.now() - lastOk) / 86400000) + 2));
  const recentSince = ymd(new Date(Date.now() - back * 86400000));

  // And, until the first full read is done, one page (500) of the old emails
  // per run, walking back through Gmail with a saved page token.
  let page = { ids: [], next: null, failed: false };
  if (!state.backfill_done) {
    try {
      const d = await gmail(access, "messages?maxResults=500&q=" + encodeURIComponent(MAIN_Q + " after:" + SCAN_FROM)
        + (state.backfill_page ? "&pageToken=" + encodeURIComponent(state.backfill_page) : ""));
      page = { ids: (d.messages || []).map((m) => m.id), next: d.nextPageToken || null, failed: false };
    } catch (e) {
      // A page token Gmail no longer knows: start the walk again from the
      // newest. What was read already is skipped cheaply.
      console.error("[airbnb-mail] backfill page failed: " + e.message);
      page.failed = true;
      await setState({ backfill_page: null });
    }
  }
  const [recentIds, sentIds] = await Promise.all([
    listIds(access, MAIN_Q + " after:" + recentSince, 1000),
    listIds(access, SENT_Q + " after:" + (state.backfill_done ? recentSince : SCAN_FROM), 1000)
  ]);
  const all = [];
  const add = (id) => { if (all.indexOf(id) === -1) all.push(id); };
  recentIds.forEach(add); sentIds.forEach(add); page.ids.forEach(add);

  const seen = {};
  const chunks = [];
  for (let i = 0; i < all.length; i += 150) chunks.push(all.slice(i, i + 150));
  (await Promise.all(chunks.map((c) => sb("/rest/v1/airbnb_mail_seen?select=gmail_id&gmail_id=in.(" + c.map(encodeURIComponent).join(",") + ")"))))
    .forEach((rows) => (rows || []).forEach((r) => { seen[r.gmail_id] = true; }));
  const unread = all.filter((id) => !seen[id]);

  // Read within the budget, a few at a time. The budget leaves room for the
  // store, the bookings and the state update inside Netlify's ten seconds.
  const deadline = started + READ_BUDGET_MS;
  const results = [];
  const done = {};
  let next = 0, failed = 0;
  async function worker() {
    while (next < unread.length && Date.now() < deadline) {
      const id = unread[next++];
      try {
        const m = await fetchMessage(access, id);
        results.push({ id: id, r: P.parseAirbnbEmail(m, { ourRooms: ourRooms }) });
        done[id] = true;
      } catch (e) {
        failed++;
        console.error("[airbnb-mail] could not read " + id + ": " + e.message);
      }
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));

  const payload = toIngest(results);
  const stored = results.length ? await rpc("airbnb_ingest", { p: payload }) : null;
  const left = unread.filter((id) => !done[id]).length;

  // The old page is finished when every email on it has been read; then the
  // walk moves on, and ends when Gmail has no older page.
  const statePatch = {};
  let backfillDone = !!state.backfill_done;
  if (!backfillDone && !page.failed && page.ids.every((id) => seen[id] || done[id])) {
    if (page.next) statePatch.backfill_page = page.next;
    else { backfillDone = true; statePatch.backfill_page = null; statePatch.backfill_done = true; }
  }

  const applied = await applyToBookings(now);
  let purged = 0;
  if (backfillDone) purged = await rpc("airbnb_purge_enquiries", { p_days: 30 });

  const kinds = {};
  results.forEach(({ r }) => { kinds[r.kind] = (kinds[r.kind] || 0) + 1; });
  const more = left > 0 || (!backfillDone && !page.failed);
  const result = { read: results.length, left: left, failed: failed, kinds: kinds, stored: stored,
    bookingsUpdated: applied.bookingsUpdated, purged: purged, ms: Date.now() - started };
  await setState(Object.assign(statePatch, { last_sync_at: now, last_ok_at: failed ? state.last_ok_at : now,
    last_error: failed ? failed + " email(s) could not be read; they will be tried again" : null, last_result: result }));
  console.log("[airbnb-mail] " + JSON.stringify(result));
  return Object.assign({ ok: true, connected: true, more: more, backfillDone: backfillDone }, result);
}

// ── Pages Google sends Toby back to ─────────────────────────────────────────
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function page(title, body, ok) {
  return {
    statusCode: ok ? 200 : 400,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    body: "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>" + esc(title) + "</title>" +
      "<body style=\"font:16px/1.55 system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#1f2937\">" +
      "<h1 style=\"font-size:22px;margin:0 0 12px\">" + esc(title) + "</h1>" + body +
      "<p style=\"margin-top:24px\"><a href=\"" + SITE + "/\" style=\"color:#2563eb\">Back to the app</a></p></body>"
  };
}

async function handleCallback(q) {
  if (q.error) return page("Gmail was not connected", "<p>Google said: " + esc(q.error) + ". Nothing was changed.</p>", false);
  const st = readState(q.state);
  if (!st) return page("Gmail was not connected", "<p>This sign-in link has expired or was not started from the app. Start again from Settings → Airbnb email.</p>", false);
  if (!process.env.GOOGLE_CLIENT_SECRET) return page("Gmail was not connected", "<p>The server is missing GOOGLE_CLIENT_SECRET. Add it in Netlify and try again.</p>", false);
  let tok;
  try {
    tok = await googleToken({ grant_type: "authorization_code", code: String(q.code || ""), redirect_uri: REDIRECT_URI });
  } catch (e) {
    return page("Gmail was not connected", "<p>" + esc(e.message) + "</p>", false);
  }
  if (!tok.refresh_token) {
    return page("Gmail was not connected", "<p>Google did not hand over lasting access. Remove “Hawthbush” from your Google account's third-party access, then connect again.</p>", false);
  }
  if (String(tok.scope || "").split(" ").indexOf(SCOPE) === -1) {
    return page("Gmail was not connected", "<p>Reading Gmail was not allowed on Google's screen. Connect again and tick the Gmail box.</p>", false);
  }
  let account = "";
  try { account = (await gmail(tok.access_token, "profile")).emailAddress || ""; } catch (e) { /* the name is only for show */ }
  await setState({ token_enc: sealToken(tok.refresh_token), account_email: account, connected_at: new Date().toISOString(),
    connected_by: String(st.w || "").slice(0, 120), last_error: null, backfill_done: false, backfill_page: null, last_ok_at: null });
  return page("Gmail connected", "<p>Airbnb emails in <strong>" + esc(account || "your Gmail") + "</strong> will now be read every hour, read only. " +
    "The first read goes back to the start of 2025 and takes a little while — press <em>Sync now</em> in Settings → Airbnb email to hurry it along.</p>", true);
}

// ── Handler ─────────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  try {
    if (!serviceKey()) return { statusCode: 500, body: JSON.stringify({ error: "SUPABASE_SERVICE_KEY is not set" }) };
    if (event.httpMethod === "GET") {
      const q = event.queryStringParameters || {};
      if (q.code || q.error) return await handleCallback(q);
      return { statusCode: 405, body: "Use POST" };
    }
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Use POST" };
    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "bad JSON" }); }
    const action = String(body.action || "sync");
    const h = event.headers || {};
    const fromCron = tokenMatches(h["x-admin-token"] || "", adminToken());
    const staff = fromCron ? null : await resolveStaff(event, ["admin"]);
    if (!staff && !(fromCron && action === "sync")) return json(401, { error: "Admins only" });

    if (action === "start") {
      if (!process.env.GOOGLE_CLIENT_SECRET) return json(500, { error: "GOOGLE_CLIENT_SECRET is not set in Netlify" });
      const state = signState({ u: staff.id, w: staff.who, e: Date.now() + 15 * 60000, n: crypto.randomBytes(9).toString("hex") });
      const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
        client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code", scope: SCOPE,
        access_type: "offline", prompt: "consent", include_granted_scopes: "false", state: state
      }).toString();
      return json(200, { ok: true, url: url });
    }
    if (action === "sync") return json(200, await runSync());
    if (action === "disconnect") {
      const st = await getState();
      if (st.token_enc) {
        try { await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(openToken(st.token_enc)), { method: "POST" }); }
        catch (e) { console.error("[airbnb-mail] revoke failed: " + e.message); }
      }
      await setState({ token_enc: null, account_email: null, connected_at: null, connected_by: null, last_error: null });
      return json(200, { ok: true });
    }
    if (action === "reread") {
      await sb("/rest/v1/airbnb_mail_seen?gmail_id=not.is.null", { method: "DELETE" });
      await setState({ backfill_done: false, backfill_page: null });
      return json(200, { ok: true });
    }
    return json(400, { error: "unknown action" });
  } catch (e) {
    console.error("[airbnb-mail] " + (e && e.stack || e));
    try { await setState({ last_error: String(e.message || e).slice(0, 300), last_sync_at: new Date().toISOString() }); } catch (e2) { /* nothing more to do */ }
    return json(500, { error: String(e.message || e) });
  }
};
function json(code, obj) { return { statusCode: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) }; }

exports._internals = { toIngest, sealToken, openToken, signState, readState, applyToBookings, stayEnd };
