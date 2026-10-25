// The Airbnb email worker (netlify/functions/airbnb-mail), pinned. 25 Oct 2026.
//
//   · only an admin (or the hourly shim, for "sync" only) gets in;
//   · the Gmail token is stored sealed, and the Google round trip's state is
//     signed and expires;
//   · a sync reads unread emails only, stores them in one call, then puts the
//     name, payout and guests on the matching booking — by a fresh read, by
//     id — and a second sync changes nothing;
//   · a withdrawn Google permission is reported, not thrown.
//
// No network: fetch is replaced by a fake Supabase and a fake Gmail.
//   node tests/airbnb-mail-worker-test.cjs
"use strict";
process.env.SUPABASE_SERVICE_KEY = "service-key";
process.env.HBF_ADMIN_TOKEN = "admin-token-for-tests";
process.env.GOOGLE_CLIENT_SECRET = "client-secret";
const W = require("../netlify/functions/airbnb-mail/airbnb-mail.js");

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; return; }
  fail++; console.log("FAIL " + label + (extra !== undefined ? "  →  " + JSON.stringify(extra).slice(0, 600) : ""));
}

// ── Fakes ───────────────────────────────────────────────────────────────────
const b64u = (s) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function fakeWorld() {
  const W = {
    state: { id: 1, token_enc: null, backfill_done: false },
    appData: {
      hbf_properties_v1: [{ id: "hamlet", name: "The Hamlet", airbnbImportUrl: "https://www.airbnb.co.uk/calendar/ical/11112222.ics?s=x" }],
      hbf_accom_v1: [
        { id: "a1", source: "airbnb", guestName: "Ada Airbnb", value: 0, estimated: false, guestCount: 1, status: "confirmed",
          notes: "Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMAAAA1111",
          stays: [{ propertyId: "hamlet", checkIn: "2027-04-16", checkOut: "2027-04-18", value: 0, guestCount: 1 }] },
        { id: "m1", source: "manual", guestName: "Someone", value: 500, stays: [{ propertyId: "hamlet", checkIn: "2027-05-01", checkOut: "2027-05-03" }] }
      ]
    },
    seen: {}, reservations: {}, payouts: [], reviews: [], messages: [], ingests: [], writes: 0,
    stamp: { hbf_accom_v1: "t0" }, tick: 0, conflicts: 0, lists: [], interfere: null,
    gmail: {
      "g1": { labelIds: ["INBOX"], internalDate: String(Date.parse("2026-09-22T15:28:30Z")), headers: {
                From: "Airbnb <automated@airbnb.com>", To: "t@example.invalid", Subject: "Reservation confirmed - Ada Lovelace arrives 16 Apr",
                "X-Template": "BOOKING_CONFIRMATION_TO_HOST" },
              text: "https://www.airbnb.co.uk/hosting/reservations/details/HMAAAA1111?x=1   Ada Lovelace\nhttps://www.airbnb.co.uk/hosting/thread/1234567890?x\nhttps://www.airbnb.co.uk/rooms/11112222\n\nTHE HAMLET\n\nCheck-in Checkout\nFri, 16 Apr 2027   Sun, 18 Apr 2027\n\nGUESTS\n\n13 adults\n\nCONFIRMATION CODE\nHMAAAA1111\n\nHOST PAYOUT\n\nYOU EARN   £2,193.72\n" },
      "g2": { labelIds: ["INBOX"], internalDate: String(Date.parse("2026-09-23T10:00:00Z")), headers: {
                From: "Airbnb <express@airbnb.com>", To: "t@example.invalid", Subject: "RE: Reservation for The Hamlet, 16–18 Apr",
                "X-Template": "MESSAGING_NEW_MESSAGE_EMAIL_DIGEST" },
              text: "For your protection and safety, always communicate through Airbnb\n\n   ADA\n   \n   Booker\n   \n   Can we bring a dog?\n\nReply\n[https://www.airbnb.co.uk/hosting/thread/1234567890?inbox_type=host]\n" },
      "g4": { labelIds: ["INBOX"], internalDate: String(Date.parse("2026-09-20T10:00:00Z")), headers: {
                From: "Airbnb <automated@airbnb.com>", To: "t@example.invalid", Subject: "Enquiry for The Hamlet for 16–18 Apr 2027",
                "X-Template": "BOOKING_INITIAL_INQUIRY" },
              text: "RESPOND TO ADA’S ENQUIRY\n\nAda\n\nhttps://www.airbnb.co.uk/hosting/thread/1234567890?x\n\nIdentity verified · 3 reviews\n\nLondon\n\nIs it free in April?\n\nPre-approve / Decline\n" },
      "g3": { labelIds: ["INBOX"], internalDate: String(Date.parse("2026-09-24T10:00:00Z")), headers: {
                From: "Airbnb <automated@airbnb.com>", To: "t@example.invalid", Subject: "Your confirmation code is 123456", "X-Template": "" },
              text: "123456" }
    },
    googleRefresh: "ok"
  };
  return W;
}
let world;
function reply(status, obj) { return { ok: status < 400, status: status, text: async () => (obj === undefined ? "" : JSON.stringify(obj)), json: async () => obj }; }
global.fetch = async function(url, opts) {
  opts = opts || {};
  const method = opts.method || "GET";
  const u = new URL(url);
  const body = opts.body && typeof opts.body === "string" && opts.body[0] === "{" ? JSON.parse(opts.body) : opts.body;
  // Supabase auth: who is calling
  if (u.pathname === "/auth/v1/user") {
    const tok = String(opts.headers.Authorization || "").replace("Bearer ", "");
    if (tok === "admin-session") return reply(200, { id: "u-admin", email: "a@example.invalid" });
    if (tok === "bar-session") return reply(200, { id: "u-bar", email: "b@example.invalid" });
    return reply(401, { msg: "no" });
  }
  if (u.pathname === "/rest/v1/profiles") {
    const id = u.searchParams.get("id").replace("eq.", "");
    return reply(200, [{ role: id === "u-admin" ? "admin" : "bar", active: true, name: id }]);
  }
  if (u.pathname === "/rest/v1/airbnb_mail_state") {
    if (method === "PATCH") { Object.assign(world.state, body); return reply(204); }
    return reply(200, [world.state]);
  }
  if (u.pathname === "/rest/v1/app_data") {
    const key = u.searchParams.get("key").replace("eq.", "");
    if (method === "PATCH") {
      // Somebody saves in the app between our read and our write.
      if (world.interfere) { world.interfere(); world.interfere = null; world.stamp[key] = "t" + (++world.tick); }
      const want = u.searchParams.get("updated_at");
      if (want !== "eq." + world.stamp[key]) { world.conflicts++; return reply(200, []); }
      world.appData[key] = JSON.parse(JSON.stringify(body.value)); world.stamp[key] = "t" + (++world.tick); world.writes++;
      return reply(200, [{ key: key }]);
    }
    if (method === "POST") { world.appData[body.key] = JSON.parse(JSON.stringify(body.value)); world.writes++; return reply(201); }
    return reply(200, world.appData[key] === undefined ? [] : [{ value: JSON.parse(JSON.stringify(world.appData[key])), updated_at: world.stamp[key] }]);
  }
  if (u.pathname === "/rest/v1/airbnb_mail_seen") {
    if (method === "DELETE") { world.seen = {}; return reply(204); }
    const ids = u.searchParams.get("gmail_id").replace(/^in\.\(|\)$/g, "").split(",");
    return reply(200, ids.filter((i) => world.seen[i]).map((i) => ({ gmail_id: i })));
  }
  if (u.pathname === "/rest/v1/rpc/airbnb_ingest") {
    const p = body.p; world.ingests.push(p);
    (p.reservations || []).forEach((r) => {
      const cur = world.reservations[r.code] || { code: r.code };
      Object.keys(r).forEach((k) => { if (r[k] != null && k !== "payout") cur[k] = r[k]; });
      if (r.payout != null) cur.payout_expected = r.payout;
      world.reservations[r.code] = cur;
    });
    (p.links || []).forEach((l) => { if (world.reservations[l.code]) world.reservations[l.code].booking_id = l.booking_id; });
    (p.messages || []).forEach((m) => world.messages.push(m));
    (p.seen || []).forEach((s) => { world.seen[s.id] = s.kind; });
    return reply(200, { ok: true });
  }
  if (u.pathname === "/rest/v1/rpc/airbnb_purge_enquiries") return reply(200, 0);
  if (u.pathname === "/rest/v1/airbnb_reservations") return reply(200, Object.values(world.reservations));
  if (u.pathname === "/rest/v1/airbnb_payouts") {
    const codes = (u.searchParams.get("code") || "").replace(/^in\.\(|\)$/g, "").split(",");
    return reply(200, world.payouts.filter((p) => codes.indexOf(p.code) !== -1));
  }
  if (u.pathname === "/rest/v1/airbnb_reviews") return reply(200, world.reviews);
  // Google
  if (u.hostname === "oauth2.googleapis.com" && u.pathname === "/token") {
    if (world.googleRefresh !== "ok") return reply(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
    return reply(200, { access_token: "access-1", expires_in: 3600 });
  }
  if (u.hostname === "oauth2.googleapis.com" && u.pathname === "/revoke") { world.revoked = true; return reply(200, {}); }
  if (u.hostname === "gmail.googleapis.com") {
    const m = u.pathname.match(/\/messages\/(\w+)$/);
    if (m) {
      const g = world.gmail[m[1]];
      return reply(200, { id: m[1], labelIds: g.labelIds, internalDate: g.internalDate, payload: {
        mimeType: "multipart/alternative", headers: Object.keys(g.headers).map((k) => ({ name: k, value: g.headers[k] })),
        parts: [{ mimeType: "text/plain", body: { data: b64u(g.text) } }, { mimeType: "text/html", body: { data: b64u("<p>x</p>") } }] } });
    }
    if (/\/messages$/.test(u.pathname)) {
      const q = u.searchParams.get("q");
      const after = Date.parse((q.match(/after:(\d{4})\/(\d\d)\/(\d\d)/) || []).slice(1).join("-") + "T00:00:00Z");
      world.lists.push(q);
      const ids = /in:sent/.test(q) ? [] : Object.keys(world.gmail).filter((id) => world.gmail[id].headers.From.indexOf("airbnb") !== -1
        && Number(world.gmail[id].internalDate) >= after
        && !(/-subject:"confirmation code is"/.test(q) && /confirmation code is/.test(world.gmail[id].headers.Subject)))
        .sort((a, b) => Number(world.gmail[b].internalDate) - Number(world.gmail[a].internalDate));
      // Pages of two, to walk the first read back across runs.
      const from = Number((u.searchParams.get("pageToken") || "p0").slice(1));
      const pageIds = ids.slice(from, from + 2);
      return reply(200, { messages: pageIds.map((id) => ({ id: id, threadId: "t" + id })), nextPageToken: from + 2 < ids.length ? "p" + (from + 2) : undefined });
    }
  }
  throw new Error("unexpected fetch " + method + " " + url);
};
const call = (action, auth, extra) => W.handler(Object.assign({ httpMethod: "POST", headers: auth || {}, body: JSON.stringify(Object.assign({ action: action }, extra || {})) }));
const body = (r) => JSON.parse(r.body);

(async function main() {
  world = fakeWorld();

  // ── Who gets in ───────────────────────────────────────────────────────────
  let r = await call("sync", {});
  ok(r.statusCode === 401, "A1 no session, no sync", r.statusCode);
  r = await call("sync", { authorization: "Bearer bar-session" });
  ok(r.statusCode === 401, "A2 a bar login is not an admin", r.statusCode);
  r = await call("start", { "x-admin-token": "admin-token-for-tests" });
  ok(r.statusCode === 401, "A3 the shim's token runs a sync, nothing else", r.statusCode);
  r = await call("sync", { "x-admin-token": "admin-token-for-tests" });
  ok(r.statusCode === 200 && body(r).connected === false, "A4 the shim's sync does nothing until Gmail is connected", body(r));

  // ── Sealing and signing ───────────────────────────────────────────────────
  const I = W._internals;
  const sealed = I.sealToken("1//refresh-token");
  ok(sealed.startsWith("v1:") && sealed.indexOf("refresh") === -1 && I.openToken(sealed) === "1//refresh-token", "T1 token sealed and opened");
  let threw = false; try { I.openToken(sealed.slice(0, -4) + "AAAA"); } catch (e) { threw = true; }
  ok(threw, "T2 a tampered token does not open");
  const st = I.signState({ u: "u-admin", w: "Toby", e: Date.now() + 60000 });
  ok(I.readState(st) && I.readState(st).u === "u-admin", "T3 signed state reads back");
  ok(I.readState(st.replace(/.$/, (c) => (c === "A" ? "B" : "A"))) === null, "T4 a tampered state is refused");
  ok(I.readState(I.signState({ u: "x", e: Date.now() - 1 })) === null, "T5 an expired state is refused");

  r = await call("start", { authorization: "Bearer admin-session" });
  const url = new URL(body(r).url);
  ok(url.hostname === "accounts.google.com" && url.searchParams.get("scope") === "https://www.googleapis.com/auth/gmail.readonly"
     && url.searchParams.get("access_type") === "offline" && url.searchParams.get("prompt") === "consent"
     && url.searchParams.get("redirect_uri") === "https://hawthbushfarm.netlify.app/.netlify/functions/airbnb-mail", "T6 the Google sign-in asks for read-only Gmail, offline", body(r));
  r = await W.handler({ httpMethod: "GET", queryStringParameters: { code: "abc", state: "forged.state" } });
  ok(r.statusCode === 400 && /expired|not started/.test(r.body), "T7 a callback without our state is refused");

  // ── A sync ────────────────────────────────────────────────────────────────
  world.state.token_enc = sealed;
  r = await call("sync", { authorization: "Bearer admin-session" });
  let b = body(r);
  ok(r.statusCode === 200 && b.read === 2 && b.more === true && b.backfillDone === false && world.state.backfill_page === "p2",
     "S1 the first page of old emails is read, and the walk moves back a page (login codes skipped by the query)", b);
  r = await call("sync", { authorization: "Bearer admin-session" });
  b = body(r);
  ok(b.read === 1 && b.more === false && b.backfillDone === true && world.state.backfill_page === null && world.messages.length === 2,
     "S1b the next run reads the older page and the first read is done", b);
  ok(world.ingests.length >= 1 && world.ingests[0].seen.length === 2 && world.ingests[0].messages.length === 1
     && world.ingests[0].messages[0].thread_id === "1234567890", "S2 stored in one call, the message on its thread", world.ingests[0]);
  const a1 = world.appData.hbf_accom_v1.find((x) => x.id === "a1");
  ok(a1.guestName === "Ada Lovelace" && a1.value === 2193.72 && a1.stays[0].value === 2193.72 && a1.guestCount === 13
     && a1.airbnb.code === "HMAAAA1111" && a1.airbnb.threadId === "1234567890", "S3 the booking gets name, payout and guests", a1);
  ok(world.appData.hbf_accom_v1.find((x) => x.id === "m1").value === 500 && !world.appData.hbf_accom_v1.find((x) => x.id === "m1").airbnb, "S4 a direct booking is untouched");
  ok(world.reservations.HMAAAA1111.booking_id === "a1", "S5 the reservation remembers its booking");
  ok(world.state.last_error === null && world.state.last_result && world.state.backfill_done === true && !!world.state.last_ok_at, "S6 state recorded", world.state);

  const writes = world.writes;
  r = await call("sync", { authorization: "Bearer admin-session" });
  b = body(r);
  ok(b.read === 0 && world.writes === writes, "S7 a second sync reads nothing and writes nothing", b);

  // Somebody deletes the booking while a sync is planning: it stays deleted.
  world.appData.hbf_accom_v1 = world.appData.hbf_accom_v1.filter((x) => x.id !== "a1").concat([
    { id: "a9", source: "airbnb", guestName: "Imported Customer", value: 0, notes: "https://www.airbnb.com/hosting/reservations/details/HMAAAA1111",
      stays: [{ propertyId: "hamlet", checkIn: "2027-04-16", checkOut: "2027-04-18", value: 0 }] }]);
  r = await call("sync", { authorization: "Bearer admin-session" });
  ok(!world.appData.hbf_accom_v1.some((x) => x.id === "a1") && world.appData.hbf_accom_v1.find((x) => x.id === "a9").guestName === "Ada Lovelace",
     "S8 nothing resurrected; a re-imported booking is filled in", world.appData.hbf_accom_v1.map((x) => x.id));

  // An app save lands between our read and our write: we read again, keep
  // their change and add ours.
  world.appData.hbf_accom_v1.push({ id: "a10", source: "airbnb", guestName: "Imported Customer", value: 0, estimated: false,
    notes: "https://www.airbnb.com/hosting/reservations/details/HMAAAA1111",
    stays: [{ propertyId: "hamlet", checkIn: "2027-04-16", checkOut: "2027-04-18", value: 0 }] });
  world.appData.hbf_accom_v1 = world.appData.hbf_accom_v1.filter((x) => x.id !== "a9");
  world.interfere = () => { world.appData.hbf_accom_v1.push({ id: "NEW", source: "direct", guestName: "Typed meanwhile", stays: [] }); };
  const c0 = world.conflicts;
  r = await call("sync", { authorization: "Bearer admin-session" });
  ok(world.conflicts === c0 + 1 && world.appData.hbf_accom_v1.some((x) => x.id === "NEW")
     && world.appData.hbf_accom_v1.find((x) => x.id === "a10").guestName === "Ada Lovelace", "S8b a save made meanwhile is kept, and ours goes on top", world.appData.hbf_accom_v1.map((x) => x.id));

  // Re-read after a parser fix.
  r = await call("reread", { authorization: "Bearer admin-session" });
  ok(r.statusCode === 200 && Object.keys(world.seen).length === 0 && world.state.backfill_done === false, "S9 re-read clears what was read");

  // ── Google says no ────────────────────────────────────────────────────────
  world.googleRefresh = "revoked";
  r = await call("sync", { authorization: "Bearer admin-session" });
  b = body(r);
  ok(r.statusCode === 200 && b.ok === false && /Connect Gmail again/.test(b.error) && /Connect Gmail again/.test(world.state.last_error), "G1 a withdrawn permission is reported", b);

  r = await call("disconnect", { authorization: "Bearer admin-session" });
  ok(r.statusCode === 200 && world.state.token_enc === null && world.revoked === true, "G2 disconnect revokes and forgets the token");

  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
