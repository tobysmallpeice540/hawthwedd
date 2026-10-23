// The automatic follow-ups, pinned (netlify/functions/automations.js).
//
//   · Everything is off until switched on, rule by rule.
//   · A follow-up goes only to an enquiry with no contact since it arrived,
//     inside its window, once; never to one booked, lost, opted out, or with a
//     viewing to come.
//   · A gone-quiet check-in counts our own follow-up as the last touch, goes
//     once, and then the app's flag appears only after M quiet days.
//   · The thank-you goes to confirmed events only, both addresses, once.
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
const ON = { followup: { on: true }, quiet: { on: true }, thanks: { on: true, reviewUrl: "https://g.page/r/hawthbush/review" } };
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
const G = (e, marks, seen, cfg, day) => A.goneQuiet(e, marks, withChecks([e], seen, day), cfg, day);

console.log("off by default");
{
  const r = P({ settings: null, enquiries: [enq("1", "2026-10-20")], events: [], today: TODAY });
  eq("nothing planned with no settings", r.due.length, 0);
  eq("defaults are all off", [A.DEFAULTS.followup.on, A.DEFAULTS.quiet.on, A.DEFAULTS.thanks.on], [false, false, false]);
  const m = A.mergeSettings({ followup: { on: "yes", days: "0", subject: "  " }, thanks: { on: true, reviewUrl: "javascript:alert(1)" } });
  ok("only a real true switches on", m.followup.on === false && m.thanks.on === true);
  eq("silly days fall back", m.followup.days, 3);
  eq("blank subject falls back", m.followup.subject, A.DEFAULTS.followup.subject);
  eq("only an https review link is kept", m.thanks.reviewUrl, "");
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

console.log("gone quiet");
{
  const q = enq("q", "2026-09-01", { contacts: [{ date: "2026-09-01" }, { date: "2026-09-25", method: "phone" }] });   // 28 days idle
  const recent = enq("r", "2026-09-01", { contacts: [{ date: "2026-10-10" }] });
  const ancient = enq("s", "2025-01-01", { contacts: [{ date: "2025-01-01" }] });
  const r = P({ settings: ON, today: TODAY, enquiries: [q, recent, ancient] });
  eq("only the one quiet for 21+ days inside the window", kinds(r), ["quiet:" + q.id]);
  ok("records what it was based on", r.due[0].basedOn === "2026-09-25");
  // our own follow-up resets the clock
  const f = enq("t", "2026-09-20");
  const r2 = P({ settings: ON, today: TODAY, enquiries: [f], marks: { ["enq:" + f.id]: { followup: "2026-10-15T09:00:00Z" } } });
  eq("a follow-up 8 days ago means not quiet yet", r2.due.length, 0);
  // and a follow-up and a check-in never go in the same run
  const both = enq("u", "2026-10-20");
  const r3 = P({ settings: Object.assign({}, ON, { quiet: { on: true, days: 1 } }), today: TODAY, enquiries: [both] });
  eq("one email a day at most", kinds(r3), ["followup:" + both.id]);

  // the app's flag
  const marks = { ["enq:" + q.id]: { quiet: "2026-10-10T09:00:00Z" } };
  ok("flagged after 7 quiet days", G(q, marks, {}, ON, TODAY));
  ok("not before", !G(q, marks, {}, ON, "2026-10-15"));
  ok("not once they reply", !G(Object.assign({}, q, { contacts: q.contacts.concat([{ date: "2026-10-12" }]) }), marks, {}, ON, TODAY));
  ok("not once Gmail has seen an email", !G(q, marks, { "janeq@example.com": { date: "2026-10-20" } }, ON, TODAY));
  ok("not once it is booked", !G(Object.assign({}, q, { outcome: "booked" }), marks, {}, ON, TODAY));
  ok("never without a check-in", !G(q, {}, {}, ON, TODAY));
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
  eq("check-in: 21 days since, but Gmail last looked after 19", A.planAutomations({ settings: ON, today: TODAY, enquiries: [q], emailSeen: qs("2026-10-14") }).due.length, 0);
  eq("check-in: Gmail confirms 28", A.planAutomations({ settings: ON, today: TODAY, enquiries: [q], emailSeen: qs("2026-10-23") }).due.length, 1);
  // and the flag
  const marks = { ["enq:" + q.id]: { quiet: "2026-10-10T09:00:00Z" } };
  ok("flag needs Gmail to confirm the 7 days", !A.goneQuiet(q, marks, qs("2026-10-14"), ON, TODAY) && A.goneQuiet(q, marks, qs("2026-10-18"), ON, TODAY));
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

console.log("thank-you");
{
  const ev = { id: 7, status: "Confirmed", date: "2026-10-21", couple: "Elizabeth Bradley & Ashley Williams", email: "liz@example.com", email2: "ASH@example.com" };
  const r = P({ settings: ON, today: TODAY, events: [ev,
    Object.assign({}, ev, { id: 8, status: "Holding" }),
    Object.assign({}, ev, { id: 9, date: "2026-10-22" }),                 // 1 day: too soon
    Object.assign({}, ev, { id: 10, date: "2026-08-01" }),                // history
    Object.assign({}, ev, { id: 11, date: "2026-10-19", endDate: "2026-10-21", email: "sam@example.com", email2: "" }),  // multi-day: counts from the end
    Object.assign({}, ev, { id: 12, email: "", email2: "" })] });
  eq("confirmed, two days after it ended, with an address", kinds(r), ["thanks:7", "thanks:11"]);
  eq("both addresses, lower-cased", r.due[0].to, ["liz@example.com", "ash@example.com"]);
  eq("first names of the couple", r.due[0].tokens.firstName, "Elizabeth and Ashley");
  eq("from the client names when given", A.coupleFirstNames({ client1Name: "Sam Lee", client2Name: "Jo Park", couple: "x" }), "Sam and Jo");
  const email = A.renderEmail(r.due[0], r.cfg);
  ok("review button and link", email.html.indexOf("Leave a review") !== -1 && email.text.indexOf("https://g.page/r/hawthbush/review") !== -1);
  const once = P({ settings: ON, today: TODAY, events: [ev], marks: { "ev:7:2026-10-21": { thanks: "2026-10-23T09:00:00Z" } } });
  eq("never twice", once.due.length, 0);
  const reused = P({ settings: ON, today: TODAY, events: [ev], marks: { "ev:7:2025-06-01": { thanks: "2025-06-03T09:00:00Z" } } });
  eq("a reused id on a new date is still thanked", reused.due.length, 1);
  const wake = P({ settings: ON, today: TODAY, events: [Object.assign({}, ev, { eventType: "Wake" })] });
  eq("no thank-you after a wake", wake.due.length, 0);
  const off = P({ settings: { followup: { on: true } }, today: TODAY, events: [ev] });
  eq("off means off", off.due.length, 0);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
