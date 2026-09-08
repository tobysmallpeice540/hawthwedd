// The duplicate-event fix, pinned.
//
// createBookingRecord and mutateBookings live inside the App component and
// can't be imported, so this models their contract exactly as written in
// App.jsx and asserts the behaviour that matters. It is a model, not the
// shipped function — its job is to stop the *rules* being changed by accident
// (dedupe before guard, allocate from the server's array, abort on throw).
// The shipped code is checked against these rules by reading it back below.
const fs = require("fs");
const path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "src", "App.jsx"), "utf8");

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}
const eq = (l, g, w) => ok(l + "  (got " + JSON.stringify(g) + ")", g === w);

function nextBookingId(bookings) {
  var nums = (bookings || []).map(b => Number(b && b.id)).filter(n => Number.isFinite(n));
  return (nums.length ? Math.max.apply(null, nums) : 0) + 1;
}

// A stand-in server holding the one events array, plus the two helpers as
// App.jsx defines them.
function makeServer(initial) {
  let rows = initial.slice();
  const mutateBookings = async (mutator) => {
    const base = rows.slice();                 // the re-read
    const next = mutator(base);                // may throw -> nothing written
    if (next.length < base.length - 1) throw new Error("tripwire");
    rows = next;
    return next;
  };
  const createBookingRecord = async (data, dedupe, guard) => {
    let made = null, existing = null;
    await mutateBookings(function(base) {
      if (dedupe) { existing = base.find(dedupe) || null; if (existing) return base; }
      if (guard) guard(base);
      const id = nextBookingId(base);
      made = Object.assign({}, data, { id });
      return base.concat([made]);
    });
    return existing ? { record: existing, created: false } : { record: made, created: true };
  };
  return { rows: () => rows, createBookingRecord };
}

const byEnquiry = enqId => b => b && enqId != null && String(b.fromEnquiryId) === String(enqId);

(async () => {
console.log("\n— converting an enquiry twice —");
{
  const s = makeServer([]);
  const enq = { id: "E9", fromEnquiryId: "E9", couple: "Ali & Sam", date: "2027-05-01" };
  const first  = await s.createBookingRecord(enq, byEnquiry("E9"));
  const second = await s.createBookingRecord(enq, byEnquiry("E9"));
  eq("the first press creates the event", first.created, true);
  eq("the second press creates nothing", second.created, false);
  eq("and only one event exists", s.rows().length, 1);
  eq("the second press returns the SAME record, so the form opens the original",
     String(second.record.id), String(first.record.id));
}

console.log("\n— ids are allocated from the server, not a stale tab —");
{
  // The old bug: the tab loaded when the array was [1,2]; another device then
  // added 3. nextBookingId(staleTab) === 3, and saving "created" id 3 —
  // overwriting the other device's event.
  const s = makeServer([{ id: 1 }, { id: 2 }, { id: 3, couple: "Made elsewhere" }]);
  const res = await s.createBookingRecord({ couple: "New one" });
  eq("allocates 4, not the stale 3", res.record.id, 4);
  eq("the other device's event survives",
     s.rows().find(b => b.id === 3).couple, "Made elsewhere");
  eq("and nothing was replaced", s.rows().length, 4);
}

console.log("\n— the clash guard —");
{
  const s = makeServer([{ id: 1, couple: "Existing", date: "2027-06-05" }]);
  const guard = base => {
    if (base.some(b => b.date === "2027-06-05")) { const e = new Error("CLASH"); e.clashes = [base[0]]; throw e; }
  };
  let threw = null;
  try { await s.createBookingRecord({ couple: "Clashing", date: "2027-06-05" }, null, guard); }
  catch (e) { threw = e; }
  ok("a clash aborts the save", !!threw && !!threw.clashes);
  eq("and nothing was written", s.rows().length, 1);

  const forced = await s.createBookingRecord({ couple: "Clashing", date: "2027-06-05" }, null, null);
  eq("forcing writes it", forced.created, true);
  eq("now there are two", s.rows().length, 2);
}

console.log("\n— dedupe runs BEFORE the guard —");
{
  // An enquiry already converted onto a date that now looks like a clash must
  // report "already converted", not offer to double book against itself.
  const s = makeServer([{ id: 1, couple: "Ali & Sam", date: "2027-05-01", fromEnquiryId: "E9" }]);
  const guard = () => { const e = new Error("CLASH"); e.clashes = [{}]; throw e; };
  let threw = null, res = null;
  try { res = await s.createBookingRecord({ fromEnquiryId: "E9", date: "2027-05-01" }, byEnquiry("E9"), guard); }
  catch (e) { threw = e; }
  ok("no clash prompt for an already-converted enquiry", threw === null);
  eq("it reports the existing record instead", res && res.created, false);
  eq("still one event", s.rows().length, 1);
}

console.log("\n— the shipped code follows those rules —");
{
  const fn = SRC.slice(SRC.indexOf("const createBookingRecord"), SRC.indexOf("// Apply a change to a single event"));
  ok("createBookingRecord takes (data, dedupe, guard)",
     /createBookingRecord = useCallback\(async \(data, dedupe, guard\)/.test(fn));
  ok("dedupe is checked before the guard",
     fn.indexOf("existing = base.find(dedupe)") < fn.indexOf("if (guard) guard(base)"));
  ok("the id comes from the mutator's base, not component state",
     /const id = nextBookingId\(base\)/.test(fn));

  ok("saveBookingRecord accepts a guard and runs it first",
     /saveBookingRecord = useCallback\(\(id, data, guard\)/.test(SRC));
  ok("the enquiry conversion stamps fromEnquiryId",
     /newBooking\.fromEnquiryId = enq\.id/.test(SRC));
  ok("the enquiry conversion dedupes on it",
     /String\(b\.fromEnquiryId\) === String\(enq\.id\)/.test(SRC));
  // The function's own definition and the comment explaining the old bug both
  // contain the phrase, so look for actual CALL SITES only.
  const staleCallers = SRC.split("\n").filter(function(l) {
    if (!/nextBookingId\(bookings\)/.test(l)) return false;
    if (/^\s*(\/\/|\*)/.test(l)) return false;          // a comment
    if (/^function nextBookingId/.test(l)) return false;  // the definition
    return true;
  });
  ok("no caller allocates an event id from component state" +
     (staleCallers.length ? " — found: " + staleCallers.join(" | ") : ""),
     staleCallers.length === 0);
  ok("the lettings save no longer writes the array from tab state",
     !/var next = editId \? bookings\.map/.test(SRC));
  ok("the contract form's input is a module-level component",
     /^function CField\(/m.test(SRC));
  ok("and is not redefined inside ContractSection",
     !/const F = function\(\{ label, k, type, hint \}\)/.test(SRC));
}

console.log("\n— mobile layout and start-up (2026-09-08c) —");
{
  const MAIN = fs.readFileSync(path.join(__dirname, "..", "src", "main.jsx"), "utf8");

  // The blank-until-refresh bug: setReady lived only inside getSession's
  // .then(), so a rejected or hung call left the app on "Loading…" for ever.
  ok("getSession failure is caught", /getSession\(\)[\s\S]{0,600}?\.catch\(/.test(MAIN));
  ok("a watchdog breaks the hang", /setTimeout\(/.test(MAIN) && /watchdog/.test(MAIN));
  ok("the watchdog is cleared on unmount", /clearTimeout\(watchdog\)/.test(MAIN));
  ok("onAuthStateChange can still finish start-up late", /onAuthStateChange\([\s\S]{0,400}?done\(\)/.test(MAIN));

  // A bare 1fr track cannot shrink below its content's min-content width,
  // which is what pushed rows off the side of the screen.
  ok("collapsed grid tracks use minmax(0, 1fr), not a bare 1fr",
     /grid-template-columns: minmax\(0, 1fr\) !important/.test(SRC));
  ok("the 7-column calendar grids are still exempt",
     /:not\(\[style\*="repeat\(7"\]\)/.test(SRC));
  ok("flex children get min-width:0", /> \*, \[style\*="display: flex"\] > \* \{ min-width: 0; \}/.test(SRC));

  // The lettings list is a grid, not a table, so the collapse rule turned it
  // into unlabelled stacked cells. It needs its own phone layout.
  ok("the lettings list has a mobile card layout", /function AccomListCard\(/.test(SRC));
  ok("and chooses it on a phone", /isMobile \? \([\s\S]{0,300}?AccomListCard/.test(SRC));
  ok("its row and header are module-scope, not nested",
     /^function AccomListRow\(/m.test(SRC) && /^function AccomListHeader\(/m.test(SRC));
  ok("the stays editor hides its column header on mobile",
     /\{!isMobile && \(\s*<div style=\{\{ display:"grid", gridTemplateColumns:"1\.7fr/.test(SRC));
  ok("the revenue bars stop printing the amount inside a 30px bar",
     /if \(isMobile\) \{[\s\S]{0,900}?background:colour, borderRadius:4 \}\}\/>/.test(SRC));
}

console.log("\n— the contract writeback wiring (2026-09-08d) —");
{
  const TOML = fs.readFileSync(path.join(__dirname, "..", "netlify.toml"), "utf8");
  ok("the nightly contract check is scheduled",
     /\[functions\."check-contracts"\]\s*\n\s*schedule = "0 4 \* \* \*"/.test(TOML));

  const JOB = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "check-contracts.js"), "utf8");
  ok("the job re-reads the array immediately before writing",
     /Re-read immediately before writing/.test(JOB) && (JOB.match(/await sbGet\(BOOKING_KEY\)/g)||[]).length === 2);
  ok("it refuses to write if the event count changed",
     /next\.length !== latest\.length/.test(JOB));
  ok("it refuses to write from a non-array read",
     /did not come back as an array/.test(JOB));
  ok("it writes only the contract sub-object, never a whole event",
     /Object\.assign\(\{\}, b, \{\s*contract:/.test(JOB));
  ok("it uses the service key, not the anon key",
     /process\.env\.SUPABASE_SERVICE_KEY/.test(JOB) && !/anon/i.test(JOB));

  // A contract coming back must update the event's own booking rather than
  // creating a second one beside it.
  ok("matchContractStay exists at module scope", /^function matchContractStay\(/m.test(SRC));
  ok("rows are classified when the review is built",
     /matchContractStay\(st, propertyId, formData\.id, accomBookings\)/.test(SRC));
  ok("and re-classified when the property is changed",
     /function setRowProperty\(/.test(SRC) &&
     /matchContractStay\(r, propertyId, formData\.id, accomBookings\)/.test(SRC));
  ok("rows with an existing linked booking are updated, not created",
     /const toUpdate = wanted\.filter\(function\(r\) \{ return r\.target; \}\)/.test(SRC) &&
     /const toCreate = wanted\.filter\(function\(r\) \{ return !r\.target; \}\)/.test(SRC));
  ok("creates run before updates, so a refused create writes nothing at all",
     SRC.indexOf("let madeCount = 0;") < SRC.indexOf("let updatedCount = 0;"));
  ok("an update that changes nothing leaves no note behind",
     /if \(moved \|\| !hit\) \{/.test(SRC));
  ok("updateAccomBookings re-reads the server rather than trusting tab state",
     /const updateAccomBookings = useCallback\(async \(updates\) => \{[\s\S]{0,400}?await sbGet\(ACCOM_STORAGE\)/.test(SRC));
  ok("it recomputes the booking total from its stays",
     /value: stays\.reduce\(function\(sum, s\) \{ return sum \+ \(Number\(s\.value\) \|\| 0\); \}, 0\)/.test(SRC));
  ok("saveAccomBooking no longer writes the whole array from tab state",
     !/setAccomBookings\(function\(prev\) \{[\s\S]{0,200}?sbSet\(ACCOM_STORAGE, next\)\.catch/.test(SRC));
  ok("a signed-but-unfiled contract is surfaced on the home page",
     /^function signedUnfiledContracts\(/m.test(SRC) && /signedUnfiledContracts\(bookings\)/.test(SRC));
}

console.log("\n— enquiries and the annual report (2026-09-08e) —");
{
  ok("the enquiries column is titled Viewings, not First Viewing",
     /"Date Preference","Viewings","Last contact"/.test(SRC));
  ok("and renders every viewing rather than the legacy text field",
     /<EnquiryViewingsCell enq=\{e\}\/>/.test(SRC) && /^function EnquiryViewingsCell\(/m.test(SRC));
  ok("the legacy free-text field is still shown when there is nothing better",
     /enq\.firstViewing/.test(SRC));

  ok("last contact counts email exchanged with the address",
     /^function lastContactFrom\(e, emailSeen, todayStr\)/m.test(SRC) &&
     /events\.push\(\{ date: seen\.date, method: "email" \}\)/.test(SRC));
  ok("email dates are cached so the column is right before Gmail answers",
     /ENQUIRY_EMAIL_SEEN_KEY = "hbf_enquiry_email_seen_v1"/.test(SRC));
  ok("the scan waits for that cache before deciding what to fetch",
     /if \(!loaded \|\| !gmailToken \|\| !seenLoaded\) return;/.test(SRC));
  ok("only stale or unknown addresses are looked up",
     /const STALE_MS = 6 \* 60 \* 60 \* 1000;/.test(SRC));
  ok("a 'never emailed' answer is cached too",
     /found\[em\] = \{ date: date \|\| null, at: new Date\(\)\.toISOString\(\) \};/.test(SRC));
  ok("the lookup uses the cheap minimal message read, not thread metadata",
     /format=minimal/.test(SRC) && /internalDate/.test(SRC));
  ok("Gmail is called a few at a time, not all at once",
     /mapWithLimit\(emails, 4,/.test(SRC));

  ok("the free-text corkage field is no longer parsed as money",
     !/parseMoney\(b\.corkageTotal\) \|\| parseMoney\(b\.corkage\)/.test(SRC));
  ok("wet revenue replaces bar take (incl. corkage)",
     /label="Wet Revenue"/.test(SRC) && !/Bar Take \(incl\. corkage\)/.test(SRC));
  ok("events with no corkage figure are named rather than silently dropped",
     /past event\{corkageMissing\.length!==1\?"s":""\} with no corkage figure/.test(SRC));
  ok("the bookings summary breaks down by type",
     /sub=\{byType\.length \? byType\.map/.test(SRC));
  ok("the monthly bars are stacked by type",
     /const monthByType = \{\};/.test(SRC) && /segs\.map\(function\(sg\)/.test(SRC));
  ok("stacked segments cannot wrap on a phone",
     /display:"flex", flexWrap:"nowrap", overflow:"hidden"/.test(SRC));
  ok("the monthly chart carries a legend",
     /byType\.length > 0 && \(/.test(SRC));
}

console.log("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
})();
