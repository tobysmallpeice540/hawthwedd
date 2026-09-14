// Pencils, pinned.
//
// A pencil is a date held against an enquiry. The rules it has to keep:
//
//   · It holds from its date to its end date inclusive, a single day if no
//     end date was given.
//   · It stops holding when the enquiry reaches an outcome (Booked or Did Not
//     Book) or when the date goes past — neither of which deletes it.
//   · It warns, and never blocks: overlappingPencils reports, the caller asks.
//   · The day it was added is recorded, and "how long outstanding" is read
//     from that stamp — a record written before the stamp existed reads as
//     unknown, not as added today.
//
// The functions are pure and live inside App.jsx, which can't be imported
// outside a bundler, so their source is lifted out verbatim and evaluated
// here — the same approach as clash-and-contract-test.cjs, and for the same
// reason: a retyped copy proves nothing about the shipped code.
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "src", "App.jsx"), "utf8");

function lift(name) {
  const start = SRC.indexOf("function " + name + "(");
  if (start === -1) throw new Error("Could not find function " + name + " in App.jsx");
  let i = SRC.indexOf("{", start), depth = 0, end = -1;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error("Unbalanced braces reading " + name);
  return SRC.slice(start, end);
}

const NAMES = ["isValidEventDate", "daysSince", "pencilEndDate", "enquiryPencils",
               "isPencilLive", "outstandingPencils", "overlappingPencils",
               "pencilTone", "pencilAgeLabel"];
const STALE = Number(/const PENCIL_STALE_DAYS = (\d+);/.exec(SRC)[1]);

const ctx = {};
eval("const PENCIL_STALE_DAYS = " + STALE + ";\n" +
     NAMES.map(lift).join("\n\n") + "\n" +
     NAMES.map(n => "ctx." + n + " = " + n + ";").join("\n"));

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}
function eq(label, got, want) { ok(label + "  (got " + JSON.stringify(got) + ")", got === want); }

const TODAY = "2026-09-14";
const ago = (days) => {
  const d = new Date(Date.parse(TODAY) - days * 86400000);
  return d.toISOString().slice(0, 10) + "T09:00:00.000Z";
};
// e(outcome, ...pencils)
const pen = (id, date, endDate, addedAt, note) => ({ id, date, endDate: endDate || "", addedAt: addedAt || null, note: note || "" });
const enq = (id, outcome, pencils) => ({ id, name: "Enq " + id, outcome, pencils });

console.log("\n— pencilEndDate: the last day a pencil holds —");
eq("no end date holds one day", ctx.pencilEndDate(pen("p", "2027-06-12")), "2027-06-12");
eq("an end date after the start wins", ctx.pencilEndDate(pen("p", "2027-06-12", "2027-06-14")), "2027-06-14");
eq("an end date before the start is ignored", ctx.pencilEndDate(pen("p", "2027-06-12", "2027-06-01")), "2027-06-12");
eq("a half-typed date holds nothing", ctx.pencilEndDate(pen("p", "2027-06")), null);
eq("no pencil at all", ctx.pencilEndDate(null), null);

console.log("\n— enquiryPencils: only dates worth comparing —");
{
  const e = enq("e1", "undecided", [pen("a", "2027-06-12"), pen("b", ""), pen("c", "not a date"), null]);
  eq("half-typed rows are dropped here, not everywhere else", ctx.enquiryPencils(e).length, 1);
  eq("an enquiry with no pencils array", ctx.enquiryPencils({ id: "x" }).length, 0);
  eq("no enquiry at all", ctx.enquiryPencils(null).length, 0);
}

console.log("\n— isPencilLive: what stops a pencil holding —");
{
  const p = pen("a", "2027-06-12");
  ok("undecided, date ahead", ctx.isPencilLive(enq("e", "undecided", [p]), p, TODAY) === true);
  ok("no outcome recorded reads as undecided", ctx.isPencilLive({ id: "e", pencils: [p] }, p, TODAY) === true);
  ok("Booked releases it", ctx.isPencilLive(enq("e", "booked", [p]), p, TODAY) === false);
  ok("Did Not Book releases it", ctx.isPencilLive(enq("e", "didnotbook", [p]), p, TODAY) === false);
  const past = pen("b", "2026-09-13");
  ok("yesterday has stopped holding anything", ctx.isPencilLive(enq("e", "undecided", [past]), past, TODAY) === false);
  const todayP = pen("c", TODAY);
  ok("today still holds", ctx.isPencilLive(enq("e", "undecided", [todayP]), todayP, TODAY) === true);
  const spanning = pen("d", "2026-09-12", "2026-09-15");
  ok("a range that has not finished still holds", ctx.isPencilLive(enq("e", "undecided", [spanning]), spanning, TODAY) === true);
  ok("a released pencil is not deleted — the record is still there",
     enq("e", "booked", [p]).pencils.length === 1);
}

console.log("\n— outstandingPencils: the list, and how old each one is —");
{
  const list = [
    enq("e1", "undecided", [pen("p2", "2027-08-01", "", ago(3))]),
    enq("e2", "undecided", [pen("p1", "2027-06-12", "", ago(40)), pen("p3", "2027-09-04", "", ago(0))]),
    enq("e3", "booked",    [pen("p4", "2027-07-01", "", ago(5))]),
    enq("e4", "undecided", [pen("p5", "2026-01-01", "", ago(400))]),
    enq("e5", "undecided", [pen("p6", "2027-10-10", "", null)])
  ];
  const out = ctx.outstandingPencils(list, TODAY);
  eq("booked and past ones are left out", out.length, 4);
  eq("soonest date first", out.map(r => r.pencil.id).join(","), "p1,p2,p3,p6");
  eq("days outstanding come from the stamp", out[0].days, 40);
  eq("added today is nought days, not never", out[2].days, 0);
  eq("no stamp reads as unknown, not as today", out[3].days, null);
  eq("an empty list is an empty list", ctx.outstandingPencils([], TODAY).length, 0);
  eq("no list at all", ctx.outstandingPencils(null, TODAY).length, 0);
}

console.log("\n— overlappingPencils: what warns when a date gets booked —");
{
  const list = [
    enq("e1", "undecided", [pen("p1", "2027-06-12", "2027-06-14", ago(10))]),
    enq("e2", "undecided", [pen("p2", "2027-06-19", "", ago(10))]),
    enq("e3", "booked",    [pen("p3", "2027-06-12", "", ago(10))])
  ];
  const ids = (d, e, ig) => ctx.overlappingPencils(list, d, e, ig, TODAY).map(r => r.pencil.id).join(",");
  eq("the same day", ids("2027-06-13", ""), "p1");
  eq("the first day of a pencilled range", ids("2027-06-12", ""), "p1");
  eq("the last day of a pencilled range", ids("2027-06-14", ""), "p1");
  eq("the day after it ends is free", ids("2027-06-15", ""), "");
  eq("the day before it starts is free", ids("2027-06-11", ""), "");
  eq("an event running into a pencil", ids("2027-06-10", "2027-06-12"), "p1");
  eq("an event spanning two pencils", ids("2027-06-12", "2027-06-19"), "p1,p2");
  eq("a released pencil never warns", ids("2027-06-12", "").indexOf("p3"), -1);
  eq("the enquiry being converted does not warn about itself", ids("2027-06-12", "", "e1"), "");
  eq("no date, nothing to check", ctx.overlappingPencils(list, "", "", null, TODAY).length, 0);
  eq("a half-typed date checks nothing", ctx.overlappingPencils(list, "2027-06", "", null, TODAY).length, 0);
  eq("an end date before the start is treated as a single day", ids("2027-06-19", "2027-06-01"), "p2");
}

console.log("\n— how old it looks —");
{
  const fresh = ctx.pencilTone(1), warn = ctx.pencilTone(STALE), bad = ctx.pencilTone(STALE * 2);
  ok("fresh, stale and very stale are three different colours",
     fresh.bg !== warn.bg && warn.bg !== bad.bg && fresh.bg !== bad.bg);
  eq("one day short of stale still reads fresh", ctx.pencilTone(STALE - 1).bg, fresh.bg);
  eq("an unknown age is never shouted about", ctx.pencilTone(null).bg, fresh.bg);
  eq("nought days", ctx.pencilAgeLabel(0), "added today");
  eq("one day", ctx.pencilAgeLabel(1), "added yesterday");
  eq("many days", ctx.pencilAgeLabel(31), "added 31 days ago");
  eq("unknown says so rather than guessing", ctx.pencilAgeLabel(null), "date added not recorded");
}

// ── The wiring, read back out of the shipped source ─────────────────────────
// These assert the rules the pure functions can't: that the check actually
// runs where it has to, against the server's copy, and that it warns rather
// than blocks.
console.log("\n— the wiring in App.jsx —");
{
  const has = (needle) => SRC.indexOf(needle) !== -1;
  ok("the save asks about pencils before writing",
     /const handleSubmit = async \(stayOpen, force, pencilAcked\)/.test(SRC) &&
     has("const pencilHits = await pencilsForDates(formData.date, formData.endDate, formData.fromEnquiryId);"));
  ok("converting an enquiry asks too, ignoring that enquiry's own pencil",
     has("const pencilHits = await pencilsForDates(newBooking.date, newBooking.endDate, enq.id);"));
  ok("the check re-reads the enquiries from the server, not this tab's copy",
     /pencilsForDates = useCallback[\s\S]{0,700}sbGet\(ENQUIRIES_STORAGE\)/.test(SRC));
  ok("a failed re-read falls back and says so rather than reporting no pencils",
     /Pencil check fell back to this tab's copy/.test(SRC));
  ok("overriding takes a deliberate second press, and is not re-asked",
     has("handleSubmit(stayOpen, force, true)") && has("handleSubmit(stayOpen, true, true)"));
  ok("adding a pencil writes immediately rather than waiting for Save Changes",
     /const addPencil = async function\(\)[\s\S]{0,900}await persist\(updated\)/.test(SRC));
  ok("the stamp is made by the machine, not typed",
     /addedAt: new Date\(\)\.toISOString\(\)/.test(SRC));
  ok("the enquiries screen tells the rest of the app when a pencil changes",
     has("if (onEnquiriesChanged) onEnquiriesChanged(data);"));
  ok("a pencil is written against the server's copy of the enquiries, not this screen's",
     /const savePencils = async \(id, pencils\)[\s\S]{0,900}sbGet\(ENQUIRIES_STORAGE\)/.test(SRC) &&
     /fresh\.some\(function\(e\)\{ return String\(e\.id\) === String\(id\); \}\)/.test(SRC));
  ok("and it touches only that enquiry's pencils",
     has("Object.assign({}, e, { pencils: pencils })"));
  ok("the events list is given the pencils and a way to open the enquiry",
     /<ListView[\s\S]{0,800}?enquiries=\{enquiries\} onOpenEnquiry=\{goToEnquiry\}/.test(SRC));
  ok("the events table has a Pencil column",
     has('"Status","Payment","Pencil","Viewings","Files"'));
  ok("the year calendar draws only live pencils",
     has("outstandingPencils(enquiries, today).forEach(function(rec) {")); 
  ok("the event form shows the warning next to the clash warning",
     has("<PencilClashWarning enquiries={enquiries} formData={formData} onOpenEnquiry={onOpenEnquiry}/>"));
  ok("converting uses the pencilled date when the date preference has none",
     /date: dateMatch \? dateMatch\[0\] : \(heldPencil \? heldPencil\.date : ""\)/.test(SRC));
  ok("and does not ask whether that pencil is still live — converting is what released it",
     /isPencilLive is deliberately NOT used here/.test(SRC) &&
     /filter\(function\(p\) \{ return \(pencilEndDate\(p\) \|\| p\.date\) >= today0; \}\)/.test(SRC));
  ok("a pencil is never written into the events array",
     !/pencils:/.test(SRC.slice(SRC.indexOf("const emptyBooking"), SRC.indexOf("const emptyBooking") + 1200)));
}

console.log("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
