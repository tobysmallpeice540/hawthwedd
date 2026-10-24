// The review fixes to the Netlify functions, pinned (24 Oct 2026).
//
//   · create-accom-checkout prices on the server, with the booking page's own
//     rules — checked here against quoteStay lifted from App.jsx AND from
//     public/book-accom.html, so all three must agree;
//   · the background writers (sync-all-icals, send-accom-reminders,
//     send-accom-email, handle-viewing, stripe-accom-webhook) apply only their
//     own changes to a freshly read array, by id, and never resurrect a record;
//   · the calendar feed carries contact details only with the right token,
//     and answers 503 rather than an empty calendar when a read fails;
//   · the staff-only functions refuse a caller without a staff session.
//
// No network: global.fetch is replaced by a fake Supabase for the handler
// tests. Run: node tests/function-hardening-test.cjs
const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
function loadFn(name) {
  const P = path.join(ROOT, "netlify", "functions", name + ".js");
  const m = new Module(P, null);
  m.filename = P;
  m.paths = Module._nodeModulePaths(path.dirname(P));
  m._compile(fs.readFileSync(P, "utf8"), P);
  return m.exports;
}
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy";
process.env.SUPABASE_SERVICE_KEY = "service-key";

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}
const eq = (l, got, want) =>
  ok(l + "  (got " + JSON.stringify(got) + ")", JSON.stringify(got) === JSON.stringify(want));

// Lift a function verbatim out of a source file (same approach as
// clash-and-contract-test.cjs).
function lift(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start === -1) throw new Error("Could not find function " + name);
  let i = src.indexOf("{", start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}

(async function main() {

// ── 1. Server price = the page's price = the app's price ────────────────────
console.log("\n— server-side pricing (create-accom-checkout) —");
{
  const checkout = loadFn("create-accom-checkout")._internals;
  const APP = fs.readFileSync(path.join(ROOT, "src", "App.jsx"), "utf8");
  const PAGE = fs.readFileSync(path.join(ROOT, "public", "book-accom.html"), "utf8");
  const app = {}, page = {};
  eval(["round2", "seasonForDate", "getPriceForNight", "longStayDiscountAmount", "quoteStay"]
    .map(n => lift(APP, n)).join("\n") + "\napp.quoteStay = quoteStay;");
  eval(["parseISO", "toISO", "seasonForDate", "getPriceForNight", "longStayDiscountAmount", "quoteStay"]
    .map(n => lift(PAGE, n)).join("\n") + "\npage.quoteStay = quoteStay;");

  const hamlet = { id: "hamlet", name: "The Hamlet", baseRate: 400, depositPct: 50, balanceWeeks: 4,
    longStayThreshold: 7, longStayDiscountPct: 10,
    seasons: [
      { name: "Bank holiday", startDate: "2027-05-28", endDate: "2027-06-01", ratePerNight: 650 },
      { name: "Summer", startDate: "2027-05-01", endDate: "2027-09-01", ratePerNight: 520 }
    ] };
  const amly = { id: "amly", name: "Amly Barn", baseRate: 180, depositPct: 50, balanceWeeks: 6,
    longStayThreshold: 5, longStayDiscount: 15 /* legacy £/night */, seasons: [] };
  const glamp = { id: "glamping", name: "Glamping", baseRate: 95.5, depositPct: 20, balanceWeeks: 6, seasons: [] };
  const hidden = { id: "secret", name: "Not online", baseRate: 100, publicBookable: false };
  const PROPS = [hamlet, amly, glamp, hidden];

  const cases = [
    ["off-season, 2 nights", hamlet, "2027-03-05", "2027-03-07"],
    ["straddling into summer", hamlet, "2027-04-29", "2027-05-03"],
    ["bank holiday wins over summer (priority)", hamlet, "2027-05-27", "2027-06-02"],
    ["long stay, % discount", hamlet, "2027-07-01", "2027-07-10"],
    ["long stay, legacy £/night", amly, "2027-02-01", "2027-02-08"],
    ["pence rates", glamp, "2027-08-13", "2027-08-16"],
    ["across the October clock change", amly, "2026-10-23", "2026-10-27"],
  ];
  // App.jsx's quoteStay walks the nights with LOCAL-time Dates and
  // toISOString(), so in a browser on British Summer Time every night is
  // priced as the day before (see the report). The server and the booking
  // page are UTC-anchored. So the app is compared with the clock on UTC —
  // where it is correct — and its London-time drift is printed, not counted.
  const prevTZ = process.env.TZ;
  cases.forEach(function(c) {
    const s = checkout.quoteStay(c[1], c[2], c[3]);
    const p = page.quoteStay(c[1], c[2], c[3]);
    process.env.TZ = "UTC";
    const a = app.quoteStay(c[1], c[2], c[3]);
    process.env.TZ = "Europe/London";
    const aLondon = app.quoteStay(c[1], c[2], c[3]);
    if (prevTZ === undefined) delete process.env.TZ; else process.env.TZ = prevTZ;
    ok(c[0] + ": server " + s.total + " = page " + p.total + " = app(UTC) " + a.total,
       s.total === p.total && s.total === a.total && s.nights === a.nights);
    if (aLondon.total !== s.total) console.log("       note: the app in a London browser quotes " + aLondon.total + " for this stay");
  });

  const today = "2026-10-24";
  const basket = [
    { propertyId: "hamlet", checkIn: "2027-07-01", checkOut: "2027-07-10" },
    { propertyId: "glamping", checkIn: "2027-07-01", checkOut: "2027-07-04" }
  ];
  const q = checkout.priceBooking(PROPS, basket, today);
  const pageTotal = page.quoteStay(hamlet, "2027-07-01", "2027-07-10").total + page.quoteStay(glamp, "2027-07-01", "2027-07-04").total;
  eq("basket total is the sum of the stays", q.total, pageTotal);
  eq("deposit is the page's figure (50% floor even with glamping's 20%)", q.deposit, Math.round(pageTotal * 50) / 100);
  eq("balance weeks = the smallest in the basket", q.balanceWeeks, 4);
  eq("stays carry server values", q.stays.map(s => s.value), [page.quoteStay(hamlet, "2027-07-01", "2027-07-10").total, page.quoteStay(glamp, "2027-07-01", "2027-07-04").total]);
  ok("a property not bookable online is refused", !!checkout.priceBooking(PROPS, [{ propertyId: "secret", checkIn: "2027-01-01", checkOut: "2027-01-03" }], today).error);
  ok("an unknown property is refused", !!checkout.priceBooking(PROPS, [{ propertyId: "nope", checkIn: "2027-01-01", checkOut: "2027-01-03" }], today).error);
  ok("a past check-in is refused", !!checkout.priceBooking(PROPS, [{ propertyId: "amly", checkIn: "2026-10-01", checkOut: "2026-10-03" }], today).error);
  ok("check-out before check-in is refused", !!checkout.priceBooking(PROPS, [{ propertyId: "amly", checkIn: "2027-01-05", checkOut: "2027-01-03" }], today).error);
  ok("the same property twice is refused", !!checkout.priceBooking(PROPS, [basket[0], basket[0]], today).error);
  ok("a stay over max nights is refused", !!checkout.priceBooking(PROPS, [{ propertyId: "amly", checkIn: "2027-01-01", checkOut: "2027-02-15" }], today).error);
  ok("an unpriced (£0) stay is refused", !!checkout.priceBooking([{ id: "x", name: "X", baseRate: 0 }], [{ propertyId: "x", checkIn: "2027-01-01", checkOut: "2027-01-03" }], today).error);

  // The clash check covers blocks and Airbnb imports (they are bookings too).
  const diary = [
    { id: "B1", bookingType: "Blocked", status: "confirmed", stays: [{ propertyId: "amly", checkIn: "2027-02-02", checkOut: "2027-02-04" }] },
    { id: "ical-1", source: "airbnb", status: "confirmed", stays: [{ propertyId: "hamlet", checkIn: "2027-07-05", checkOut: "2027-07-06" }] },
    { id: "C1", status: "cancelled", stays: [{ propertyId: "glamping", checkIn: "2027-07-01", checkOut: "2027-07-04" }] },
    { id: "P1", status: "pending", propertyId: "amly", checkIn: "2027-03-01", checkOut: "2027-03-03" }
  ];
  eq("a block clashes", checkout.findClashes(diary, [{ propertyId: "amly", checkIn: "2027-02-01", checkOut: "2027-02-03" }]).length, 1);
  eq("an Airbnb import clashes", checkout.findClashes(diary, basket).length, 1);
  eq("a cancelled booking does not", checkout.findClashes(diary, [basket[1]]).length, 0);
  eq("a pending flat booking does", checkout.findClashes(diary, [{ propertyId: "amly", checkIn: "2027-03-02", checkOut: "2027-03-04" }]).length, 1);
  eq("a changeover is not a clash", checkout.findClashes(diary, [{ propertyId: "amly", checkIn: "2027-02-04", checkOut: "2027-02-06" }]).length, 0);
}

// ── 2. Merge-by-id for the background writers ───────────────────────────────
console.log("\n— sync-all-icals: append only what is missing —");
{
  const I = loadFn("sync-all-icals")._internals;
  const fresh = [{ id: "A1", guestName: "edited meanwhile" }, { id: "ical-x", airbnbUid: "u1" }];
  const r = I.mergeNewImports(fresh, [{ id: "ical-a", airbnbUid: "u1" }, { id: "ical-b", airbnbUid: "u2" }, { id: "ical-c", airbnbUid: "u2" }]);
  eq("only the genuinely new import is added", r.added, 1);
  eq("the fresh copy's edits survive", r.list[0].guestName, "edited meanwhile");
  eq("nothing else changes", r.list.map(b => b.id), ["A1", "ical-x", "ical-b"]);
  ok("the fresh array is not mutated", fresh.length === 2);
  const stale = [{ id: "DELETED" }];
  const r2 = I.mergeNewImports([{ id: "A1" }], [{ id: "ical-n", airbnbUid: "u9" }]);
  ok("a booking deleted meanwhile is not resurrected", r2.list.every(b => b.id !== stale[0].id));
  const st = I.stampSynced([{ id: "hamlet", airbnbImportUrl: "x" }, { id: "amly", airbnbImportUrl: "y" }, { id: "glamping" }], ["hamlet"], "T");
  eq("only properties that synced are stamped", st.list.map(p => p.lastSyncedAt || null), ["T", null, null]);
  ok("nothing synced = no write", I.stampSynced([{ id: "hamlet", airbnbImportUrl: "x" }], [], "T").changed === false);
}

console.log("\n— send-accom-reminders: claim before send, settle after —");
{
  const I = loadFn("send-accom-reminders")._internals;
  const fresh = [{ id: "A1", emailFlags: {}, schedule: [{ label: "Deposit", amount: 100, paid: false }] }, { id: "A2", notes: "new" }];
  const c = I.claimFlag(fresh, "A1", "depositRequestSent", b => !b.schedule[0].paid);
  ok("a claim sets the flag on the fresh record", c && c.booking.emailFlags.depositRequestSent === true);
  ok("and leaves the other records exactly as read", c.list[1] === fresh[1]);
  ok("a flag already set (another run) is not claimed again", I.claimFlag(c.list, "A1", "depositRequestSent") === null);
  ok("a booking deleted meanwhile is not claimed", I.claimFlag([fresh[1]], "A1", "depositRequestSent") === null);
  ok("a deposit paid meanwhile is not claimed", I.claimFlag([{ id: "A1", schedule: [{ label: "Deposit", paid: true }] }], "A1", "depositRequestSent", b => !b.schedule[0].paid) === null);
  const kept = I.settleFlag(c.list, "A1", "depositRequestSent", true, { Deposit: "cs_1" });
  eq("a sent email keeps its flag and records the session", [kept.booking.emailFlags.depositRequestSent, kept.booking.schedule[0].stripeId], [true, "cs_1"]);
  const released = I.settleFlag(c.list, "A1", "depositRequestSent", false, null);
  eq("a failed send gives the flag back", released.booking.emailFlags.depositRequestSent, undefined);
  ok("settling a deleted booking writes nothing", I.settleFlag([fresh[1]], "A1", "x", true, {}) === null);
}

console.log("\n— send-accom-email: flag + payment link onto the fresh copy —");
{
  const I = loadFn("send-accom-email")._internals;
  const fresh = [{ id: "A1", guestName: "renamed", schedule: [{ label: "Deposit", stripeId: "old" }, { label: "Balance", stripeId: "keep" }] }, { id: "A9" }];
  const out = I.applyEmailSent(fresh, "A1", "deposit_request", { Deposit: "cs_new" });
  eq("flag set", out[0].emailFlags.deposit_requestSent, true);
  eq("the minted link replaces only its own entry", out[0].schedule.map(s => s.stripeId), ["cs_new", "keep"]);
  eq("edits made meanwhile survive", out[0].guestName, "renamed");
  ok("deleted meanwhile = nothing written", I.applyEmailSent([{ id: "A9" }], "A1", "x", {}) === null);
}

console.log("\n— handle-viewing: one request, current state respected —");
{
  const I = loadFn("handle-viewing")._internals;
  ok("pending can be confirmed", I.actionAllowed("pending", "confirm"));
  ok("confirmed cannot be confirmed again", !I.actionAllowed("confirmed", "confirm"));
  ok("declined cannot be confirmed", !I.actionAllowed("declined", "confirm"));
  ok("confirmed cannot be declined", !I.actionAllowed("confirmed", "decline"));
  ok("an amend may move a confirmed viewing", I.actionAllowed("confirmed", "amend"));
  const out = I.applyViewingPatch([{ id: "v1", status: "pending" }, { id: "v2", status: "pending", note: "new meanwhile" }], "v1", { status: "confirmed" });
  eq("only the one request changes", out.map(r => r.status), ["confirmed", "pending"]);
  ok("a request deleted meanwhile is not resurrected", I.applyViewingPatch([{ id: "v2" }], "v1", { status: "x" }) === null);
}

console.log("\n— stripe-accom-webhook: the payment, applied —");
{
  const I = loadFn("stripe-accom-webhook")._internals;
  const base = (status, extra) => [Object.assign({ id: "W1", status: status, email: "g@x", stripeSessionId: "cs_1",
    schedule: [{ label: "Deposit", amount: 100, paid: false }, { label: "Balance", amount: 100, paid: false }] }, extra || {}), { id: "W2" }];
  const pay = { metaType: "accom_deposit", sessionId: "cs_1", amountPence: 10000, paidDate: "2026-10-24", paymentIntentId: "pi_1", receiptUrl: "r" };
  const r = I.applyPayment(base("pending"), pay);
  eq("pending → confirmed", r.booking.status, "confirmed");
  ok("the first online payment claims the confirmation email in the same write", r.sendBookingConfirmed && r.booking.emailFlags.bookingConfirmedSent);
  ok("other bookings untouched", r.list[1].id === "W2");
  const again = I.applyPayment(r.list, pay);
  ok("a retried delivery is recognised and changes nothing", again.duplicate === true);
  const c = I.applyPayment(base("cancelled"), pay);
  eq("a cancelled booking stays cancelled", c.booking.status, "cancelled");
  ok("its payment is recorded", c.booking.schedule[0].paid === true);
  ok("and the guest is not sent a confirmation", c.cancelled && !c.sendBookingConfirmed);
  const done = I.applyPayment(base("completed"), Object.assign({}, pay, { metaType: "accom_reminder", bookingId: "W1", scheduleLabel: "Balance" }));
  eq("only pending is promoted — completed stays completed", done.booking.status, "completed");
  ok("an unknown booking is reported as not found", I.applyPayment([{ id: "W2" }], pay).notFound === true);
}

// ── 3. Calendar feed ────────────────────────────────────────────────────────
console.log("\n— calendar-feed: contact details only with the token —");
{
  const F = loadFn("calendar-feed");
  const I = F._internals;
  const data = {
    bookings: [{ id: 1, date: "2027-06-05", couple: "Sam & Alex", status: "Confirmed", phone: "07700 900111", email: "sam@example.com", mealGuests: 90,
                 viewings: [{ date: "2026-11-02", time: "14:00", notes: "Bringing parents, call 07700 900222" }] }],
    enquiries: [],
    accom: [{ id: "A1", guestName: "Pat Guest", phone: "07700 900333", email: "pat@example.com", guestCount: 4, bookingType: "Wedding",
              stays: [{ propertyId: "amly", propertyName: "Amly Barn", checkIn: "2027-06-04", checkOut: "2027-06-07" }] }],
    ticketed: [], portalNums: {}
  };
  const pub = I.buildIcs(data, false), full = I.buildIcs(data, true);
  ok("public: names are there", pub.indexOf("Sam & Alex") !== -1 && pub.indexOf("Pat Guest") !== -1);
  ok("public: no phone numbers", !/0770/.test(pub));
  ok("public: no email addresses", pub.indexOf("@example.com") === -1);
  ok("public: no viewing notes", pub.indexOf("Bringing parents") === -1);
  ok("public: no guest counts", pub.indexOf("Day guests") === -1 && pub.indexOf("Guests: 4") === -1);
  ok("public: types kept", pub.indexOf("Type: Wedding") !== -1 && pub.indexOf("CATEGORIES:Viewing") !== -1);
  ok("tokened: phone and email included", full.indexOf("07700 900111") !== -1 && full.indexOf("pat@example.com") !== -1);
  ok("tokened: notes included", full.indexOf("Bringing parents") !== -1);

  ok("no token configured never matches", !I.tokenMatches("abc", undefined) && !I.tokenMatches("", ""));
  ok("wrong length never matches", !I.tokenMatches("abc", "abcd"));
  ok("wrong token never matches", !I.tokenMatches("abcd", "abce"));
  ok("right token matches", I.tokenMatches("s3cret-token", "s3cret-token"));

  // Handler, with a fake Supabase.
  const realFetch = global.fetch;
  let failKey = null;
  global.fetch = async function(url) {
    url = String(url);
    const key = (/key=eq\.([^&]+)/.exec(url) || [])[1];
    if (failKey && key === failKey) return new Response('{"message":"down"}', { status: 500 });
    if (key === "hawthbush_bookings_v6") return new Response(JSON.stringify([{ value: data.bookings }]), { status: 200 });
    if (key === "hbf_accom_v1") return new Response(JSON.stringify([{ value: data.accom }]), { status: 200 });
    if (key) return new Response("[]", { status: 200 });
    return new Response("[]", { status: 200 });
  };
  process.env.CALENDAR_FEED_TOKEN = "feed-token-123";
  let res = await F.handler({ queryStringParameters: {} });
  ok("no token: 200, redacted", res.statusCode === 200 && res.body.indexOf("sam@example.com") === -1);
  ok("no CORS header", !("Access-Control-Allow-Origin" in res.headers));
  res = await F.handler({ queryStringParameters: { t: "feed-token-123" } });
  ok("right token: contact details", res.statusCode === 200 && res.body.indexOf("sam@example.com") !== -1);
  res = await F.handler({ queryStringParameters: { t: "feed-token-124" } });
  ok("wrong token: redacted", res.statusCode === 200 && res.body.indexOf("sam@example.com") === -1);
  delete process.env.CALENDAR_FEED_TOKEN;
  res = await F.handler({ queryStringParameters: { t: "" } });
  ok("token unset: redacted", res.body.indexOf("sam@example.com") === -1);
  failKey = "hbf_accom_v1";
  res = await F.handler({ queryStringParameters: {} });
  eq("a failed lettings read is a 503, not an empty calendar", res.statusCode, 503);
  failKey = "hawthbush_bookings_v6";
  res = await F.handler({ queryStringParameters: {} });
  eq("a failed events read is a 503", res.statusCode, 503);
  global.fetch = realFetch;
}

// ── 4. Staff-only functions refuse strangers ────────────────────────────────
console.log("\n— staff-only functions —");
{
  const realFetch = global.fetch;
  let role = null;              // null = token rejected by Supabase
  let calls = [];
  global.fetch = async function(url, opts) {
    url = String(url);
    calls.push(url);
    if (url.indexOf("/auth/v1/user") !== -1) {
      return role ? new Response(JSON.stringify({ id: "u1", email: "s@x" }), { status: 200 })
                  : new Response('{"msg":"bad jwt"}', { status: 401 });
    }
    if (url.indexOf("/rest/v1/profiles") !== -1) return new Response(JSON.stringify([{ role: role, active: true }]), { status: 200 });
    // Anything else: a refusal, so a handler that got past auth stops quickly.
    return new Response('{"message":"stop"}', { status: 500 });
  };
  const ev = (auth, body) => ({ httpMethod: "POST", headers: auth ? { authorization: "Bearer " + auth } : {}, body: JSON.stringify(body || {}) });
  const cases = [
    ["send-accom-email", ["admin"], { bookingId: "A1", emailType: "deposit_request" }],
    ["handle-viewing", ["admin"], { id: "v1", action: "confirm" }],
    ["sync-property-ical", ["admin"], { propertyId: "amly" }],
    ["todoist-feed", ["admin", "bar", "cleaner"], { url: "https://ics.todoist.com/x" }],
    ["zettle-sales", ["admin", "bar", "cleaner"], { action: "catalogue" }],
    ["send-cleaning-summary", ["admin"], {}],
  ];
  for (const c of cases) {
    const fn = loadFn(c[0]);
    role = null; calls = [];
    let r = await fn.handler(ev(null, c[2]));
    eq(c[0] + ": no session → 403", r.statusCode, 403);
    ok(c[0] + ": and nothing else was fetched", calls.every(u => u.indexOf("/auth/v1/") !== -1 || u.indexOf("/profiles") !== -1));
    r = await fn.handler(ev("not-a-jwt", c[2]));
    eq(c[0] + ": rejected session → 403", r.statusCode, 403);
    for (const rl of ["admin", "bar", "cleaner"]) {
      role = rl;
      r = await fn.handler(ev("jwt", c[2]));
      const allowed = c[1].indexOf(rl) !== -1;
      ok(c[0] + ": " + rl + " " + (allowed ? "gets past the check" : "is refused") + " (" + r.statusCode + ")",
         allowed ? r.statusCode !== 403 : r.statusCode === 403);
    }
  }
  // The cleaning summary's cron path: the office token, compared in constant time.
  process.env.HBF_ADMIN_TOKEN = "office-token";
  const cs = loadFn("send-cleaning-summary");
  role = null;
  let r = await cs.handler({ httpMethod: "POST", headers: { "x-admin-token": "office-token" }, body: "{}" });
  ok("send-cleaning-summary: the shim's token gets past the check (" + r.statusCode + ")", r.statusCode !== 403);
  r = await cs.handler({ httpMethod: "POST", headers: { "x-admin-token": "office-tokeN" }, body: "{}" });
  eq("send-cleaning-summary: a wrong token is refused", r.statusCode, 403);
  delete process.env.HBF_ADMIN_TOKEN;
  global.fetch = realFetch;
}

// ── 5. submit-viewing refuses to save over a failed read ────────────────────
console.log("\n— submit-viewing —");
{
  const realFetch = global.fetch;
  let writes = 0, readStatus = 500;
  global.fetch = async function(url, opts) {
    if (opts && opts.method === "POST") { writes++; return new Response("", { status: 201 }); }
    return readStatus === 200 ? new Response('[{"value":[{"id":"vr_1"}]}]', { status: 200 })
                              : new Response('{"message":"down"}', { status: readStatus });
  };
  const sv = loadFn("submit-viewing");
  const body = JSON.stringify({ name: "<b>Jo</b>", email: "jo@x", date: "2026-11-02", time: "14:00" });
  let r = await sv.handler({ httpMethod: "POST", body: body });
  eq("a failed read is refused", r.statusCode, 503);
  eq("and nothing is written", writes, 0);
  readStatus = 200;
  r = await sv.handler({ httpMethod: "POST", body: body });
  eq("a good read saves", r.statusCode, 200);
  ok("and the internal id is not returned", JSON.parse(r.body).id === undefined);
  global.fetch = realFetch;
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
})().catch(function(e) { console.error(e); process.exit(1); });
