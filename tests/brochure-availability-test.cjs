// The brochure availability rules, pinned.
//
// These are the rules agreed on 11 September 2026:
//
//   · Peak is May–September. Everything else is off peak.
//   · One weekend slot per week — Friday, Saturday and Sunday together, named
//     by its Saturday. A wedding on any of the three takes the weekend.
//   · One midweek slot per week — Monday to Thursday, named by its Monday. A
//     wedding on any of the four takes the week.
//   · Confirmed AND Holding take the date. Only an explicitly cancelled event
//     gives it back.
//   · 0 free = Booked · 1–2 = Limited · 3 or more = Good availability.
//   · Nothing inside three months of the request is shown at all.
//
// They live in one place — netlify/functions/submit-brochure.js — because the
// Settings preview calls that same function rather than reimplementing them.
// This suite imports it directly, so it tests the shipped code, not a model.

// The repo's package.json says "type": "module", so a plain require() of a
// .js file in netlify/functions treats it as ESM and throws on the first
// `exports.` — even though every function in that folder is CommonJS and
// Netlify bundles them as such. Compiling it here as CommonJS is the honest
// way to test the shipped file rather than a copy of it.
const fs = require("fs");
const path = require("path");
const Module = require("module");

const FN_PATH = path.join(__dirname, "..", "netlify", "functions", "submit-brochure.js");
const mod = new Module(FN_PATH, null);
mod.filename = FN_PATH;
mod.paths = Module._nodeModulePaths(path.dirname(FN_PATH));
mod._compile(fs.readFileSync(FN_PATH, "utf8"), FN_PATH);

const fn = mod.exports;
const I  = fn._internals;

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}
const eq = (l, got, want) =>
  ok(l + "  (got " + JSON.stringify(got) + ", wanted " + JSON.stringify(want) + ")",
     JSON.stringify(got) === JSON.stringify(want));

const S = I.settingsWith({});
const ev = (date, status, endDate) => ({ date: date, status: status || "Confirmed", endDate: endDate });

// ── Slot enumeration ────────────────────────────────────────────────────────
console.log("\nSlots");

// June 2027 begins on a Tuesday: Saturdays 5, 12, 19, 26.
eq("June 2027 has four weekend slots",
   I.weekendSlots(2027, 5).map(s => s[1]),
   ["2027-06-05", "2027-06-12", "2027-06-19", "2027-06-26"]);

eq("a weekend slot is Fri, Sat, Sun",
   I.weekendSlots(2027, 5)[0],
   ["2027-06-04", "2027-06-05", "2027-06-06"]);

// Mondays in June 2027: 7, 14, 21, 28.
eq("June 2027 has four midweek slots",
   I.midweekSlots(2027, 5).map(s => s[0]),
   ["2027-06-07", "2027-06-14", "2027-06-21", "2027-06-28"]);

eq("a midweek slot is Mon to Thu",
   I.midweekSlots(2027, 5)[0],
   ["2027-06-07", "2027-06-08", "2027-06-09", "2027-06-10"]);

// August 2026 opens on a Saturday: five weekends, and the first one reaches
// back into July.
eq("August 2026 has five weekend slots", I.weekendSlots(2026, 7).length, 5);
eq("a weekend is counted in the month of its Saturday, not its Friday",
   I.weekendSlots(2026, 7)[0], ["2026-07-31", "2026-08-01", "2026-08-02"]);
ok("that Friday is not also counted in July",
   I.weekendSlots(2026, 6).every(s => s.indexOf("2026-07-31") === -1));

// ── What takes a date ───────────────────────────────────────────────────────
console.log("\nWhat takes a date");

const taken = I.bookedDateSet([
  ev("2027-06-05"),                        // Saturday, confirmed
  ev("2027-06-18", "Holding"),             // Friday, on hold
  ev("2027-06-23"),                        // Wednesday, confirmed
  ev("2027-06-26", "Cancelled"),           // Saturday, cancelled — free again
  ev("2027-07-02", "Something New"),       // a status nobody listed here
  ev("2027-08-13", "Confirmed", "2027-08-15"), // a three-day event
]);

ok("a confirmed date is taken", taken.has("2027-06-05"));
ok("a holding date is taken", taken.has("2027-06-18"));
ok("a cancelled date is given back", !taken.has("2027-06-26"));
ok("an unrecognised status is treated as taken", taken.has("2027-07-02"));
ok("an event with an endDate takes every day it spans",
   taken.has("2027-08-13") && taken.has("2027-08-14") && taken.has("2027-08-15"));
ok("and not the day after", !taken.has("2027-08-16"));

// ── The two rules that make a week one slot ─────────────────────────────────
console.log("\nOne wedding takes the week");

function freeIn(year, monthIdx, typeId, events) {
  return I.monthAvailability(year, monthIdx, typeId, S, I.bookedDateSet(events)).free;
}

eq("June 2027 peak weekends, nothing booked", freeIn(2027, 5, "peak_weekend", []), 4);
eq("a Saturday wedding takes its weekend",
   freeIn(2027, 5, "peak_weekend", [ev("2027-06-12")]), 3);
eq("a Friday wedding takes the same weekend",
   freeIn(2027, 5, "peak_weekend", [ev("2027-06-11")]), 3);
eq("a Sunday wedding takes the same weekend",
   freeIn(2027, 5, "peak_weekend", [ev("2027-06-13")]), 3);
eq("all three of one weekend still only take one slot",
   freeIn(2027, 5, "peak_weekend", [ev("2027-06-11"), ev("2027-06-12"), ev("2027-06-13")]), 3);
eq("a Wednesday wedding leaves the weekends alone",
   freeIn(2027, 5, "peak_weekend", [ev("2027-06-09")]), 4);

eq("June 2027 midweeks, nothing booked", freeIn(2027, 5, "peak_midweek", []), 4);
eq("a Wednesday wedding takes its whole week",
   freeIn(2027, 5, "peak_midweek", [ev("2027-06-09")]), 3);
eq("a Monday and a Thursday in the same week still take one slot",
   freeIn(2027, 5, "peak_midweek", [ev("2027-06-07"), ev("2027-06-10")]), 3);
eq("a Saturday wedding leaves the midweeks alone",
   freeIn(2027, 5, "peak_midweek", [ev("2027-06-12")]), 4);

// ── Green, amber, grey ──────────────────────────────────────────────────────
console.log("\nGreen, amber, grey");

function stateWith(bookedSaturdays) {
  const events = bookedSaturdays.map(d => ev(d));
  return I.monthAvailability(2027, 5, "peak_weekend", S, I.bookedDateSet(events)).state;
}
eq("four free reads as good", stateWith([]), "good");
eq("three free reads as good", stateWith(["2027-06-05"]), "good");
eq("two free reads as limited", stateWith(["2027-06-05", "2027-06-12"]), "limited");
eq("one free reads as limited", stateWith(["2027-06-05", "2027-06-12", "2027-06-19"]), "limited");
eq("none free reads as booked",
   stateWith(["2027-06-05", "2027-06-12", "2027-06-19", "2027-06-26"]), "booked");

// ── Which months appear ─────────────────────────────────────────────────────
console.log("\nWhich months appear");

// Far enough ahead that the three-month blackout takes nothing away.
const far = new Date("2026-09-11T09:00:00Z");
const names = ms => ms.map(m => ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m]);

eq("peak is May to September",
   names(I.monthsFor(2028, "peak_weekend", S, far)),
   ["May", "Jun", "Jul", "Aug", "Sep"]);
eq("peak midweek is the same five months",
   names(I.monthsFor(2028, "peak_midweek", S, far)),
   ["May", "Jun", "Jul", "Aug", "Sep"]);
eq("off peak is the other seven, in calendar order",
   names(I.monthsFor(2028, "off_peak", S, far)),
   ["Jan", "Feb", "Mar", "Apr", "Oct", "Nov", "Dec"]);

// Asked on 11 September 2026: September, October and November are inside the
// window, so December is the first month anybody is told about.
eq("nothing inside three months is offered",
   names(I.monthsFor(2026, "off_peak", S, far)),
   ["Dec"]);
eq("and a peak year already gone is empty rather than wrong",
   I.monthsFor(2026, "peak_weekend", S, far), []);

// The blackout is measured from the request, not from a fixed date.
const jan = new Date("2027-01-20T09:00:00Z");
eq("asking in January, April is the first month offered",
   names(I.monthsFor(2027, "off_peak", S, jan)), ["Apr", "Oct", "Nov", "Dec"]);
eq("asking in January, peak starts at May",
   names(I.monthsFor(2027, "peak_weekend", S, jan)), ["May", "Jun", "Jul", "Aug", "Sep"]);

// ── Off peak counts weekends unless told otherwise ──────────────────────────
console.log("\nOff peak");

const both = I.settingsWith({ offPeakSlots: "both" });
const octEvents = [];
eq("off peak counts weekends only by default",
   I.monthAvailability(2027, 9, "off_peak", S, I.bookedDateSet(octEvents)).total,
   I.weekendSlots(2027, 9).length);
eq("set to both, it counts midweeks too",
   I.monthAvailability(2027, 9, "off_peak", both, I.bookedDateSet(octEvents)).total,
   I.weekendSlots(2027, 9).length + I.midweekSlots(2027, 9).length);

// ── Settings are numbers, whatever the input said ───────────────────────────
console.log("\nSettings");

const fromForm = I.settingsWith({ goodThreshold: "4", hideWithinMonths: "0", peakStart: "6", peakEnd: "8" });
ok("a threshold typed into a form is a number", fromForm.goodThreshold === 4);
ok("a blackout of zero survives", fromForm.hideWithinMonths === 0);
eq("a narrowed peak is respected",
   names(I.monthsFor(2028, "peak_weekend", fromForm, far)), ["Jun", "Jul", "Aug"]);
eq("and off peak widens to match",
   names(I.monthsFor(2028, "off_peak", fromForm, far)),
   ["Jan", "Feb", "Mar", "Apr", "May", "Sep", "Oct", "Nov", "Dec"]);

const wrapped = I.settingsWith({ peakStart: 11, peakEnd: 2 });
eq("a peak that wraps the new year still works",
   names(I.monthsFor(2028, "peak_weekend", wrapped, far)), ["Jan", "Feb", "Nov", "Dec"]);

// ── What the form will accept ───────────────────────────────────────────────
console.log("\nInput");

const year = new Date().getFullYear();
const good = I.cleanInput({ email: "SOMEONE@Example.com ", name: " Jo ", guests: "60to120",
                            years: [String(year + 1), year + 1, year + 2], types: ["off_peak", "peak_weekend", "nonsense"] });
ok("a valid submission passes", !good.error);
eq("the email is lowercased and trimmed", good.email, "someone@example.com");
eq("the name is trimmed", good.name, "Jo");
eq("duplicate years collapse", good.years, [year + 1, year + 2]);
eq("types come back in the form's own order, unknown ones dropped",
   good.types, ["peak_weekend", "off_peak"]);

ok("a bad email is refused", !!I.cleanInput({ email: "nope", guests: "60to120", years: [year + 1], types: ["off_peak"] }).error);
ok("no guest band is refused", !!I.cleanInput({ email: "a@b.co", years: [year + 1], types: ["off_peak"] }).error);
ok("an invented guest band is refused", !!I.cleanInput({ email: "a@b.co", guests: "loads", years: [year + 1], types: ["off_peak"] }).error);
ok("no year is refused", !!I.cleanInput({ email: "a@b.co", guests: "60to120", years: [], types: ["off_peak"] }).error);
ok("a year in the past is refused", !!I.cleanInput({ email: "a@b.co", guests: "60to120", years: [1999], types: ["off_peak"] }).error);
ok("a year far in the future is refused", !!I.cleanInput({ email: "a@b.co", guests: "60to120", years: [year + 40], types: ["off_peak"] }).error);
ok("no type is refused", !!I.cleanInput({ email: "a@b.co", guests: "60to120", years: [year + 1], types: [] }).error);
ok("only invented types is refused", !!I.cleanInput({ email: "a@b.co", guests: "60to120", years: [year + 1], types: ["vip"] }).error);

// ── The rendered email ──────────────────────────────────────────────────────
console.log("\nThe email");

const events = [ev("2027-06-05"), ev("2027-06-12", "Holding"), ev("2027-06-19"), ev("2027-06-26")];
const out = I.render(S, {
  email: "jo@example.com", name: "Jo", guests: "60to120",
  years: [2027, 2028], types: ["peak_weekend", "peak_midweek"],
}, events, far, "");

ok("no token is left unreplaced in the subject", out.subject.indexOf("{{") === -1);
ok("no token is left unreplaced in the body", out.html.indexOf("{{") === -1);
ok("the greeting uses the name they gave", out.html.indexOf("Hello Jo") !== -1);
ok("the brochure link is in the email", out.html.indexOf(S.brochureUrl) !== -1);
ok("June 2027 reads as booked", out.text.indexOf("June — Booked") !== -1);
ok("both years appear", out.text.indexOf("2027 ·") !== -1 && out.text.indexOf("2028 ·") !== -1);
ok("both types appear",
   out.text.indexOf("Peak weekend") !== -1 && out.text.indexOf("Peak midweek") !== -1);
ok("off peak is not mentioned — they didn't ask for it",
   out.text.indexOf("Off peak") === -1);
ok("the plain text carries the availability, not the marker",
   out.text.indexOf("AVAILABILITY") === -1);
ok("nothing sooner than the blackout appears",
   out.text.indexOf("2026") === -1);

const noName = I.render(S, {
  email: "jo@example.com", name: "", guests: "under60", years: [2028], types: ["off_peak"],
}, [], far, "");
ok("with no name it still greets them", noName.html.indexOf("Hello there") !== -1);

// A request for a year that has nothing left says so rather than showing an
// empty heading.
const gone = I.render(S, {
  email: "jo@example.com", name: "Jo", guests: "under60", years: [2026], types: ["peak_weekend"],
}, [], far, "");
ok("a year with nothing left says so", gone.text.indexOf("nothing left") !== -1);

// ── The availability block sits where the token is put ─────────────────────
console.log("\nWhere the availability block goes");

function bodyWith(body) {
  const s = I.settingsWith({ body: body });
  return I.render(s, { email: "jo@example.com", name: "Jo", guests: "under60",
                       years: [2028], types: ["peak_weekend"] }, [], far, "");
}

const onOwnLine = bodyWith("Hello.\n\n{{availability}}\n\nBye.");
ok("on its own line, the block renders", onOwnLine.html.indexOf("Good availability") !== -1);
ok("and the prose above and below survives",
   onOwnLine.html.indexOf("Hello.") !== -1 && onOwnLine.html.indexOf("Bye.") !== -1);

// The failure this guards against: the token written mid-sentence used to fall
// through to the escaped branch and print the marker as literal text.
const inline = bodyWith("Here is what we have: {{availability}} Let us know.");
ok("written mid-sentence, the block still renders", inline.html.indexOf("Good availability") !== -1);
ok("the prose before it survives", inline.html.indexOf("Here is what we have:") !== -1);
ok("the prose after it survives", inline.html.indexOf("Let us know.") !== -1);
ok("and the marker never reaches the reader",
   inline.html.indexOf("AVAILABILITY") === -1 && inline.html.indexOf("\u0001") === -1);

// A template that talks about availability in prose must not be mistaken for
// the token.
const talksAbout = bodyWith("Our AVAILABILITY changes weekly.\n\n{{availability}}");
ok("the plain word availability is left alone",
   talksAbout.html.indexOf("Our AVAILABILITY changes weekly.") !== -1);

const noToken = bodyWith("Hello, here is the brochure: {{brochureUrl}}");
ok("a template with no token still sends", noToken.html.indexOf("here is the brochure") !== -1);
ok("and a bare URL becomes a link", noToken.html.indexOf('<a href="https://') !== -1);

// ── Result ──────────────────────────────────────────────────────────────────
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
