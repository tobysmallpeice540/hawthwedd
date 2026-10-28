// The automatic follow-ups, pinned (netlify/functions/automations.js).
//
//   · Everything is off until switched on, rule by rule.
//   · A follow-up goes only to an enquiry with no contact since it arrived,
//     inside its window, once; never to one booked, lost, opted out, or with a
//     viewing to come.
//   · The second follow-up counts our own first as the last touch; the third
//     goes only after the second; each once, one email a day at most.
//   · "Mark Freezing" (on the second or third): X Gmail-confirmed quiet days
//     after the last of them, nothing since — the enquiry's temperature is set
//     to freezing, once, on a fresh read written only if nobody saved since.
//     A Freezing enquiry is never emailed.
//   · The run checks the farm Gmail itself for the addresses it may act on,
//     and falls back to the app's cache if it cannot.
//   · Nothing old is touched when a rule is first switched on.
//   · Quiet days count only up to the day Gmail last checked the address,
//     never up to today; an address never checked is never followed up.
const { _test: A } = require("../netlify/functions/automations.js");

let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { pass++; console.log("  ok   " + label); } else { fail++; console.log("  FAIL " + label); } }
function eq(label, got, want) { ok(label + "  (got " + JSON.stringify(got) + ")", JSON.stringify(got) === JSON.stringify(want)); }

const TODAY = "2026-10-23";
const epoch = (iso) => String(Date.parse(iso + "T10:00:00Z"));
const enq = (id, arrived, extra) => Object.assign({ id: "enq_" + epoch(arrived) + id, name: "Jane Smith", email: "jane" + id + "@example.com",
  outcome: "undecided", contacts: [{ date: arrived, method: "email", note: "Brochure requested" }], viewings: [] }, extra || {});
const ON = { followup: { on: true }, second: { on: true }, third: { on: true } };
const kinds = (r) => r.due.map((d) => d.kind + ":" + d.refId);
// Most cases below are about something else, so Gmail is taken to have checked
// every address on the morning of the run (the date found stays as given).
const morning = (day) => (day || TODAY) + "T07:00:00Z";
function withChecks(list, seen, day) {
  const out = Object.assign({}, seen || {});
  (list || []).forEach((e) => {
    const k = String(e.email || "").trim().toLowerCase();
    if (k && !(out[k] && out[k].at)) out[k] = Object.assign({ date: null }, out[k] || {}, { at: morning(day) });
  });
  return out;
}
const P = (o) => A.planAutomations(Object.assign({}, o, { emailSeen: withChecks(o.enquiries, o.emailSeen, o.today) }));

(async () => {
console.log("off by default");
{
  const r = P({ settings: null, enquiries: [enq("1", "2026-10-20")], events: [], today: TODAY });
  eq("nothing planned with no settings", r.due.length, 0);
  eq("defaults are all off", [A.DEFAULTS.followup.on, A.DEFAULTS.second.on, A.DEFAULTS.third.on], [false, false, false]);
  eq("the three steps, and no thank-you", A.STEPS, ["followup", "second", "third"]);
  const m = A.mergeSettings({ followup: { on: "yes", days: "0", subject: "  " }, second: { on: true, freezeOn: "yes", freezeDays: 0 }, thanks: { on: true } });
  ok("only a real true switches on", m.followup.on === false && m.second.on === true && m.second.freezeOn === false);
  eq("silly days fall back", [m.followup.days, m.second.freezeDays], [3, 7]);
  eq("blank subject falls back", m.followup.subject, A.DEFAULTS.followup.subject);
  ok("an old thank-you setting is ignored", !("thanks" in m));
}

console.log("follow-up");
{
  const fresh = enq("a", "2026-10-20");                      // 3 days ago, nothing since
  const tooSoon = enq("b", "2026-10-21");
  const replied = enq("c", "2026-10-19", { contacts: [{ date: "2026-10-19" }, { date: "2026-10-21", method: "phone" }] });
  const old = enq("d", "2026-09-01");                        // switched on late: history
  const booked = enq("e", "2026-10-20", { outcome: "booked" });
  const optedOut = enq("f", "2026-10-20", { noAutoEmails: true });
  const viewing = enq("g", "2026-10-20", { viewings: [{ date: "2026-10-30" }] });
  const noEmail = enq("h", "2026-10-20", { email: "not an address" });
  const gmail = enq("i", "2026-10-19");
  const r = P({ settings: { followup: { on: true } }, today: TODAY,
    enquiries: [fresh, tooSoon, replied, old, booked, optedOut, viewing, noEmail, gmail],
    emailSeen: { "janei@example.com": { date: "2026-10-22" } } });
  eq("only the untouched one in its window", kinds(r), ["followup:" + fresh.id]);
  const again = P({ settings: { followup: { on: true } }, today: TODAY, enquiries: [fresh],
    marks: { ["enq:" + fresh.id]: { followup: "2026-10-23T09:00:00Z" } } });
  eq("never twice", again.due.length, 0);
  const email = A.renderEmail(r.due[0], r.cfg);
  ok("first name filled in", /^Hello Jane,/.test(email.text) && email.subject === A.DEFAULTS.followup.subject);
  ok("html escapes and keeps the shell", email.html.indexOf("Hawthbush Farm, Gun Hill") !== -1);
  eq("a name that is an email address reads as 'there'", A.firstName("jane@example.com"), "there");
}

console.log("second follow-up");
{
  const q = enq("q", "2026-09-01", { contacts: [{ date: "2026-09-01" }, { date: "2026-09-25", method: "phone" }] });   // 28 days idle
  const recent = enq("r", "2026-09-01", { contacts: [{ date: "2026-10-10" }] });
  const ancient = enq("s", "2025-01-01", { contacts: [{ date: "2025-01-01" }] });
  const r = P({ settings: ON, today: TODAY, enquiries: [q, recent, ancient] });
  eq("only the one quiet for 21+ days inside the window", kinds(r), ["second:" + q.id]);
  ok("records what it was based on", r.due[0].basedOn === "2026-09-25");
  const f = enq("t", "2026-09-20");
  const r2 = P({ settings: ON, today: TODAY, enquiries: [f], marks: { ["enq:" + f.id]: { followup: "2026-10-15T09:00:00Z" } } });
  eq("a first follow-up 8 days ago means not yet", r2.due.length, 0);
  const both = enq("u", "2026-10-20");
  const r3 = P({ settings: Object.assign({}, ON, { second: { on: true, days: 1 } }), today: TODAY, enquiries: [both] });
  eq("one email a day at most", kinds(r3), ["followup:" + both.id]);
  const email = A.renderEmail(r.due[0], r.cfg);
  eq("its own wording", email.subject, A.DEFAULTS.second.subject);
}

console.log("third follow-up");
{
  const t = enq("th", "2026-08-01", { contacts: [{ date: "2026-08-01" }] });
  const marks = (second) => ({ ["enq:" + t.id]: { followup: "2026-08-04T09:00:00Z", second: second } });
  eq("14 days after the second, nothing since: sent", kinds(P({ settings: ON, today: TODAY, enquiries: [t], marks: marks("2026-10-09T09:00:00Z") })), ["third:" + t.id]);
  eq("13 days: not yet", P({ settings: ON, today: TODAY, enquiries: [t], marks: marks("2026-10-10T09:00:00Z") }).due.length, 0);
  eq("never without the second", P({ settings: { third: { on: true, days: 1 } }, today: TODAY, enquiries: [t], marks: { ["enq:" + t.id]: { followup: "2026-08-04T09:00:00Z" } } }).due.length, 0);
  const replied = Object.assign({}, t, { contacts: t.contacts.concat([{ date: "2026-10-20", method: "email" }]) });
  eq("a note logged since the second puts it back", P({ settings: ON, today: TODAY, enquiries: [replied], marks: marks("2026-10-09T09:00:00Z") }).due.length, 0);
  eq("never twice", P({ settings: ON, today: TODAY, enquiries: [t], marks: { ["enq:" + t.id]: { second: "2026-10-09T09:00:00Z", third: "2026-10-23T09:00:00Z" } } }).due.length, 0);
  eq("its own wording", A.renderEmail({ kind: "third", tokens: { firstName: "Jane" } }, A.mergeSettings(ON)).subject, A.DEFAULTS.third.subject);
}

console.log("mark Freezing");
{
  const e = enq("fz", "2026-08-01", { contacts: [{ date: "2026-08-01" }], temperature: "cold" });
  const FZ = { second: { on: true, freezeOn: true, freezeDays: 7 }, third: { on: false } };
  const sentSecond = (d) => ({ ["enq:" + e.id]: { second: d + "T09:00:00Z" } });
  let r = P({ settings: FZ, today: TODAY, enquiries: [e], marks: sentSecond("2026-10-15") });
  eq("8 quiet days after the second: frozen", r.freeze.map((f) => f.refId + ":" + f.after), [e.id + ":second"]);
  eq("and nothing emailed", r.due.length, 0);
  r = P({ settings: FZ, today: TODAY, enquiries: [e], marks: sentSecond("2026-10-18") });
  eq("5 days: not yet", r.freeze.length, 0);
  r = P({ settings: Object.assign({}, FZ, { second: { on: true, freezeOn: false } }), today: TODAY, enquiries: [e], marks: sentSecond("2026-10-01") });
  eq("unticked: never", r.freeze.length, 0);
  const noted = Object.assign({}, e, { contacts: e.contacts.concat([{ date: "2026-10-20", method: "note" }]) });
  eq("a note logged since: not frozen", P({ settings: FZ, today: TODAY, enquiries: [noted], marks: sentSecond("2026-10-10") }).freeze.length, 0);
  const seenEmail = A.planAutomations({ settings: FZ, today: TODAY, enquiries: [e], marks: sentSecond("2026-10-10"),
    emailSeen: { [e.email]: { date: "2026-10-21", at: TODAY + "T07:00:00Z" } } });
  eq("an email since: not frozen", seenEmail.freeze.length, 0);
  const gmailBehind = A.planAutomations({ settings: FZ, today: TODAY, enquiries: [e], marks: sentSecond("2026-10-10"),
    emailSeen: { [e.email]: { date: null, at: "2026-10-14T07:00:00Z" } } });
  eq("Gmail has only confirmed 4 days: waiting, not frozen", [gmailBehind.freeze.length, gmailBehind.waiting.map((w) => w.kind + " " + w.verified + "/" + w.needed)], [0, ["freeze 4/7"]]);
  eq("never twice", P({ settings: FZ, today: TODAY, enquiries: [e], marks: { ["enq:" + e.id]: { second: "2026-10-01T09:00:00Z", frozen: "2026-10-09T09:00:00Z" } } }).freeze.length, 0);
  const already = Object.assign({}, e, { temperature: "freezing" });
  eq("already Freezing: left alone", P({ settings: FZ, today: TODAY, enquiries: [already], marks: sentSecond("2026-10-01") }).freeze.length, 0);
  // after the third, its own box decides; the count runs from the third
  const T3 = { second: { on: true, freezeOn: true, freezeDays: 30 }, third: { on: true, freezeOn: true, freezeDays: 5 } };
  r = P({ settings: T3, today: TODAY, enquiries: [e], marks: { ["enq:" + e.id]: { second: "2026-10-01T09:00:00Z", third: "2026-10-17T09:00:00Z" } } });
  eq("6 quiet days after the third: frozen, after the third", r.freeze.map((f) => f.after), ["third"]);
  // a Freezing enquiry gets no emails at all
  const cold = enq("fc", "2026-10-20", { temperature: "freezing" });
  eq("Freezing: no first follow-up", P({ settings: ON, today: TODAY, enquiries: [cold] }).due.length, 0);
}

console.log("Freezing is written carefully");
{
  const realFetch = global.fetch;
  const list = [{ id: "a", outcome: "undecided", temperature: "cold", name: "A" }, { id: "b", outcome: "booked", temperature: "warm" },
                { id: "c", outcome: "undecided", temperature: "warm", notes: "keep me" }];
  let reads = 0, patches = [];
  global.fetch = async (url, opts) => {
    if (/app_data\?key=eq\.hbf_enquiries_v1&select=value,updated_at/.test(url)) {
      reads++;
      return { ok: true, json: async () => [{ value: JSON.parse(JSON.stringify(list)), updated_at: "2026-10-23T08:0" + reads + ":00Z" }] };
    }
    if (opts && opts.method === "PATCH") {
      patches.push({ url: url, body: JSON.parse(opts.body) });
      // the first write finds someone saved in between
      return { ok: true, json: async () => (patches.length === 1 ? [] : [{}]) };
    }
    throw new Error("unexpected " + url);
  };
  const changed = await A.freezeEnquiries([{ refId: "a", after: "second" }, { refId: "b", after: "second" }], "2026-10-23");
  global.fetch = realFetch;
  eq("only the open one is frozen", changed, ["a"]);
  eq("a clash is re-read and tried again", [reads, patches.length], [2, 2]);
  ok("written only if unchanged since the read", /updated_at=eq\.2026-10-23T08%3A02%3A00Z/.test(patches[1].url));
  const v = patches[1].body.value;
  eq("only temperature and the auto fields change", v.find((x) => x.id === "a"), { id: "a", outcome: "undecided", temperature: "freezing", name: "A", autoFrozenAt: "2026-10-23", autoFrozenAfter: "second" });
  eq("the others untouched", [v.find((x) => x.id === "b"), v.find((x) => x.id === "c")], [list[1], list[2]]);
}

console.log("the farm Gmail over the app's cache");
{
  const merged = A.mergeSeen({ "a@x.co": { date: "2026-10-01", at: "2026-10-02T07:00:00Z" }, "b@x.co": { date: "2026-10-05", at: "2026-10-05T07:00:00Z" } },
                             { "a@x.co": { date: "2026-10-20", at: "2026-10-23T09:00:00Z" }, "b@x.co": { date: null, at: "2026-10-23T09:00:00Z" }, "c@x.co": { date: null, at: "2026-10-23T09:00:00Z" } });
  eq("newer email wins, checked now", merged["a@x.co"], { date: "2026-10-20", at: "2026-10-23T09:00:00Z" });
  eq("no email in Gmail keeps what the app saw, checked now", merged["b@x.co"], { date: "2026-10-05", at: "2026-10-23T09:00:00Z" });
  eq("a new address is added", merged["c@x.co"], { date: null, at: "2026-10-23T09:00:00Z" });
}

console.log("quiet days are only what Gmail has confirmed");
{
  const e = enq("v", "2026-10-20");                          // arrived 3 days ago, no contact since
  const at = (day) => ({ [e.email]: { date: null, at: day + "T07:00:00Z" } });
  const run = (seen, today) => A.planAutomations({ settings: ON, today: today || TODAY, enquiries: [e], emailSeen: seen });
  const y = run(at("2026-10-22"));
  eq("checked yesterday: 2 verified days, nothing sent", y.due.length, 0);
  eq("and it is shown as waiting, 2 of 3", y.waiting.map((w) => w.verified + "/" + w.needed), ["2/3"]);
  eq("never checked: never sent", run({}).due.length, 0);
  eq("checked today: 3 verified days, sent", kinds(run(at("2026-10-23"))), ["followup:" + e.id]);
  eq("checked two days from now: 5 verified days, sent that day", kinds(run(at("2026-10-25"), "2026-10-25")), ["followup:" + e.id]);
  const called = Object.assign({}, e, { contacts: e.contacts.concat([{ date: "2026-10-22", method: "phone" }]) });
  eq("a logged call is contact: no follow-up", A.planAutomations({ settings: ON, today: TODAY, enquiries: [called], emailSeen: at("2026-10-23") }).due.length, 0);
  // the check-in, likewise
  const q = enq("x", "2026-09-01", { contacts: [{ date: "2026-09-01" }, { date: "2026-09-25", method: "phone" }] });
  const qs = (day) => ({ [q.email]: { date: null, at: day + "T07:00:00Z" } });
  eq("second: 21 days since, but Gmail last looked after 19", A.planAutomations({ settings: ON, today: TODAY, enquiries: [q], emailSeen: qs("2026-10-14") }).due.length, 0);
  eq("second: Gmail confirms 28", A.planAutomations({ settings: ON, today: TODAY, enquiries: [q], emailSeen: qs("2026-10-23") }).due.length, 1);
  eq("London date of a late-evening check", A.gmailCheckedOn({ email: "a@b.co" }, { "a@b.co": { at: "2026-10-22T23:30:00Z" } }), "2026-10-23");
}

console.log("who is left out");
{
  const q = enq("w", "2026-09-01", { contacts: [{ date: "2026-09-25" }] });
  const sombre = Object.assign({}, q, { id: q.id + "x", email: "other@example.com", eventType: "Celebration of Life" });
  const r = P({ settings: ON, today: TODAY, enquiries: [sombre] });
  eq("no 'found your venue elsewhere?' to a celebration of life", r.due.length, 0);
  const client = P({ settings: ON, today: TODAY, enquiries: [q],
    events: [{ id: 3, status: "Confirmed", date: "2027-05-01", email: "JANEW@example.com" }] });
  eq("an address with a live event is a client, not an enquiry", client.due.length, 0);
  const cancelled = P({ settings: ON, today: TODAY, enquiries: [q],
    events: [{ id: 3, status: "Cancelled", date: "2027-05-01", email: "janew@example.com" }] });
  eq("a cancelled event does not count", cancelled.due.length, 1);
  const twin = Object.assign({}, q, { id: q.id + "2" });
  const dup = P({ settings: ON, today: TODAY, enquiries: [q, twin] });
  eq("two enquiries, one address: one email", dup.due.length, 1);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
