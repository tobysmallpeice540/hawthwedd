// The Home Assistant link: what it is told about the day, and the alert path.
// node tests/ha-link-test.cjs
const assert = require("assert");
const crypto = require("crypto");
const T = require("../netlify/functions/whatsapp-reminders/templates.js");
const F = require("../netlify/functions/ha-link/feed.js");

// ── The template passes Meta's rules ─────────────────────────────────────────
const chk = T.checkBody("estate_alert", T.TEMPLATES.estate_alert.body);
assert.ok(chk.ok, chk.error);
assert.deepStrictEqual(chk.order, ["title", "message"]);
assert.ok(T.footerOf("estate_alert").length <= 60);

// ── The day ──────────────────────────────────────────────────────────────────
const props = [{ id: "hamlet", name: "The Hamlet" }, { id: "amly", name: "Amly Barn" }, { id: "glamping", name: "Glamping", archived: true }];
const now = new Date("2026-11-06T09:00:00Z");          // Fri 6 Nov, 9am GMT
const accom = [
  { id: "a", status: "confirmed", guestName: "Emma Juner", stays: [{ propertyId: "hamlet", checkIn: "2026-11-06", checkOut: "2026-11-09" }] },
  { id: "b", status: "confirmed", stays: [{ propertyId: "amly", checkIn: "2026-11-03", checkOut: "2026-11-06" }] },
  { id: "c", status: "cancelled", stays: [{ propertyId: "amly", checkIn: "2026-11-06", checkOut: "2026-11-08" }] },
  { id: "d", status: "pending", bookingType: "Blocked", stays: [{ propertyId: "amly", checkIn: "2026-11-07", checkOut: "2026-11-08" }] },
  { id: "e", status: "pending", propertyId: "amly", checkIn: "2026-11-20", checkOut: "2026-11-22" },
  { id: "w", status: "confirmed", linkedEventId: 9, stays: [{ propertyId: "hamlet", checkIn: "2026-11-13", checkOut: "2026-11-15" }] }
];
const events = [
  { id: 1, date: "2026-11-06", status: "Confirmed", eventType: "Wedding (Full Day)", guestArrivalTime: "13:00", couple: "Smith" },
  { id: 2, date: "2026-11-07", status: "Holding", eventType: "Party" },
  { id: 3, date: "2026-11-01", endDate: "2026-11-07", status: "Confirmed", eventType: "Other", guestArrivalTime: "sometime" }
];
const box = [{ id: "x", status: "published", name: "Supper club", starts_at: "2026-11-06T19:30:00Z" }, { id: "y", status: "draft", starts_at: "2026-11-07T19:30:00Z" }];
const f = F.feed({ now: now, accom: accom, properties: props, events: events, boxEvents: box });
assert.strictEqual(f.date, "2026-11-06");
assert.deepStrictEqual(Object.keys(f.properties), ["hamlet", "amly"], "archived properties left out");
assert.deepStrictEqual(f.properties.hamlet, { name: "The Hamlet", occupiedTonight: true, arrivingToday: true, arrivalTime: "16:00",
  departingToday: false, departureTime: null, arrivingTomorrow: false, nextArrival: "2026-11-06" });
assert.strictEqual(f.properties.amly.occupiedTonight, false, "leaves today, cancelled one arrives");
assert.strictEqual(f.properties.amly.departingToday, true);
assert.strictEqual(f.properties.amly.departureTime, "10:00");
assert.strictEqual(f.properties.amly.arrivingToday, false, "cancelled doesn't count");
assert.strictEqual(f.properties.amly.arrivingTomorrow, false, "Blocked doesn't count");
assert.strictEqual(f.properties.amly.nextArrival, "2026-11-20", "a booking with no stays list counts as one stay");
assert.ok(!JSON.stringify(f).includes("Juner") && !JSON.stringify(f).includes("Smith"), "no names leave");
assert.strictEqual(f.grainStore.eventToday, true);
assert.strictEqual(f.grainStore.todayStart, "13:00", "earliest start of the day; the multi-day event's later days have none");
assert.strictEqual(f.grainStore.todayType, "wedding");
assert.strictEqual(f.grainStore.eventTomorrow, true, "day 7 of the Other event (the Holding party and the draft don't count)");
// A wedding letting gets the wedding check-in time.
const fw = F.feed({ now: new Date("2026-11-13T09:00:00Z"), accom: accom, properties: props, events: [], boxEvents: [] });
assert.strictEqual(fw.properties.hamlet.arrivalTime, "15:00");
assert.strictEqual(fw.grainStore.eventToday, false);
assert.strictEqual(fw.grainStore.nextEvent, null);
// Summer time: London's date, not UTC's.
assert.strictEqual(F.feed({ now: new Date("2026-07-01T23:30:00Z"), accom: [], properties: props, events: [], boxEvents: [] }).date, "2026-07-02");

// ── Once an hour per title ───────────────────────────────────────────────────
assert.strictEqual(F.alertRef("Low water", new Date("2026-11-06T09:01:00Z")), F.alertRef(" low WATER ", new Date("2026-11-06T09:59:00Z")));
assert.notStrictEqual(F.alertRef("Low water", new Date("2026-11-06T09:59:00Z")), F.alertRef("Low water", new Date("2026-11-06T10:00:00Z")));
assert.notStrictEqual(F.alertRef("Low water", now), F.alertRef("Boiler", now));

// ── The handler, with Supabase and Meta faked ────────────────────────────────
process.env.SUPABASE_SERVICE_KEY = "svc";
process.env.WHATSAPP_TOKEN = "wa";
const TOKEN = "t".repeat(40);
let db, calls;
function reset(over) {
  db = Object.assign({ hash: crypto.createHash("sha256").update(TOKEN).digest("hex"), alertTo: ["447900000001"],
    settings: { templates: { estate_alert: { on: true } } }, submitted: {}, marks: new Set(), messages: [], meta: "ok" }, over || {});
  calls = [];
}
global.fetch = async function (url, o) {
  o = o || {}; calls.push({ url: url, o: o });
  const ok = function (b) { return { ok: true, status: 200, text: async function () { return b == null ? "" : JSON.stringify(b); }, json: async function () { return b; } }; };
  if (url.includes("/rest/v1/ha_link")) return ok([{ token_hash: db.hash, alert_to: db.alertTo }]);
  if (url.includes("app_data?key=eq.hbf_whatsapp_settings_v1")) return ok([{ value: db.settings }]);
  if (url.includes("app_data?key=eq.hbf_whatsapp_submitted_v1")) return ok([{ value: db.submitted }]);
  if (url.includes("app_data?key=eq.hbf_accom_v1")) return ok([{ value: accom }]);
  if (url.includes("app_data?key=eq.hbf_properties_v1")) return ok(db.noProps ? [] : [{ value: props }]);
  if (url.includes("app_data?key=eq.hawthbush_bookings_v6")) return ok([{ value: events }]);
  if (url.includes("/rest/v1/box_events")) return ok(box);
  if (url.includes("wa_sent_marks?on_conflict")) {
    const ref = JSON.parse(o.body)[0].ref;
    if (db.marks.has(ref)) return ok([]);
    db.marks.add(ref); return ok([{ ref: ref }]);
  }
  if (url.includes("wa_sent_marks") && o.method === "DELETE") { db.marks.clear(); return ok(null); }
  if (url.includes("wa_sent_marks")) return ok(null);
  if (url.includes("/rest/v1/wa_messages")) { db.messages.push(JSON.parse(o.body)); return ok(null); }
  if (url.includes("graph.facebook.com")) {
    const b = JSON.parse(o.body);
    if (b.type === "template" && db.meta === "unapproved") return { ok: false, status: 404, json: async function () { return { error: { code: 132001, message: "Template name does not exist" } }; } };
    if (db.meta === "down") return { ok: false, status: 500, json: async function () { return { error: { code: 1, message: "down" } }; } };
    return ok({ messages: [{ id: "wamid." + calls.length }] });
  }
  throw new Error("unexpected fetch " + url);
};
const H = require("../netlify/functions/ha-link/ha-link.js");
const call = function (body, token) {
  return H.handler({ httpMethod: "POST", headers: { "x-ha-token": token == null ? TOKEN : token }, body: JSON.stringify(body) })
    .then(function (r) { return { status: r.statusCode, body: JSON.parse(r.body) }; });
};

(async function () {
  reset();
  assert.strictEqual((await call({ action: "today" }, "wrong".repeat(10))).status, 401);
  assert.strictEqual((await call({ action: "today" }, "")).status, 401);
  assert.strictEqual((await H.handler({ httpMethod: "GET", headers: {} })).statusCode, 405);
  const t = await call({ action: "today" });
  assert.strictEqual(t.status, 200);
  assert.strictEqual(t.body.ok, true);
  assert.ok(t.body.properties.hamlet);
  // An empty read is an error, never "nobody is coming".
  reset({ noProps: true });
  assert.strictEqual((await call({ action: "today" })).status, 500);

  // Alert: template, logged, once an hour.
  reset();
  let r = await call({ action: "alert", title: "Low water", message: "Tank A is at 22%." });
  assert.strictEqual(r.body.sent, 1); assert.strictEqual(r.body.via, "template");
  const sent = JSON.parse(calls.filter(function (c) { return c.url.includes("graph"); })[0].o.body);
  assert.strictEqual(sent.to, "447900000001");
  assert.deepStrictEqual(sent.template.components[0].parameters.map(function (p) { return p.text; }), ["Low water", "Tank A is at 22%."]);
  assert.strictEqual(db.messages.length, 1);
  assert.ok(db.messages[0].body.startsWith("Hawthbush Farm alert: Low water"));
  r = await call({ action: "alert", title: "Low water", message: "again" });
  assert.strictEqual(r.body.sent, 0); assert.ok(/already/.test(r.body.skipped));
  // Switched off: nothing goes, nothing marked.
  reset({ settings: { templates: {} } });
  r = await call({ action: "alert", title: "Low water", message: "x" });
  assert.strictEqual(r.body.sent, 0); assert.strictEqual(db.marks.size, 0);
  assert.ok(!calls.some(function (c) { return c.url.includes("graph"); }));
  // Not approved yet: falls back to plain text, and says so.
  reset({ meta: "unapproved" });
  r = await call({ action: "alert", title: "Boiler", message: "Low" });
  assert.strictEqual(r.body.via, "text"); assert.ok(/24 hours/.test(r.body.note));
  // Meta down: nothing sent, the mark freed so the next try goes.
  reset({ meta: "down" });
  r = await call({ action: "alert", title: "Boiler", message: "Low" });
  assert.strictEqual(r.body.sent, 0); assert.strictEqual(r.body.failed.length, 1); assert.strictEqual(db.marks.size, 0);
  // No title is refused.
  reset();
  assert.strictEqual((await call({ action: "alert", title: "", message: "x" })).status, 400);
  console.log("ha-link: all passed");
})().catch(function (e) { console.error(e); process.exit(1); });
