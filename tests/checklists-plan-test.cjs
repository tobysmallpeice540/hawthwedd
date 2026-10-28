// tests/checklists-plan-test.cjs
//
// The rules for when a staff checklist starts (netlify/functions/checklists/plan.js):
// London time either side of the clocks changing, weekly and monthly lists,
// check-in / check-out (which bookings count, their times, multi-stay keys),
// events by type and by pay bar (the office's tick beating the client's),
// ticketed events, viewings, cleans, offsets, fire_from, and when an open
// list is moved or cancelled — never on a failed or empty read, never once
// someone has ticked it.
//
//   node tests/checklists-plan-test.cjs

const assert = require("assert");
const P = require("../netlify/functions/checklists/plan.js");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + e.message); }
}
const iso = function(d) { return d.toISOString(); };
const NOW = new Date("2026-10-28T12:00:00Z");   // Wed 28 Oct 2026, GMT

const props = [{ id: "hamlet", name: "The Hamlet", checkInFrom: "16:00", checkOutBy: "10:00" },
               { id: "amly", name: "Amly Barn" }];
const tpl = function(trig, extra) {
  return Object.assign({ id: "T1", title: "List", trig: trig, fire_from: "2026-01-01T00:00:00Z" }, extra || {});
};
const plan = function(templates, data, openRuns) {
  return P.planChecklists({ now: NOW, state: { templates: templates, open_runs: openRuns || [] }, data: data });
};

console.log("\n— London time —");
t("BST: noon on 24 Oct is 11:00 UTC", function() { assert.equal(iso(P.londonToDate("2026-10-24", "12:00")), "2026-10-24T11:00:00.000Z"); });
t("GMT: noon on 26 Oct is 12:00 UTC", function() { assert.equal(iso(P.londonToDate("2026-10-26", "12:00")), "2026-10-26T12:00:00.000Z"); });
t("bad input is null", function() { assert.equal(P.londonToDate("2026-13-40", "12:00"), null); assert.equal(P.londonToDate("2026-10-26", "25:00"), null); });

console.log("\n— weekly, monthly, once —");
t("every Monday 09:00 → this Monday, 26 Oct", function() {
  const r = plan([tpl({ kind: "weekly", weekday: 1, time: "09:00" })], {});
  assert.equal(r.fire.length, 1);
  assert.equal(r.fire[0].anchor_key, "weekly:2026-10-26");
  assert.equal(r.fire[0].anchor_at, "2026-10-26T09:00:00.000Z");
});
t("every Wednesday 13:00, asked at noon Wednesday → last week's (BST), long since fired", function() {
  const a = P.anchorsFor({ kind: "weekly", weekday: 3, time: "13:00" }, {}, NOW).list[0];
  assert.equal(a.key, "weekly:2026-10-21");
  assert.equal(iso(a.at), "2026-10-21T12:00:00.000Z");
  assert.equal(plan([tpl({ kind: "weekly", weekday: 3, time: "13:00" })], {}).fire.length, 0);
});
t("the 1st of the month 09:00 → 1 Oct (BST)", function() {
  const a = P.anchorsFor({ kind: "monthly", day: 1, time: "09:00" }, {}, NOW).list[0];
  assert.equal(a.key, "monthly:2026-10");
  assert.equal(iso(a.at), "2026-10-01T08:00:00.000Z");
  const r = P.planChecklists({ now: new Date("2026-11-01T09:05:00Z"), state: { templates: [tpl({ kind: "monthly", day: 1, time: "09:00" })] }, data: {} });
  assert.equal(r.fire[0].anchor_key, "monthly:2026-11");
});
t("the 31st in a 30-day month is the 30th", function() {
  const r = P.planChecklists({ now: new Date("2026-11-30T20:00:00Z"), state: { templates: [tpl({ kind: "monthly", day: 31, time: "09:00" })] }, data: {} });
  assert.equal(r.fire[0].anchor_at, "2026-11-30T09:00:00.000Z");
});
t("fire_from: a weekly list made on Tuesday does not fire for Monday", function() {
  const r = plan([tpl({ kind: "weekly", weekday: 1, time: "09:00" }, { fire_from: "2026-10-27T10:00:00Z" })], {});
  assert.equal(r.fire.length, 0);
});
t("once, in the past since it was made → fires; in the future → not yet", function() {
  assert.equal(plan([tpl({ kind: "once", at: "2026-10-28T11:30" })], {}).fire.length, 1);
  assert.equal(plan([tpl({ kind: "once", at: "2026-10-28T12:30" })], {}).fire.length, 0);
});
t("manual never fires on its own", function() { assert.equal(plan([tpl({ kind: "manual" })], {}).fire.length, 0); });

console.log("\n— check-in and check-out —");
const accom = [
  { id: "A1", guestName: "Smith", status: "confirmed", stays: [{ propertyId: "hamlet", checkIn: "2026-10-28", checkOut: "2026-10-30" }] },
  { id: "A2", guestName: "Jones (Wed)", status: "confirmed", bookingType: "Wedding",
    stays: [{ propertyId: "amly", checkIn: "2026-10-28", checkOut: "2026-10-29" }, { propertyId: "amly", checkIn: "2026-11-01", checkOut: "2026-11-02" }] },
  { id: "A3", guestName: "Gone", status: "cancelled", stays: [{ propertyId: "hamlet", checkIn: "2026-10-28", checkOut: "2026-10-29" }] },
  { id: "A4", bookingType: "Blocked", status: "confirmed", stays: [{ propertyId: "hamlet", checkIn: "2026-10-28", checkOut: "2026-10-29" }] },
  { id: "A5", guestName: "Typed", status: "confirmed", stays: [{ propertyId: "hamlet", checkIn: "2026-10-28", checkOut: "2026-10-29", checkInTime: "13:00" }] }
];
t("12 hours before check-in: today's arrivals that have opened", function() {
  const r = plan([tpl({ kind: "checkin", property: null, offset_min: -720 })], { accom: accom, properties: props });
  const keys = r.fire.map(function(f) { return f.anchor_key; }).sort();
  assert.deepEqual(keys, ["in:A1:hamlet", "in:A2:amly", "in:A5:hamlet"]);
  const a1 = r.fire.find(function(f) { return f.anchor_key === "in:A1:hamlet"; });
  assert.equal(a1.anchor_at, "2026-10-28T16:00:00.000Z");
  assert.equal(a1.opens_at, "2026-10-28T04:00:00.000Z");
  assert.deepEqual(a1.link, { kind: "accom", id: "A1" });
  assert.ok(/The Hamlet · Smith · in Wed 28 Oct 16:00/.test(a1.context), a1.context);
});
t("a wedding stay checks in at 15:00; a typed time wins", function() {
  const r = plan([tpl({ kind: "checkin", offset_min: -720 })], { accom: accom, properties: props });
  assert.equal(r.fire.find(function(f) { return f.anchor_key === "in:A2:amly"; }).anchor_at, "2026-10-28T15:00:00.000Z");
  assert.equal(r.fire.find(function(f) { return f.anchor_key === "in:A5:hamlet"; }).anchor_at, "2026-10-28T13:00:00.000Z");
});
t("one property only", function() {
  const r = plan([tpl({ kind: "checkin", property: "amly", offset_min: -720 })], { accom: accom, properties: props });
  assert.deepEqual(r.fire.map(function(f) { return f.anchor_key; }), ["in:A2:amly"]);
});
t("a second stay at the same property has its own key", function() {
  const r = P.anchorsFor({ kind: "checkin" }, { accom: accom, properties: props }, NOW);
  assert.ok(r.list.some(function(a) { return a.key === "in:A2:amly:2"; }));
});
t("check-out at 10:00 plus 1 hour, not yet open on the 28th", function() {
  const r = plan([tpl({ kind: "checkout", offset_min: 60 })], { accom: accom, properties: props });
  assert.equal(r.fire.length, 0);
});

console.log("\n— events —");
const events = [
  { id: 1, couple: "Amy & Ben", eventType: "Wedding (Peak)", status: "Confirmed", date: "2026-10-28" },
  { id: 2, couple: "Sixty", eventType: "Party", status: "Confirmed", date: "2026-10-28", guestArrivalTime: "11:30" },
  { id: 3, couple: "Held", eventType: "Party", status: "Holding", date: "2026-10-28" },
  { id: 4, couple: "Dad", eventType: "Wake", status: "Confirmed", date: "2026-10-28", guestArrivalTime: "12:30/12:45 (at the tap room)" }
];
const evTrig = function(type, off) { return tpl({ kind: "event", event_type: type, offset_min: off || 0 }); };
t("default start times by type; a bare typed time wins; free text is ignored", function() {
  assert.equal(P.eventStartTime(events[0], {}), "12:00");
  assert.equal(P.eventStartTime(events[1], {}), "11:30");
  assert.equal(P.eventStartTime(events[3], {}), "12:00");
  assert.equal(P.eventStartTime(events[0], { startTimes: { wedding: "11:00" } }), "11:00");
});
t("weddings only; holding dates never", function() {
  const r = plan([evTrig("wedding")], { events: events, boxEvents: [] });
  assert.deepEqual(r.fire.map(function(f) { return f.anchor_key; }), ["event:1"]);
  const any = plan([evTrig("any")], { events: events, boxEvents: [] }).fire.map(function(f) { return f.anchor_key; });
  assert.deepEqual(any.sort(), ["event:1", "event:2", "event:4"]);
});
t("celebration of life matches a wake", function() {
  assert.deepEqual(plan([evTrig("celebration")], { events: events }).fire.map(function(f) { return f.anchor_key; }), ["event:4"]);
});
t("pay bar: the office's tick beats the client's, either way", function() {
  assert.equal(P.payBarFor({ pay_bar: true, staff_pay_bar: false }), false);
  assert.equal(P.payBarFor({ pay_bar: false, staff_pay_bar: true }), true);
  assert.equal(P.payBarFor({ pay_bar: true, staff_pay_bar: null }), true);
  assert.equal(P.payBarFor(null), false);
});
t("pay bar lists: diary events with a pay bar, and ticketed events ticked for one", function() {
  const r = plan([evTrig("paybar")], {
    events: events,
    drinks: [{ event_id: 1, pay_bar: true }, { event_id: 2, pay_bar: true, staff_pay_bar: false }, { event_id: 4, staff_pay_bar: true }],
    boxEvents: [{ id: "bx1", name: "Supper club", status: "published", starts_at: "2026-10-28T09:00:00Z", pay_bar: true },
                { id: "bx2", name: "No bar", status: "published", starts_at: "2026-10-28T09:00:00Z", pay_bar: false }]
  });
  assert.deepEqual(r.fire.map(function(f) { return f.anchor_key; }).sort(), ["box:bx1", "event:1", "event:4"]);
  assert.deepEqual(r.fire.find(function(f) { return f.anchor_key === "box:bx1"; }).link, { kind: "box", id: "bx1" });
});
t("start + 1 hour: a noon wedding's closing list has opened by 13:00, not before", function() {
  const at = function(h) { return P.planChecklists({ now: new Date("2026-10-28T" + h + ":00Z"),
    state: { templates: [evTrig("wedding", 60)] }, data: { events: events } }).fire.length; };
  assert.equal(at("12:59"), 0);
  assert.equal(at("13:00"), 1);
});

console.log("\n— viewings and cleans —");
t("viewings on enquiries and events, keyed by record and day", function() {
  const r = P.anchorsFor({ kind: "viewing" }, {
    enquiries: [{ id: "E1", name: "Kate", viewings: [{ date: "2026-10-28", time: "14:00" }, { date: "2026-10-28", time: "16:00" }] }],
    events: [{ id: 9, couple: "Rob", status: "Confirmed", viewings: [{ date: "2026-10-30", time: "" }] }]
  }, NOW);
  assert.deepEqual(r.list.map(function(a) { return a.key; }), ["viewing:enq:E1:2026-10-28", "viewing:enq:E1:2026-10-28:2", "viewing:evt:9:2026-10-30"]);
  assert.equal(iso(r.list[2].at), "2026-10-30T10:00:00.000Z");
  assert.equal(r.sure, true);
});
t("a viewing on both the enquiry and the booking it became is one list (the booking's)", function() {
  const r = P.anchorsFor({ kind: "viewing" }, {
    enquiries: [{ id: "E2", name: "Kate", email: "KATE@x.com", viewings: [{ date: "2026-10-29", time: "11:00" }, { date: "2026-11-05", time: "11:00" }] }],
    events: [{ id: 12, couple: "Kate & Sam", email: "kate@x.com", status: "Confirmed", viewings: [{ date: "2026-10-29", time: "11:00" }] }]
  }, NOW);
  assert.deepEqual(r.list.map(function(a) { return a.key; }).sort(), ["viewing:enq:E2:2026-11-05", "viewing:evt:12:2026-10-29"]);
});
t("cleaned: any, or one property; the sign-off's time", function() {
  const co = [{ id: "accom:A1:hamlet", kind: "accom", refId: "A1", unitId: "hamlet", unitName: "The Hamlet", doneAt: "2026-10-28T11:15" },
              { id: "event:1", kind: "event", refId: 1, unitId: "grainstore", unitName: "Grain Store", doneAt: "2026-10-28T09:00" },
              { id: "accom:A9:amly", kind: "accom", refId: "A9", unitId: "amly" }];
  const all = plan([tpl({ kind: "cleaned", property: null })], { changeovers: co });
  assert.equal(all.fire.length, 2);
  const one = plan([tpl({ kind: "cleaned", property: "grainstore" })], { changeovers: co });
  assert.deepEqual(one.fire.map(function(f) { return f.anchor_key; }), ["clean:event:1"]);
  assert.deepEqual(one.fire[0].link, { kind: "event", id: "1" });
});
t("an old clean (over three days) does not fire", function() {
  const r = plan([tpl({ kind: "cleaned" })], { changeovers: [{ id: "x", kind: "accom", refId: "A", unitId: "hamlet", doneAt: "2026-10-20T10:00" }] });
  assert.equal(r.fire.length, 0);
});

console.log("\n— moving and cancelling open lists —");
const openRun = function(key, at, extra) {
  return Object.assign({ id: "R-" + key, template_id: "T1", anchor_key: key, anchor_at: at, context: "x", touched: false }, extra || {});
};
t("a booking that has gone: its untouched list is cancelled", function() {
  const r = plan([tpl({ kind: "checkin", offset_min: -720 })], { accom: accom, properties: props }, [openRun("in:GONE:hamlet", "2026-10-28T16:00:00Z")]);
  assert.deepEqual(r.cancel, ["R-in:GONE:hamlet"]);
});
t("…but not once someone has ticked something", function() {
  const r = plan([tpl({ kind: "checkin", offset_min: -720 })], { accom: accom, properties: props }, [openRun("in:GONE:hamlet", "2026-10-28T16:00:00Z", { touched: true })]);
  assert.deepEqual(r.cancel, []);
});
t("a failed read cancels nothing", function() {
  const r = plan([tpl({ kind: "checkin", offset_min: -720 })], { accom: null, properties: props }, [openRun("in:GONE:hamlet", "2026-10-28T16:00:00Z")]);
  assert.deepEqual(r.cancel, []);
  assert.equal(r.notes.length, 1);
});
t("an empty list read cancels nothing either", function() {
  const r = plan([tpl({ kind: "checkin" })], { accom: [], properties: props }, [openRun("in:GONE:hamlet", "2026-10-28T16:00:00Z")]);
  assert.deepEqual(r.cancel, []);
});
t("pay bar unticked: that event's untouched bar list is cancelled", function() {
  const r = plan([evTrig("paybar")], { events: events, drinks: [{ event_id: 1, pay_bar: true, staff_pay_bar: false }], boxEvents: [] },
    [openRun("event:1", "2026-10-28T12:00:00Z")]);
  assert.deepEqual(r.cancel, ["R-event:1"]);
});
t("a pay bar list is not cancelled when the drinks read failed", function() {
  const r = plan([evTrig("paybar")], { events: events, drinks: null, boxEvents: [] }, [openRun("event:1", "2026-10-28T12:00:00Z")]);
  assert.deepEqual(r.cancel, []);
});
t("a moved check-in moves its list", function() {
  const r = plan([tpl({ kind: "checkin", offset_min: -720 })], { accom: accom, properties: props },
    [openRun("in:A1:hamlet", "2026-10-27T16:00:00Z")]);
  assert.equal(r.retime.length, 1);
  assert.equal(r.retime[0].anchor_at, "2026-10-28T16:00:00.000Z");
  assert.equal(r.retime[0].opens_at, "2026-10-28T04:00:00.000Z");
});
t("weekly lists are never moved or cancelled by the plan", function() {
  const r = plan([tpl({ kind: "weekly", weekday: 1, time: "09:00" })], {}, [openRun("weekly:2026-10-19", "2026-10-19T08:00:00Z")]);
  assert.deepEqual(r.cancel, []);
  assert.deepEqual(r.retime, []);
});

console.log("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
