// tests/portal-progress-test.cjs
//
// The "who's behind" board's red/amber rules (portalProgressFlags in App.jsx),
// lifted out of the source verbatim as pencil-test.cjs does — a retyped copy
// proves nothing.
//   node tests/portal-progress-test.cjs

const fs = require("fs"), path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "src", "App.jsx"), "utf8");

function lift(name) {
  const start = SRC.indexOf("function " + name + "(");
  if (start === -1) throw new Error("Could not find function " + name);
  let i = SRC.indexOf("{", start), depth = 0, end = -1;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return SRC.slice(start, end);
}
function liftConst(name) {
  const m = new RegExp("\\nconst " + name + "\\s*=").exec(SRC);
  if (!m) throw new Error("Could not find const " + name);
  const start = m.index + 1;
  const end = SRC.indexOf("};", start) + 2;
  return SRC.slice(start, end);
}
const code = [liftConst("PROGRESS_READY_LABEL"), lift("progressDaysBetween"), lift("portalProgressFlags")].join("\n");
const { portalProgressFlags } = new Function(code + "\nreturn { portalProgressFlags };")();

let passes = 0; const fails = [];
const check = (n, ok, d) => { if (ok) passes++; else fails.push(n + (d ? ": " + JSON.stringify(d) : "")); };

const TODAY = "2026-10-25";
const plus = (n) => new Date(Date.parse(TODAY + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const base = (o) => Object.assign({
  date: plus(300), logins: 2, last_seen: "2026-10-20T10:00:00Z", visible: ["guests", "timeline", "layout", "drinks", "checklist"],
  numbers: { adults: 90 }, guests_seated: 0, guests_at_tables: 0, timeline_lines: 0, drinks_route: null, drinks_locked: false,
  checklist_overdue: 0, checklist_soon: 0, next_payment: null, ready: [], reopened: []
}, o || {});

let f = portalProgressFlags(base(), TODAY);
check("B1 a couple well ahead, far out, is fine", f.level === "ok" && f.days === 300, f);

f = portalProgressFlags(base({ logins: 0, date: plus(150) }), TODAY);
check("B2 no login inside six months is red", f.level === "red" && f.reasons[0] === "No portal login", f);
f = portalProgressFlags(base({ logins: 0, date: plus(300) }), TODAY);
check("B3 no login inside a year is amber", f.level === "amber", f);
f = portalProgressFlags(base({ logins: 0, date: plus(500) }), TODAY);
check("B4 no login more than a year out is fine", f.level === "ok", f);

f = portalProgressFlags(base({ last_seen: null, date: plus(100) }), TODAY);
check("B5 invited, never signed in, four months out: red", f.level === "red" && f.reasons.indexOf("Never signed in") !== -1, f);
f = portalProgressFlags(base({ last_seen: null, date: plus(200) }), TODAY);
check("B6 never signed in, further out: amber", f.level === "amber", f);

f = portalProgressFlags(base({ checklist_overdue: 2 }), TODAY);
check("B7 overdue checklist is red", f.level === "red" && f.reasons.indexOf("2 overdue on the checklist") !== -1, f);
f = portalProgressFlags(base({ next_payment: { label: "Second payment", due: plus(5), amount: 10 } }), TODAY);
check("B8 a payment coming up is not a reason on its own (the statement does not record payment)", f.level === "ok", f);

f = portalProgressFlags(base({ date: plus(40), numbers: null, timeline_lines: 0 }), TODAY);
check("B9 eight weeks out with no numbers and no timeline: red with both", f.level === "red" &&
  f.reasons.indexOf("No numbers") !== -1 && f.reasons.indexOf("No timeline") !== -1, f);
f = portalProgressFlags(base({ date: plus(40), numbers: null, timeline_lines: 0, visible: ["checklist"], drinks_route: null }), TODAY);
check("B10 pages the event does not show never count", f.level === "ok", f);

f = portalProgressFlags(base({ date: plus(20), timeline_lines: 5, guests_seated: 80, guests_at_tables: 70, drinks_route: "classic" }), TODAY);
check("B11 four weeks out, ten not at a table: amber", f.level === "amber" && f.reasons[0] === "10 not at a table", f);
f = portalProgressFlags(base({ date: plus(30), timeline_lines: 5 }), TODAY);
check("B12 six weeks out, no drinks choice: amber", f.level === "amber" && f.reasons.indexOf("No drinks choice") !== -1, f);
f = portalProgressFlags(base({ date: plus(30), timeline_lines: 5, drinks_locked: true }), TODAY);
check("B13 drinks locked counts as chosen", f.reasons.indexOf("No drinks choice") === -1, f);

f = portalProgressFlags(base({ reopened: ["timeline"] }), TODAY);
check("B14 a page handed back is amber, by name", f.level === "amber" && f.reasons[0] === "Handed back: Timeline", f);
f = portalProgressFlags(base({ checklist_soon: 1 }), TODAY);
check("B15 something due soon is amber", f.level === "amber", f);
f = portalProgressFlags(base({ checklist_soon: 1, checklist_overdue: 1 }), TODAY);
check("B16 red reasons come before amber ones", f.level === "red" && f.reasons[0].indexOf("overdue") !== -1, f);

if (fails.length) { console.log(passes + " passed, FAILED:\n  " + fails.join("\n  ")); process.exit(1); }
console.log("ALL " + passes + " ASSERTIONS PASSED");
