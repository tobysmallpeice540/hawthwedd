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

console.log("off by default");
{
  const r = A.planAutomations({ settings: null, enquiries: [enq("1", "2026-10-20")], events: [], today: TODAY });
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
  const r = A.planAutomations({ settings: { followup: { on: true } }, today: TODAY,
    enquiries: [fresh, tooSoon, replied, old, booked, optedOut, viewing, noEmail, gmail],
    emailSeen: { "janei@example.com": { date: "2026-10-22" } } });
  eq("only the untouched one in its window", kinds(r), ["followup:" + fresh.id]);
  const again = A.planAutomations({ settings: { followup: { on: true } }, today: TODAY, enquiries: [fresh],
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
  const r = A.planAutomations({ settings: ON, today: TODAY, enquiries: [q, recent, ancient] });
  eq("only the one quiet for 21+ days inside the window", kinds(r), ["quiet:" + q.id]);
  ok("records what it was based on", r.due[0].basedOn === "2026-09-25");
  // our own follow-up resets the clock
  const f = enq("t", "2026-09-20");
  const r2 = A.planAutomations({ settings: ON, today: TODAY, enquiries: [f], marks: { ["enq:" + f.id]: { followup: "2026-10-15T09:00:00Z" } } });
  eq("a follow-up 8 days ago means not quiet yet", r2.due.length, 0);
  // and a follow-up and a check-in never go in the same run
  const both = enq("u", "2026-10-20");
  const r3 = A.planAutomations({ settings: Object.assign({}, ON, { quiet: { on: true, days: 1 } }), today: TODAY, enquiries: [both] });
  eq("one email a day at most", kinds(r3), ["followup:" + both.id]);

  // the app's flag
  const marks = { ["enq:" + q.id]: { quiet: "2026-10-10T09:00:00Z" } };
  ok("flagged after 7 quiet days", A.goneQuiet(q, marks, {}, ON, TODAY));
  ok("not before", !A.goneQuiet(q, marks, {}, ON, "2026-10-15"));
  ok("not once they reply", !A.goneQuiet(Object.assign({}, q, { contacts: q.contacts.concat([{ date: "2026-10-12" }]) }), marks, {}, ON, TODAY));
  ok("not once Gmail has seen an email", !A.goneQuiet(q, marks, { "janeq@example.com": { date: "2026-10-20" } }, ON, TODAY));
  ok("not once it is booked", !A.goneQuiet(Object.assign({}, q, { outcome: "booked" }), marks, {}, ON, TODAY));
  ok("never without a check-in", !A.goneQuiet(q, {}, {}, ON, TODAY));
}

console.log("who is left out");
{
  const q = enq("w", "2026-09-01", { contacts: [{ date: "2026-09-25" }] });
  const sombre = Object.assign({}, q, { id: q.id + "x", email: "other@example.com", eventType: "Celebration of Life" });
  const r = A.planAutomations({ settings: ON, today: TODAY, enquiries: [sombre] });
  eq("no 'found your venue elsewhere?' to a celebration of life", r.due.length, 0);
  const client = A.planAutomations({ settings: ON, today: TODAY, enquiries: [q],
    events: [{ id: 3, status: "Confirmed", date: "2027-05-01", email: "JANEW@example.com" }] });
  eq("an address with a live event is a client, not an enquiry", client.due.length, 0);
  const cancelled = A.planAutomations({ settings: ON, today: TODAY, enquiries: [q],
    events: [{ id: 3, status: "Cancelled", date: "2027-05-01", email: "janew@example.com" }] });
  eq("a cancelled event does not count", cancelled.due.length, 1);
  const twin = Object.assign({}, q, { id: q.id + "2" });
  const dup = A.planAutomations({ settings: ON, today: TODAY, enquiries: [q, twin] });
  eq("two enquiries, one address: one email", dup.due.length, 1);
}

console.log("thank-you");
{
  const ev = { id: 7, status: "Confirmed", date: "2026-10-21", couple: "Elizabeth Bradley & Ashley Williams", email: "liz@example.com", email2: "ASH@example.com" };
  const r = A.planAutomations({ settings: ON, today: TODAY, events: [ev,
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
  const once = A.planAutomations({ settings: ON, today: TODAY, events: [ev], marks: { "ev:7:2026-10-21": { thanks: "2026-10-23T09:00:00Z" } } });
  eq("never twice", once.due.length, 0);
  const reused = A.planAutomations({ settings: ON, today: TODAY, events: [ev], marks: { "ev:7:2025-06-01": { thanks: "2025-06-03T09:00:00Z" } } });
  eq("a reused id on a new date is still thanked", reused.due.length, 1);
  const wake = A.planAutomations({ settings: ON, today: TODAY, events: [Object.assign({}, ev, { eventType: "Wake" })] });
  eq("no thank-you after a wake", wake.due.length, 0);
  const off = A.planAutomations({ settings: { followup: { on: true } }, today: TODAY, events: [ev] });
  eq("off means off", off.due.length, 0);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
