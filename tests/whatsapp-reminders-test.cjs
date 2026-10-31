// WhatsApp: templates, the plans (who, when, what), and the sending run.
// node tests/whatsapp-reminders-test.cjs
const assert = require("assert");
const T = require("../netlify/functions/whatsapp-reminders/templates.js");
const P = require("../netlify/functions/whatsapp-reminders/plan.js");
const at = function (iso) { return new Date(iso); };

// ── Templates ────────────────────────────────────────────────────────────────
Object.keys(T.TEMPLATES).forEach(function (n) {
  const c = T.checkBody(n, T.TEMPLATES[n].body);
  assert.ok(c.ok, n + ": standard wording must pass Meta's rules: " + c.error);
  const built = T.components(n, T.TEMPLATES[n].body);
  assert.ok(built.components[0].text.indexOf("{{1}}") !== -1 || !c.order.length);
  assert.strictEqual(built.components[1].text, T.footerOf(n));
  assert.ok(T.footerOf(n).length <= 60);
  if (c.order.length) assert.strictEqual(built.components[0].example.body_text[0].length, c.order.length);
});
assert.strictEqual(T.checkBody("pre_arrival", "{{guestName}} hello there").ok, false, "may not start with a field");
assert.strictEqual(T.checkBody("pre_arrival", "Hello {{guestName}}").ok, false, "may not end with a field");
assert.strictEqual(T.checkBody("pre_arrival", "Hello {{guestName}}.").ok, false, "a full stop after it still ends with it");
assert.strictEqual(T.checkBody("pre_arrival", "Hello {{nobody}} there").ok, false, "unknown field");
assert.strictEqual(T.checkBody("pre_arrival", "Hi {{guestName}} {{property}} ok").ok, false, "side by side");
assert.strictEqual(T.checkBody("pre_arrival", "x".repeat(1025)).ok, false, "too long");
// Named → numbered in first-appearance order; repeats share a number.
const c1 = T.checkBody("pre_arrival", "Hi {{property}} and {{guestName}}, see {{property}} soon");
assert.deepStrictEqual(c1.order, ["property", "guestName"]);
assert.strictEqual(T.toNumbered("Hi {{property}} and {{guestName}}, see {{property}} soon", c1.order), "Hi {{1}} and {{2}}, see {{1}} soon");
// Sending follows the SUBMITTED order, not the standard wording's.
assert.deepStrictEqual(T.sendOrder("pre_arrival", { order: ["property", "guestName"] }), ["property", "guestName"]);
assert.deepStrictEqual(T.sendOrder("pre_arrival", null).slice(0, 2), ["guestName", "property"]);
assert.strictEqual(T.render("Hi {{guestName}}!", { guestName: "Emma" }), "Hi Emma!");
assert.strictEqual(T.cleanParam("a\nb\t c     d"), "a b c d");
assert.strictEqual(T.cleanParam(""), "—");

// ── Quiet hours: nothing 10pm–8am, London time ───────────────────────────────
assert.strictEqual(P.isQuiet(at("2026-10-30T21:59:00Z")), false);   // 9:59pm GMT
assert.strictEqual(P.isQuiet(at("2026-10-30T22:00:00Z")), true);
assert.strictEqual(P.isQuiet(at("2026-10-31T07:59:00Z")), true);
assert.strictEqual(P.isQuiet(at("2026-10-31T08:00:00Z")), false);
assert.strictEqual(P.isQuiet(at("2026-07-01T07:30:00Z")), false, "8:30am BST");

// ── Checklists ───────────────────────────────────────────────────────────────
const TOBY = "2450dade-861f-4cba-af54-391282894028", ROS = "df4f70ec-1a92-4476-abfc-4db71954452d", LISA = "116492da-d0ab-4528-99b0-fdf28311deed";
const people = { [TOBY]: { name: "Toby", mobile: "447900683355" }, [ROS]: { name: "Rosanna Greenwood", mobile: "447000000001" }, [LISA]: { name: "Lisa", mobile: null } };
const runs = [{ id: "run1", template_id: "tplA", title: "Arrival", context: "Emma Juner letting", status: "open", opens_at: "2026-10-30T09:00:00Z" },
              { id: "run2", template_id: "tplB", title: "Closed", status: "done", opens_at: "2026-10-30T09:00:00Z" }];
const items = [
  { run_id: "run1", title: "Heating on", who: "person:" + TOBY, due_at: "2026-10-30T15:00:00Z", position: 2, state: "open" },
  { run_id: "run1", title: "Welcome hamper", who: "person:" + TOBY, due_at: "2026-10-30T14:00:00Z", position: 1, state: "open" },
  { run_id: "run1", title: "Done one", who: "person:" + TOBY, due_at: "2026-10-30T10:00:00Z", position: 0, state: "done" },
  { run_id: "run1", title: "Bar float", who: "role:bar", due_at: "2026-10-30T14:00:00Z", position: 3, state: "open" },
  { run_id: "run1", title: "Anyone thing", who: "anyone", due_at: "2026-10-30T14:00:00Z", position: 4, state: "open" },
  { run_id: "run1", title: "Rosanna's", who: "person:" + ROS, due_at: "2026-10-30T16:00:00Z", position: 5, state: "open" },
  { run_id: "run1", title: "Lisa's", who: "person:" + LISA, due_at: "2026-10-30T16:00:00Z", position: 6, state: "open" },
  { run_id: "run2", title: "On a done list", who: "person:" + TOBY, due_at: "2026-10-30T14:00:00Z", position: 0, state: "open" }
];
const ck = function (now, extra) {
  return P.planChecklists(Object.assign({ runs, items, people, ticks: {}, on: { live: true, overdue: true }, sent: new Set(), now: at(now) }, extra || {}));
};
let p = ck("2026-10-30T09:05:00Z");
let live = p.send.filter(function (x) { return x.template === "checklist_live"; });
assert.deepStrictEqual(live.map(function (x) { return x.toName; }).sort(), ["Rosanna Greenwood", "Toby"], "named people only; Lisa has no mobile");
const tl = live.filter(function (x) { return x.toName === "Toby"; })[0];
assert.deepStrictEqual(tl.values, { list: "Arrival – Emma Juner letting", count: "2 items", due: "2:00pm today", items: "Welcome hamper · Heating on", name: "Toby" });
assert.strictEqual(tl.key, "live|run1|" + TOBY);
assert.strictEqual(live.filter(function (x) { return x.toName === "Rosanna Greenwood"; })[0].values.name, "Rosanna");
assert.deepStrictEqual(p.noMobile.map(function (x) { return x.name; }), ["Lisa"]);
assert.strictEqual(p.send.filter(function (x) { return x.template === "checklist_overdue"; }).length, 0, "nothing overdue yet");
// Overdue: Toby's hamper (2pm) has passed; only the overdue ones listed.
p = ck("2026-10-30T14:20:00Z");
const od = p.send.filter(function (x) { return x.template === "checklist_overdue"; });
assert.strictEqual(od.length, 1);
assert.deepStrictEqual(od[0].values, { list: "Arrival – Emma Juner letting", count: "1 item", items: "Welcome hamper", name: "Toby" });
// Already sent: not again.
p = ck("2026-10-30T14:35:00Z", { sent: new Set(["overdue|run1|" + TOBY, "live|run1|" + TOBY, "live|run1|" + ROS]) });
assert.strictEqual(p.send.length, 0);
// The list's ticks suppress each one.
p = ck("2026-10-30T14:20:00Z", { ticks: { tplA: { live: false, overdue: false } } });
assert.strictEqual(p.send.length, 0);
p = ck("2026-10-30T14:20:00Z", { ticks: { tplA: { live: false } } });
assert.deepStrictEqual(p.send.map(function (x) { return x.template; }), ["checklist_overdue"]);
// The template switches.
p = ck("2026-10-30T14:20:00Z", { on: { live: true, overdue: false } });
assert.ok(p.send.every(function (x) { return x.template === "checklist_live"; }));
// A list that opened in the night is still announced at 8am; one that opened
// more than 14 hours ago is not (no backlog when switched on).
p = P.planChecklists({ runs: [Object.assign({}, runs[0], { opens_at: "2026-10-30T02:00:00Z" })], items, people, on: { live: true }, sent: new Set(), now: at("2026-10-30T08:00:00Z") });
assert.strictEqual(p.send.length, 2);
p = P.planChecklists({ runs: [Object.assign({}, runs[0], { opens_at: "2026-10-29T17:00:00Z" })], items, people, on: { live: true }, sent: new Set(), now: at("2026-10-30T08:00:00Z") });
assert.strictEqual(p.send.length, 0);
// Switched-off login: nothing.
p = ck("2026-10-30T09:05:00Z", { people: Object.assign({}, people, { [TOBY]: { name: "Toby", mobile: "447900683355", active: false } }) });
assert.ok(p.send.every(function (x) { return x.toName !== "Toby"; }));

// ── Pre-arrival ──────────────────────────────────────────────────────────────
const properties = [{ id: "hamlet", name: "The Hamlet", checkInFrom: "16:00", checkOutBy: "10:00" },
                    { id: "amly", name: "Amly Barn", checkInFrom: "16:00", checkOutBy: "10:00", checkInFromWedding: "15:00", checkOutByWedding: "11:00" }];
const accom = [
  { id: "a12345", guestName: "Emma Juner", phone: "07900 683355", status: "confirmed", source: "direct", stays: [{ propertyId: "hamlet", checkIn: "2026-10-31", checkOut: "2026-11-02" }] },
  { id: "a2", guestName: "No Phone", phone: "", status: "confirmed", source: "direct", stays: [{ propertyId: "amly", checkIn: "2026-10-31", checkOut: "2026-11-01" }] },
  { id: "a3", guestName: "Said No", phone: "07000000003", waConsent: false, status: "confirmed", stays: [{ propertyId: "amly", checkIn: "2026-10-31", checkOut: "2026-11-01" }] },
  { id: "a4", guestName: "Airbnb Guest", phone: "07000000004", source: "airbnb", status: "confirmed", stays: [{ propertyId: "amly", checkIn: "2026-10-31", checkOut: "2026-11-01" }] },
  { id: "a5", guestName: "Airbnb Ticked", phone: "07000000005", source: "airbnb", waConsent: true, status: "confirmed", bookingType: "Wedding", stays: [{ propertyId: "amly", checkIn: "2026-10-31", checkOut: "2026-11-01" }] },
  { id: "a6", guestName: "Cancelled", phone: "07000000006", status: "cancelled", stays: [{ propertyId: "amly", checkIn: "2026-10-31", checkOut: "2026-11-01" }] },
  { id: "a7", guestName: "Tomorrow", phone: "07000000007", status: "confirmed", stays: [{ propertyId: "amly", checkIn: "2026-11-01", checkOut: "2026-11-02" }] },
  { id: "a8", guestName: "Two Places", phone: "07000000008", status: "confirmed", stays: [{ propertyId: "hamlet", checkIn: "2026-10-31", checkOut: "2026-11-01" }, { propertyId: "amly", checkIn: "2026-10-31", checkOut: "2026-11-03", checkInTime: "14:00" }] }
];
p = P.planArrivals({ accom, properties, now: at("2026-10-31T09:05:00Z"), sent: new Set() });
assert.deepStrictEqual(p.send.map(function (x) { return x.record.id; }).sort(), ["a12345", "a5", "a8"]);
const em = p.send.filter(function (x) { return x.record.id === "a12345"; })[0];
assert.strictEqual(em.to, "447900683355");
assert.strictEqual(em.key, "arrival|a12345|2026-10-31");
assert.deepStrictEqual(em.values, { guestName: "Emma", property: "The Hamlet", gateCode: "—", arrivalPack: "https://www.hawthbushfarm.co.uk",
  checkInTime: "4:00pm", checkOutDate: "Monday 2 November", checkOutTime: "10:00am", nights: "2 nights", bookingRef: "A12345" });
assert.deepStrictEqual(em.payloads, ["eta|a12345@2026-10-31|0", "eta|a12345@2026-10-31|1", "eta|a12345@2026-10-31|2"]);
// Gate code and each property's pack link; the day-before option.
const arrivalSet = { gateCode: "4321", packs: { amly: "https://example.com/amly.pdf", hamlet: "https://example.com/hamlet.pdf" } };
let pa = P.planArrivals({ accom, properties, arrival: arrivalSet, now: at("2026-10-31T09:05:00Z"), sent: new Set() });
const em2 = pa.send.filter(function (x) { return x.record.id === "a12345"; })[0];
assert.strictEqual(em2.values.gateCode, "4321");
assert.strictEqual(em2.values.arrivalPack, "https://example.com/hamlet.pdf");
assert.strictEqual(pa.send.filter(function (x) { return x.record.id === "a8"; })[0].values.arrivalPack, "https://example.com/hamlet.pdf", "first property with a pack");
pa = P.planArrivals({ accom, properties, arrival: { daysBefore: 1 }, now: at("2026-10-31T09:05:00Z"), sent: new Set() });
assert.deepStrictEqual(pa.send.map(function (x) { return x.record.id; }), ["a7"], "the day before: tomorrow's arrivals");
assert.strictEqual(pa.send[0].key, "arrival|a7|2026-11-01");
// Payloads read back.
assert.deepStrictEqual(T.parseEtaPayload("eta|a12345@2026-10-31|1"), { bookingId: "a12345", date: "2026-10-31", index: 1, label: "6pm to 9pm" });
assert.strictEqual(T.parseEtaPayload("eta|a1|1"), null);
assert.deepStrictEqual(T.buttonLabels("pre_arrival"), ["Before 6pm", "6pm to 9pm", "After 9pm"]);
assert.ok(T.TEMPLATES.pre_arrival.quickReplies.every(function (q) { return q.length <= 25; }));
const qr = T.components("pre_arrival", T.TEMPLATES.pre_arrival.body).components[2];
assert.deepStrictEqual(qr.buttons.map(function (b) { return b.type; }), ["QUICK_REPLY", "QUICK_REPLY", "QUICK_REPLY"]);
const wed = p.send.filter(function (x) { return x.record.id === "a5"; })[0];
assert.strictEqual(wed.values.checkInTime, "3:00pm", "wedding times");
const two = p.send.filter(function (x) { return x.record.id === "a8"; })[0];
assert.strictEqual(two.values.property, "The Hamlet and Amly Barn");
assert.strictEqual(two.values.checkOutDate, "Tuesday 3 November", "the last check-out");
assert.deepStrictEqual(p.skipped.map(function (x) { return x.why; }).sort(), ["no mobile", "not agreed", "not agreed"]);
p = P.planArrivals({ accom, properties, now: at("2026-10-31T09:05:00Z"), sent: new Set(["arrival|a12345|2026-10-31"]) });
assert.ok(p.send.every(function (x) { return x.record.id !== "a12345"; }), "once per booking per arrival");

// ── Changeover summary ───────────────────────────────────────────────────────
const setups = [
  { id: "note:accom:a12345", kind: "note", of: "accom", refId: "a12345", text: "Cot\nplease" },
  { id: "setup:accom:a8", kind: "accom", refId: "a8" },
  { id: "noexit:accom:a7", kind: "noexit", of: "accom", refId: "a7" },
  { id: "note:event:7", kind: "note", of: "event", refId: 7, text: "Chairs out" }
];
const events = [{ id: 7, couple: "Smith", eventType: "Wedding (Peak)", date: "2026-11-01", endDate: "2026-11-02", status: "Confirmed" },
                { id: 8, couple: "Maybe", eventType: "Party", date: "2026-11-01", status: "Holding" }];
const boxEvents = [{ id: "bx1", name: "Supper club", status: "published", starts_at: "2026-11-03T19:30:00Z" },
                   { id: "bx2", name: "Draft one", status: "draft", starts_at: "2026-11-03T19:30:00Z" }];
const wk = P.summaryItems({ accom, properties, events, boxEvents, setups }, "2026-10-31", 7);
assert.strictEqual(wk.length, 7, "seven days (31 Oct, Toby)");
const words = function (d) { return d.items.map(P.itemWords); };
assert.strictEqual(words(wk[0])[0], "Juner into Hamlet (Cot\nplease)", "the note as written; weekText takes out the line break");
assert.ok(words(wk[0]).indexOf("Places into Hamlet (extra clean)") !== -1, words(wk[0]).join(" / "));
assert.ok(words(wk[1]).some(function (w) { return /^\w+ out of Hamlet/.test(w); }), words(wk[1]).join(" / "));
assert.ok(words(wk[1]).indexOf("Grain Store: Smith wedding (Chairs out)") !== -1, words(wk[1]).join(" / "));
assert.ok(words(wk[1]).every(function (w) { return w.indexOf("Maybe") === -1; }), "holding events left out");
// Check-outs before check-ins, then the Grain Store.
const rank = { out: 0, in: 1, event: 2, box: 2 };
wk.forEach(function (d) { d.items.forEach(function (it, i) { if (i) assert.ok(rank[d.items[i - 1].kind] <= rank[it.kind], d.day + ": " + d.items.map(function (x) { return x.kind; })); }); });
assert.ok(words(wk[2]).some(function (w) { return /out of \w+ \(no clean\)/.test(w); }), words(wk[2]).join(" / "));
assert.ok(words(wk[3]).indexOf("Grain Store: Supper club 7:30pm") !== -1 && words(wk[3]).join().indexOf("Draft") === -1, words(wk[3]).join(" / "));
assert.strictEqual(P.summaryItems({ accom: [{ id: "w", guestName: "Jones (Wed)", status: "confirmed", stays: [{ propertyId: "amly", checkIn: "2026-10-31", checkOut: "2026-11-01" }] }], properties }, "2026-10-31", 1)[0].items[0].text,
  "Jones into Amly", "wedding-cottage names lose the (Wed)");
// Early check-in / late check-out on the booking show in the summary.
const el = P.summaryItems({ accom: [{ id: "e", guestName: "Kim Early", status: "confirmed", earlyCheckIn: "15:00", lateCheckOut: "12:00",
  arrivalEta: { text: "After 9pm", date: "2026-10-31" },
  stays: [{ propertyId: "amly", checkIn: "2026-10-31", checkOut: "2026-11-01", checkInTime: "15:00", checkOutTime: "12:00" }] }], properties }, "2026-10-31", 2);
assert.deepStrictEqual(el.map(function (d) { return d.items.map(P.itemWords); }), [["Early into Amly (early 3pm)"], ["Early out of Amly (late 12pm)"]]);
assert.strictEqual(el[0].items[0].time, "3pm");
assert.strictEqual(el[0].items[0].eta, "After 9pm", "the guests' arrival time, for the page");
// The pre-arrival WhatsApp picks up the early time from the stay.
const ea = P.planArrivals({ accom: [{ id: "e", guestName: "Kim Early", phone: "07700900111", status: "confirmed", earlyCheckIn: "15:00",
  stays: [{ propertyId: "amly", checkIn: "2026-10-31", checkOut: "2026-11-01", checkInTime: "15:00" }] }], properties, now: at("2026-10-31T09:05:00Z"), sent: new Set() });
assert.strictEqual(ea.send[0].values.checkInTime, "3:00pm");
// The whole week in one field: busy days only, no line breaks.
const wt = P.weekText(wk, 2000);
assert.ok(wt.startsWith("Sat 31 Oct – Juner into Hamlet (Cot please); "), wt);
assert.ok(/ \| Sun 1 Nov – /.test(wt), wt);
assert.ok(!/[\n\t]/.test(wt));
const quiet = wk.filter(function (d) { return !d.items.length; });
quiet.forEach(function (d) { assert.ok(wt.indexOf(P.dayShort(d.day)) === -1, "quiet day left out: " + d.day); });
assert.strictEqual(P.weekText([{ day: "2026-11-01", items: [] }]), "Nothing booked this week");
const cut = P.weekText(wk, 120);
assert.ok(cut.length <= 120 && / … and more on the plan$/.test(cut), cut);
// Meta's rules: the template passes, and the whole body fits at full length.
assert.ok(T.checkBody("changeover_summary", T.TEMPLATES.changeover_summary.body).ok);
const fixed = T.TEMPLATES.changeover_summary.body.replace(/\{\{[^}]*\}\}/g, "").length;
const cap = P.weekCap(fixed);
const longBody = T.render(T.TEMPLATES.changeover_summary.body, { name: "x".repeat(40), week: P.weekText(Array(7).fill(0).map(function (x, i) {
  return { day: P.addDays("2026-11-01", i), items: Array(6).fill({ kind: "in", text: "Longname into Glamping", flags: ["extra clean"], note: "a long note about the hot tub and the logs" }) };
}), cap) });
assert.ok(longBody.length <= 1024, "summary body " + longBody.length);
assert.ok(cap >= 600, "room enough to read: " + cap);
// The plan link: a URL button ending in the day sent + its key; refused when wrong.
const btn = T.components("changeover_summary", T.TEMPLATES.changeover_summary.body).components[2].buttons[0];
assert.strictEqual(btn.url, "https://hawthbushfarm.netlify.app/plan/{{1}}");
assert.ok(Array.isArray(btn.example) && /\/plan\/2026-11-01-/.test(btn.example[0]));
assert.strictEqual(T.planLinkDay(T.planSuffix("2026-11-01", "sek"), "sek"), "2026-11-01");
assert.strictEqual(T.planLinkDay(T.planSuffix("2026-11-01", "sek"), "other"), null);
assert.strictEqual(T.planLinkDay("2026-11-02-" + T.planKey("2026-11-01", "sek"), "sek"), null, "the day is part of the key");
// Footers: the shared one, and pre-arrival's own (a tap is saved at once).
assert.ok(T.footerOf("changeover_summary").length <= 60 && T.footerOf("pre_arrival").length <= 60);
assert.strictEqual(T.components("pre_arrival", T.TEMPLATES.pre_arrival.body).components[1].text, "Urgent? Call 01825 212020");
assert.ok(/All the best,\nRosanna\n\nIt would be great/.test(T.TEMPLATES.pre_arrival.body), "the question sits right above the buttons");
const sumIn = { accom, properties, events, boxEvents, setups, planSuffix: function (d) { return T.planSuffix(d, "sek"); },
  settings: { day: 0, hour: 8, recipients: [{ name: "Karina", mobile: "07111 222333" }, { name: "Edita", mobile: "" }] } };
p = P.planSummary(Object.assign({ now: at("2026-11-01T07:30:00Z") }, sumIn));   // Sunday 7:30am
assert.strictEqual(p.send.length, 0, "before the hour");
p = P.planSummary(Object.assign({ now: at("2026-11-01T08:15:00Z") }, sumIn));
assert.strictEqual(p.send.length, 1);
assert.strictEqual(p.send[0].to, "447111222333");
assert.strictEqual(p.send[0].values.name, "Karina");
assert.ok(/^Sun 1 Nov – /.test(p.send[0].values.week), p.send[0].values.week);
assert.deepStrictEqual(Object.keys(p.send[0].values).sort(), ["name", "week"]);
assert.strictEqual(T.planLinkDay(p.send[0].urlSuffix, "sek"), "2026-11-01");
assert.deepStrictEqual(p.skipped, [{ name: "Edita", why: "no mobile" }]);
p = P.planSummary(Object.assign({ now: at("2026-11-02T08:15:00Z") }, sumIn));    // Monday
assert.strictEqual(p.send.length, 0, "only on the chosen day");

// The plan page: escapes everything, busy days only, quiet days named.
const HP = require("../netlify/functions/hk-plan.js")._test;
const html = HP.render([{ day: "2026-11-01", items: [{ kind: "in", text: "O'Neil <b> into Hamlet", time: "4pm", flags: ["extra clean"], note: "Cot <script>", eta: "After 9pm" }] },
  { day: "2026-11-02", items: [] }], "Sun 8:15 am");
assert.ok(html.indexOf("<script>") === -1 && html.indexOf("&lt;script&gt;") !== -1 && html.indexOf("O&#39;Neil &lt;b&gt;") !== -1);
assert.ok(/Sunday 1 November/.test(html) && /arriving After 9pm/.test(html) && /Nothing booked: Mon 2 Nov\./.test(html));
assert.strictEqual(HP.PAGE_DAYS, 10, "the page looks 10 days ahead; the WhatsApp 7");
assert.strictEqual(P.SUMMARY_DAYS, 7);

console.log("whatsapp plans and templates: all tests passed");

// ── The sending run, fetch faked ─────────────────────────────────────────────
(async function () {
  process.env.SUPABASE_SERVICE_KEY = "svc"; process.env.WHATSAPP_TOKEN = "tok";
  const { _test } = require("../netlify/functions/whatsapp-reminders/whatsapp-reminders.js");
  const marks = new Set(); let refuse = false; const sent = []; const logged = [];
  let settings = { templates: { checklist_live: { on: true }, checklist_overdue: { on: true }, pre_arrival: { on: true }, changeover_summary: { on: false } } };
  const submitted = { pre_arrival: { body: "Hello {{guestName}}, see you at {{property}} today.", order: ["guestName", "property"] } };
  global.fetch = async function (url, o) {
    o = o || {};
    const ok = function (b) { return { ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) }; };
    const key = (/app_data\?key=eq\.([^&]+)/.exec(url) || [])[1];
    if (key === "hbf_whatsapp_settings_v1") return ok([{ value: settings }]);
    if (key === "hbf_whatsapp_submitted_v1") return ok([{ value: submitted }]);
    if (key === "hbf_accom_v1") return ok([{ value: accom }]);
    if (key === "hbf_properties_v1") return ok([{ value: properties }]);
    if (key === "hbf_email_templates_v1") return ok([{ value: [] }]);
    if (url.includes("/chk_runs?")) return ok([runs[0]]);
    if (url.includes("/chk_run_items?")) return ok(items.filter(function (i) { return i.run_id === "run1"; }));
    if (url.includes("/profiles?")) return ok(Object.keys(people).map(function (id) { return Object.assign({ id: id }, people[id]); }));
    if (url.includes("/wa_sent_marks?kind=eq.") && (!o.method || o.method === "GET")) {
      const kind = decodeURIComponent(/kind=eq\.([^&]+)/.exec(url)[1]);
      return ok([...marks].filter(function (m) { return m.startsWith(kind + "|"); }).map(function (m) { return { ref: m.slice(kind.length + 1) }; }));
    }
    if (url.includes("/wa_sent_marks?on_conflict")) {
      const r = JSON.parse(o.body)[0]; const k = r.kind + "|" + r.ref;
      if (marks.has(k)) return ok([]); marks.add(k); return ok([r]);
    }
    if (url.includes("/wa_sent_marks?kind=eq.")) {
      if (o.method === "DELETE") { const m = /kind=eq\.([^&]+)&ref=eq\.(.+)$/.exec(url); marks.delete(decodeURIComponent(m[1]) + "|" + decodeURIComponent(m[2])); }
      return ok(null);
    }
    if (url.includes("/wa_messages")) { logged.push(JSON.parse(o.body)); return ok(null); }
    if (url.includes("graph.facebook.com")) {
      const b = JSON.parse(o.body);
      if (refuse && b.template.name === "pre_arrival") return { ok: false, status: 404, json: async () => ({ error: { code: 132001, message: "(#132001) Template name does not exist" } }) };
      sent.push(b); return ok({ messages: [{ id: "wamid." + sent.length }] });
    }
    throw new Error("unexpected " + url);
  };
  // Quiet hours: nothing at all.
  let r = await _test.runOnce(at("2026-10-31T23:00:00Z"));
  assert.ok(r.quiet && sent.length === 0);
  // 9:05am Saturday: checklist live (opened 09:00 the day before is >14h? no — move it), arrivals.
  runs[0].opens_at = "2026-10-31T09:00:00Z";
  items.forEach(function (i) { if (i.due_at) i.due_at = i.due_at.replace("2026-10-30", "2026-10-31"); });
  refuse = true;
  r = await _test.runOnce(at("2026-10-31T09:05:00Z"));
  assert.deepStrictEqual(r.notApproved, ["pre_arrival"], "an unapproved template stops only itself");
  assert.ok(sent.every(function (b) { return b.template.name !== "pre_arrival"; }));
  assert.strictEqual(sent.filter(function (b) { return b.template.name === "checklist_live"; }).length, 2);
  assert.ok([...marks].every(function (m) { return !m.startsWith("arrival|"); }), "refused: unmarked");
  refuse = false;
  r = await _test.runOnce(at("2026-10-31T09:20:00Z"));
  const arr = sent.filter(function (b) { return b.template.name === "pre_arrival"; });
  assert.strictEqual(arr.length, 3, "three arrivals today");
  const emma = arr.filter(function (b) { return b.to === "447900683355"; })[0];
  assert.deepStrictEqual(emma.template.components[0].parameters.map(function (x) { return x.text; }), ["Emma", "The Hamlet"], "filled in the SUBMITTED order");
  assert.deepStrictEqual(emma.template.components.slice(1), [0, 1, 2].map(function (i) {
    return { type: "button", sub_type: "quick_reply", index: String(i), parameters: [{ type: "payload", payload: "eta|a12345@2026-10-31|" + i }] };
  }), "each button carries the booking");
  const emmaLog = logged.filter(function (l) { return l.number === "447900683355" && l.template === "pre_arrival"; })[0];
  assert.strictEqual(emmaLog.body, "Hello Emma, see you at The Hamlet today.", "the log keeps the text as read");
  assert.strictEqual(emmaLog.to_name, "Emma Juner");
  const before = sent.length;
  r = await _test.runOnce(at("2026-10-31T09:35:00Z"));
  assert.strictEqual(sent.length, before, "nothing twice");
  // Switched off: nothing.
  settings = { templates: {} };
  marks.clear();
  r = await _test.runOnce(at("2026-10-31T09:50:00Z"));
  assert.strictEqual(sent.length, before);
  console.log("whatsapp sending run: all tests passed");
})().then(planLinkButton).catch(function (e) { console.error(e); process.exit(1); });

// ── The summary's plan link goes out as the URL button's value ───────────────
// Run after the sending run, which fakes fetch too.
async function planLinkButton() {
  process.env.WHATSAPP_TOKEN = "tok";
  const { _test } = require("../netlify/functions/whatsapp-reminders/whatsapp-reminders.js");
  const T2 = require("../netlify/functions/whatsapp-reminders/templates.js");
  const realFetch = global.fetch; let body = null;
  global.fetch = async function (url, o) { body = JSON.parse(o.body); return { ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.1" }] }) }; };
  try {
    await _test.sendTemplate("changeover_summary", "447111222333", ["name", "week"], { name: "Karina", week: "Sun 1 Nov – x" }, null, T2.planSuffix("2026-11-01", "sek"));
    const comps = body.template.components;
    assert.deepStrictEqual(comps[0].parameters.map(function (p) { return p.text; }), ["Karina", "Sun 1 Nov – x"]);
    assert.deepStrictEqual(comps[1], { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: T2.planSuffix("2026-11-01", "sek") }] });
    await assert.rejects(_test.sendTemplate("changeover_summary", "447111222333", ["name", "week"], { name: "K", week: "w" }, null, ""), /No link/);
    // Pre-arrival: no URL button, quick replies from index 0.
    await _test.sendTemplate("pre_arrival", "447111222333", ["guestName"], { guestName: "Emma" }, ["eta|a@2026-11-01|0", "eta|a@2026-11-01|1", "eta|a@2026-11-01|2"]);
    assert.deepStrictEqual(body.template.components.slice(1).map(function (c) { return c.sub_type + c.index; }), ["quick_reply0", "quick_reply1", "quick_reply2"]);
  } finally { global.fetch = realFetch; }
  console.log("whatsapp plan link button: all tests passed");
}
