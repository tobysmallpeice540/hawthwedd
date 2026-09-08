// Behaviour tests for the double-booking and contract-chasing logic added in
// build 2026-09-08b. The functions under test are pure and live inside
// App.jsx, which can't be imported outside a bundler, so their source is
// lifted out of the file verbatim and evaluated here. Lifting rather than
// retyping is deliberate: a copy that has drifted from the real thing proves
// nothing about the shipped code.
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "src", "App.jsx"), "utf8");

function lift(name) {
  const start = SRC.indexOf("function " + name + "(");
  if (start === -1) throw new Error("Could not find function " + name + " in App.jsx");
  // Walk braces from the first { after the signature.
  let i = SRC.indexOf("{", start), depth = 0, end = -1;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error("Unbalanced braces reading " + name);
  return SRC.slice(start, end);
}

const NAMES = ["findAccomClashes", "findAllAccomClashes", "outstandingContracts",
               "daysSince", "overlappingEvents", "eventEndDate", "isValidEventDate",
               "nextBookingId", "findAllEventClashes", "matchContractStay",
               "signedUnfiledContracts", "lastContactFrom", "countByEventType",
               "eventTypeColour", "parseMoney", "pendingButPaid"];
// Constants the lifted functions close over, taken from the same source rather
// than restated here — a colour or a type list retyped into the test would let
// the two drift apart silently.
function liftConst(name) {
  const re = new RegExp("^const " + name + " = [\\s\\S]*?;$", "m");
  const m = re.exec(SRC);
  if (!m) throw new Error("Could not find const " + name + " in App.jsx");
  return m[0];
}
const CONSTS = ["EVENT_TYPES", "EVENT_TYPE_COLOURS", "EVENT_TYPE_FALLBACK", "CONTRACT_CHASE_DAYS"];

const ctx = {};
eval(CONSTS.map(liftConst).join("\n") + "\n\n" +
     NAMES.map(lift).join("\n\n") + "\n" +
     NAMES.map(n => "ctx." + n + " = " + n + ";").join("\n"));

// Constant the contract sweep depends on.
const CHASE_DAYS = Number(/CONTRACT_CHASE_DAYS = (\d+)/.exec(SRC)[1]);

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}
function eq(label, got, want) { ok(label + "  (got " + JSON.stringify(got) + ")", got === want); }

const stay = (p, ci, co) => ({ propertyId: p, propertyName: p, checkIn: ci, checkOut: co });
const bk = (id, p, ci, co, extra) => Object.assign({ id, guestName: "G" + id, stays: [stay(p, ci, co)], status: "confirmed" }, extra || {});

console.log("\n— findAccomClashes: the rule that decides a double booking —");
{
  const diary = [bk("A1", "amly", "2026-06-05", "2026-06-08")];
  eq("straight overlap is a clash",
     ctx.findAccomClashes(diary, bk("A2", "amly", "2026-06-06", "2026-06-09")).length, 1);
  eq("changeover on the same day is NOT a clash",
     ctx.findAccomClashes(diary, bk("A2", "amly", "2026-06-08", "2026-06-10")).length, 0);
  eq("back-to-back the other way is NOT a clash",
     ctx.findAccomClashes(diary, bk("A2", "amly", "2026-06-02", "2026-06-05")).length, 0);
  eq("a different property never clashes",
     ctx.findAccomClashes(diary, bk("A2", "hamlet", "2026-06-06", "2026-06-09")).length, 0);
  eq("a cancelled booking doesn't block the dates",
     ctx.findAccomClashes([bk("A1","amly","2026-06-05","2026-06-08",{status:"cancelled"})],
                          bk("A2","amly","2026-06-06","2026-06-09")).length, 0);
  eq("editing a booking doesn't report it clashing with itself",
     ctx.findAccomClashes(diary, bk("A1", "amly", "2026-06-05", "2026-06-08")).length, 0);
  eq("fully contained inside an existing stay is a clash",
     ctx.findAccomClashes(diary, bk("A2", "amly", "2026-06-06", "2026-06-07")).length, 1);
}

console.log("\n— findAllAccomClashes: the front-page sweep —");
{
  const diary = [
    bk("A1", "amly", "2026-06-05", "2026-06-08"),
    bk("A2", "amly", "2026-06-06", "2026-06-09"),          // clashes with A1
    bk("A3", "hamlet", "2026-06-06", "2026-06-09"),        // fine
    bk("A4", "amly", "2026-06-09", "2026-06-11"),          // changeover off A2, fine
  ];
  const found = ctx.findAllAccomClashes(diary);
  eq("one collision found", found.length, 1);
  ok("names both sides", [found[0].a.id, found[0].b.id].sort().join(",") === "A1,A2");
  eq("empty diary is quiet", ctx.findAllAccomClashes([]).length, 0);
  eq("no clashes means no report", ctx.findAllAccomClashes([diary[0], diary[2]]).length, 0);

  // The pair must not be reported twice just because it's found from each end.
  const three = [bk("B1","amly","2026-07-01","2026-07-05"),
                 bk("B2","amly","2026-07-02","2026-07-06"),
                 bk("B3","amly","2026-07-03","2026-07-04")];
  eq("three mutually overlapping bookings report 3 pairs, not 6",
     ctx.findAllAccomClashes(three).length, 3);
}

console.log("\n— overlappingEvents: the venue —");
{
  const evs = [{ id: 1, couple: "Smith", date: "2026-08-01" },
               { id: 2, couple: "Jones", date: "2026-08-10", endDate: "2026-08-12" }];
  eq("same day is an overlap", ctx.overlappingEvents(evs, "2026-08-01", "", null).length, 1);
  eq("a free day is clear", ctx.overlappingEvents(evs, "2026-08-05", "", null).length, 0);
  eq("landing mid multi-day event overlaps", ctx.overlappingEvents(evs, "2026-08-11", "", null).length, 1);
  eq("editing an event ignores itself", ctx.overlappingEvents(evs, "2026-08-01", "", 1).length, 0);
  eq("no date, no opinion", ctx.overlappingEvents(evs, "", "", null).length, 0);
}

console.log("\n— findAllEventClashes: the front-page sweep for events —");
{
  const evs = [
    { id: 1, couple: "Smith",  date: "2027-08-01" },
    { id: 2, couple: "Smith",  date: "2027-08-01" },   // the duplicate
    { id: 3, couple: "Jones",  date: "2027-09-01" },
    { id: 4, couple: "Patel",  date: "2027-10-01", endDate: "2027-10-03" },
    { id: 5, couple: "Okoro",  date: "2027-10-02" },   // inside Patel's run
    { id: 6, couple: "No date" },
  ];
  const found = ctx.findAllEventClashes(evs);
  eq("finds both collisions", found.length, 2);
  ok("the duplicate pair is reported once, not twice",
     found.filter(c => [c.a.id, c.b.id].sort().join(",") === "1,2").length === 1);
  ok("a date landing inside a multi-day event is caught",
     found.some(c => [c.a.id, c.b.id].sort().join(",") === "4,5"));
  ok("an event with no date is never reported",
     !found.some(c => c.a.id === 6 || c.b.id === 6));
  eq("a clean diary reports nothing", ctx.findAllEventClashes([evs[2], evs[5]]).length, 0);
  eq("empty is quiet", ctx.findAllEventClashes([]).length, 0);
}

console.log("\n— nextBookingId: allocation —");
{
  eq("empty array starts at 1", ctx.nextBookingId([]), 1);
  eq("takes the max, not the length", ctx.nextBookingId([{id:1},{id:7},{id:3}]), 8);
  eq("ignores non-numeric ids", ctx.nextBookingId([{id:"A123"},{id:4}]), 5);
  // The bug this replaced: allocating from a SHORT (stale) list hands back an
  // id the server has already used, and the save then overwrites that record.
  const server = [{id:1},{id:2},{id:3}];
  const staleTab = [{id:1},{id:2}];
  ok("allocating from a stale copy collides with a live id — why allocation moved server-side",
     server.some(b => b.id === ctx.nextBookingId(staleTab)));
  ok("allocating from the server's own array does not collide",
     !server.some(b => b.id === ctx.nextBookingId(server)));
}

console.log("\n— outstandingContracts: chasing unsigned booking forms —");
{
  const iso = d => new Date(Date.now() - d * 86400000).toISOString();
  const today = new Date().toISOString().slice(0, 10);
  const ev = (id, contract) => ({ id, couple: "C" + id, date: "2027-01-01", contract });

  eq("chase threshold is a fortnight", CHASE_DAYS, 14);
  eq("sent 20 days ago and still out — chase",
     ctx.outstandingContracts([ev(1, { sentAt: iso(20), status: "sent" })], today).length, 1);
  eq("sent 3 days ago — leave it alone",
     ctx.outstandingContracts([ev(1, { sentAt: iso(3), status: "sent" })], today).length, 0);
  eq("exactly 14 days is chased",
     ctx.outstandingContracts([ev(1, { sentAt: iso(14), status: "sent" })], today).length, 1);
  eq("13 days is not",
     ctx.outstandingContracts([ev(1, { sentAt: iso(13), status: "sent" })], today).length, 0);
  eq("a signed contract is never chased",
     ctx.outstandingContracts([ev(1, { sentAt: iso(60), status: "Completed" })], today).length, 0);
  eq("status match is case-insensitive",
     ctx.outstandingContracts([ev(1, { sentAt: iso(60), status: "COMPLETED" })], today).length, 0);
  eq("declined is settled, not outstanding",
     ctx.outstandingContracts([ev(1, { sentAt: iso(60), status: "declined" })], today).length, 0);
  eq("voided is settled too",
     ctx.outstandingContracts([ev(1, { sentAt: iso(60), status: "voided" })], today).length, 0);
  eq("a TEST contract is never chased — nobody was emailed",
     ctx.outstandingContracts([ev(1, { sentAt: iso(60), status: "sent", testMode: true })], today).length, 0);
  eq("an event with no contract is ignored", ctx.outstandingContracts([ev(1, null)], today).length, 0);
  eq("a contract with no sentAt is ignored",
     ctx.outstandingContracts([ev(1, { status: "sent" })], today).length, 0);
  eq("missing status defaults to outstanding",
     ctx.outstandingContracts([ev(1, { sentAt: iso(30) })], today).length, 1);

  const many = ctx.outstandingContracts([
    ev(1, { sentAt: iso(20), status: "sent" }),
    ev(2, { sentAt: iso(90), status: "sent" }),
    ev(3, { sentAt: iso(40), status: "sent" }),
  ], today);
  eq("longest outstanding is listed first", many[0].booking.id, 2);
  eq("and the day count is reported", many[0].days, 90);
}

console.log("\n— pendingButPaid: money taken on a booking that still reads pending —");
{
  const bk = (id, status, schedule) => ({ id, guestName:"G", status, schedule });
  eq("a pending booking with a paid deposit is flagged",
     ctx.pendingButPaid([bk("W1","pending",[{label:"Deposit",paid:true},{label:"Balance",paid:false}])]).length, 1);
  eq("a pending booking with nothing paid is left alone — that is a real abandoned checkout",
     ctx.pendingButPaid([bk("W2","pending",[{label:"Deposit",paid:false},{label:"Balance",paid:false}])]).length, 0);
  eq("a confirmed booking is not flagged",
     ctx.pendingButPaid([bk("W3","confirmed",[{label:"Deposit",paid:true}])]).length, 0);
  eq("a cancelled booking that once took money is not flagged",
     ctx.pendingButPaid([bk("W4","cancelled",[{label:"Deposit",paid:true}])]).length, 0);
  eq("a completed booking is not flagged",
     ctx.pendingButPaid([bk("W5","completed",[{label:"Deposit",paid:true}])]).length, 0);
  eq("a pending booking with no schedule at all is fine",
     ctx.pendingButPaid([bk("W6","pending",undefined)]).length, 0);
  eq("an empty diary is quiet", ctx.pendingButPaid([]).length, 0);

  // The shape of the real record, as read out of production.
  const W15032 = { id:"W15032", status:"pending", guestName:"Emily Light",
    schedule:[{ label:"Deposit", paid:true, paidAmount:1170 }, { label:"Balance", paid:false }] };
  eq("the booking that prompted this is caught", ctx.pendingButPaid([W15032]).length, 1);
  // ...and the three that were genuinely pending are not.
  const genuinelyPending = ["a197","a207","a209"].map(id =>
    bk(id, "pending", [{label:"Deposit",paid:false},{label:"Balance",paid:false}]));
  eq("the three genuinely-unpaid pending bookings stay quiet",
     ctx.pendingButPaid(genuinelyPending).length, 0);
}

console.log("\n— lastContactFrom: what counts as being in touch —");
{
  const T0 = "2026-09-08";
  const e = (x) => Object.assign({ id:"enq_x", name:"A", email:"guest@example.com" }, x);

  // The reported bug: a reply last week didn't count unless someone logged it.
  {
    const r = ctx.lastContactFrom(e({ contacts:[{date:"2026-01-01",method:"email"}] }),
      { "guest@example.com": { date:"2026-09-05" } }, T0);
    eq("a recent email beats an old logged contact", r.date, "2026-09-05");
    eq("and is reported as email", r.method, "email");
  }
  {
    const r = ctx.lastContactFrom(e({ contacts:[{date:"2026-09-07",method:"phone"}] }),
      { "guest@example.com": { date:"2026-09-05" } }, T0);
    eq("a newer logged contact still wins", r.date, "2026-09-07");
    eq("and keeps its own method", r.method, "phone");
  }
  {
    const r = ctx.lastContactFrom(e({}), { "guest@example.com": { date:"2026-09-05" } }, T0);
    eq("email alone is enough", r.date, "2026-09-05");
  }
  {
    const r = ctx.lastContactFrom(e({ email:"  GUEST@Example.COM " }),
      { "guest@example.com": { date:"2026-09-05" } }, T0);
    ok("the address is matched case- and space-insensitively", r && r.date === "2026-09-05");
  }
  {
    const r = ctx.lastContactFrom(e({}), { "guest@example.com": { date:null } }, T0);
    ok("a cached \"never emailed\" is not treated as contact",
       !r || r.method !== "email");
  }
  {
    const r = ctx.lastContactFrom(e({ id:"enq_x" }), {}, T0);
    ok("no sources at all means no answer", r === null);
  }
  // The pre-existing rules must survive the change.
  {
    const r = ctx.lastContactFrom(e({ viewings:[{date:"2026-09-06"}] }), {}, T0);
    eq("a viewing that has happened counts", r.date, "2026-09-06");
    eq("and says so", r.method, "viewing");
  }
  {
    const r = ctx.lastContactFrom(e({ viewings:[{date:"2026-12-01"}] }), {}, T0);
    ok("a viewing still to come does not count", r === null);
  }
  {
    const ts = Date.parse("2026-09-02T10:00:00Z");
    const r = ctx.lastContactFrom({ id:"enq_" + ts, email:"" }, {}, T0);
    eq("the enquiry's own arrival counts", r.date, "2026-09-02");
    eq("and is labelled", r.method, "enquiry received");
  }
  {
    const ts = Date.parse("2026-09-02T10:00:00Z");
    const r = ctx.lastContactFrom({ id:"enq_" + ts, email:"guest@example.com" },
      { "guest@example.com": { date:"2026-09-06" } }, T0);
    eq("email beats the arrival date when it is newer", r.date, "2026-09-06");
  }
  ok("a missing emailSeen map is harmless",
     ctx.lastContactFrom(e({ contacts:[{date:"2026-09-01"}] }), null, T0).date === "2026-09-01");
}

console.log("\n— the annual report —");
{
  // The corkage bug, stated as a test: this is the string that used to become
  // £9,100 of corkage on one wedding.
  eq("free-text corkage parses to a nonsense number (why it is no longer used)",
     ctx.parseMoney("£9 per adult - 100 guests invoiced"), 9100);
  eq("the numeric corkage field parses correctly", ctx.parseMoney("950"), 950);
  eq("an empty corkage total is zero, not a guess", ctx.parseMoney(""), 0);

  const ev = (t) => ({ eventType:t });
  const by = ctx.countByEventType([ev("Wedding (Peak)"),ev("Party"),ev("Wedding (Peak)"),ev("Wake"),ev("Party"),ev("Party")]);
  eq("counts each type", by.length, 3);
  eq("declared order is preserved — weddings first", by[0].type, "Wedding (Peak)");
  eq("with the right count", by[0].count, 2);
  eq("parties counted", by.find(x=>x.type==="Party").count, 3);
  ok("each type carries its colour", by.every(x => /^#[0-9a-f]{6}$/i.test(x.colour)));
  ok("the two wedding types are different shades",
     ctx.eventTypeColour("Wedding (Peak)") !== ctx.eventTypeColour("Wedding (Off Peak)"));
  ok("weddings are red and parties blue, as asked",
     ctx.eventTypeColour("Wedding (Peak)") === "#dc2626" && ctx.eventTypeColour("Party") === "#2563eb");
  {
    const b2 = ctx.countByEventType([{ eventType:"Handfasting" }, ev("Party")]);
    eq("an unrecognised type still appears", b2.length, 2);
    eq("known types sort before unknown ones", b2[0].type, "Party");
    ok("and the unknown one gets the fallback colour",
       b2[1].colour === ctx.eventTypeColour("Handfasting"));
  }
  {
    const b3 = ctx.countByEventType([{}, {}]);
    eq("an event with no type counts as Other", b3[0].type, "Other");
    eq("and is counted", b3[0].count, 2);
  }
  eq("an empty year produces no types", ctx.countByEventType([]).length, 0);
}

console.log("\n— matchContractStay: update, create, or warn —");
{
  const EV = 42;
  const linked  = (id, prop, ci, co, extra) => Object.assign(
    { id, guestName:"Wedding party", status:"confirmed", linkedEventId: EV,
      stays:[{ propertyId:prop, checkIn:ci, checkOut:co, value:800 }] }, extra||{});
  const other   = (id, prop, ci, co, extra) => Object.assign(
    { id, guestName:"Someone else", status:"confirmed", linkedEventId:null,
      stays:[{ propertyId:prop, checkIn:ci, checkOut:co, value:600 }] }, extra||{});
  const row = (ci, co) => ({ checkIn:ci, checkOut:co, value:950, maybe:false });

  // The case Toby asked for: the event already holds this property, so update.
  {
    const m = ctx.matchContractStay(row("2027-06-04","2027-06-07"), "amly", EV,
      [linked("A1","amly","2027-06-04","2027-06-07")]);
    ok("an existing linked booking is the update target", m.target && m.target.id === "A1");
    eq("and it is not reported as a clash", m.clashes.length, 0);
  }

  // A contract that moves the dates must move THAT booking, not add a second.
  {
    const m = ctx.matchContractStay(row("2027-06-11","2027-06-14"), "amly", EV,
      [linked("A1","amly","2027-06-04","2027-06-07")]);
    ok("a linked booking still matches when the contract moves the dates",
       m.target && m.target.id === "A1");
  }

  // Somebody else's nights.
  {
    const m = ctx.matchContractStay(row("2027-06-04","2027-06-07"), "amly", EV,
      [other("B1","amly","2027-06-05","2027-06-08")]);
    ok("an unlinked overlapping booking is not updated", m.target === null);
    eq("it is reported as a clash", m.clashes.length, 1);
    ok("and named", m.clashes[0].booking.id === "B1");
  }

  // Nothing there at all.
  {
    const m = ctx.matchContractStay(row("2027-06-04","2027-06-07"), "amly", EV, []);
    ok("an empty diary means create", m.target === null);
    eq("with nothing to warn about", m.clashes.length, 0);
  }

  // Both at once: ours to update, theirs to warn about.
  {
    const m = ctx.matchContractStay(row("2027-06-04","2027-06-07"), "amly", EV,
      [linked("A1","amly","2027-06-04","2027-06-07"), other("B1","amly","2027-06-05","2027-06-08")]);
    ok("updates ours", m.target && m.target.id === "A1");
    eq("and still warns about theirs", m.clashes.length, 1);
  }

  // Precision checks — the ways this could quietly do the wrong thing.
  {
    const m = ctx.matchContractStay(row("2027-06-04","2027-06-07"), "amly", EV,
      [linked("A1","hamlet","2027-06-04","2027-06-07")]);
    ok("a linked booking for a DIFFERENT property is not the target", m.target === null);
  }
  {
    const m = ctx.matchContractStay(row("2027-06-04","2027-06-07"), "amly", EV,
      [linked("A1","amly","2027-06-04","2027-06-07",{ status:"cancelled" })]);
    ok("a cancelled linked booking is not updated", m.target === null);
  }
  {
    const m = ctx.matchContractStay(row("2027-06-04","2027-06-07"), "amly", EV,
      [other("B1","amly","2027-06-07","2027-06-10")]);
    eq("a changeover on the same day is not a clash", m.clashes.length, 0);
  }
  {
    const m = ctx.matchContractStay(row("2027-06-04","2027-06-07"), "amly", 99,
      [linked("A1","amly","2027-06-04","2027-06-07")]);
    ok("a booking linked to a DIFFERENT event is not ours to update", m.target === null);
    eq("it is somebody else's clash instead", m.clashes.length, 1);
  }
  {
    const m = ctx.matchContractStay(row("2027-06-04","2027-06-07"), "", EV,
      [linked("A1","amly","2027-06-04","2027-06-07")]);
    ok("no property chosen yet means no target", m.target === null);
    eq("and nothing to warn about", m.clashes.length, 0);
  }
  // Two linked bookings for one property: prefer the one that actually overlaps.
  {
    const m = ctx.matchContractStay(row("2027-06-04","2027-06-07"), "amly", EV,
      [linked("A1","amly","2027-01-01","2027-01-03"), linked("A2","amly","2027-06-04","2027-06-07")]);
    ok("the overlapping linked booking wins over an unrelated one",
       m.target && m.target.id === "A2");
  }
  // A booking with no stays array at all (legacy shape).
  {
    const legacy = { id:"L1", status:"confirmed", linkedEventId:EV,
                     propertyId:"amly", checkIn:"2027-06-04", checkOut:"2027-06-07" };
    const m = ctx.matchContractStay(row("2027-06-04","2027-06-07"), "amly", EV, [legacy]);
    ok("a legacy booking with no stays array still matches", m.target && m.target.id === "L1");
  }
}

console.log("\n— signedUnfiledContracts: what the nightly job surfaces —");
{
  const ev = (id, contract, files) => ({ id, couple:"C"+id, contract, files: files||[] });
  eq("signed with no copy filed is flagged",
     ctx.signedUnfiledContracts([ev(1,{documentId:"d1",status:"completed"})]).length, 1);
  eq("signed and already filed is not",
     ctx.signedUnfiledContracts([ev(1,{documentId:"d1",status:"completed"},
       [{signwellDocumentId:"d1"}])]).length, 0);
  eq("a file from a DIFFERENT contract doesn't count as filed",
     ctx.signedUnfiledContracts([ev(1,{documentId:"d1",status:"completed"},
       [{signwellDocumentId:"d0"}])]).length, 1);
  eq("still out for signature is not flagged here",
     ctx.signedUnfiledContracts([ev(1,{documentId:"d1",status:"sent"})]).length, 0);
  eq("a test contract is never flagged",
     ctx.signedUnfiledContracts([ev(1,{documentId:"d1",status:"completed",testMode:true})]).length, 0);
  eq("case-insensitive on status",
     ctx.signedUnfiledContracts([ev(1,{documentId:"d1",status:"Completed"})]).length, 1);
  eq("no contract, nothing to say", ctx.signedUnfiledContracts([ev(1,null)]).length, 0);
}

console.log("\n— the nightly job (netlify/functions/check-contracts.js) —");
{
  const JOB = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "check-contracts.js"), "utf8");
  const jobCtx = {};
  const grab = (name) => {
    const st = JOB.indexOf("function " + name + "(");
    let i = JOB.indexOf("{", st), d = 0, e = -1;
    for (; i < JOB.length; i++) { if (JOB[i]==="{") d++; else if (JOB[i]==="}") { d--; if(!d){e=i+1;break;} } }
    return JOB.slice(st, e);
  };
  const SETTLED = JOB.match(/const SETTLED = (\[[^\]]*\])/)[1];
  (0, eval)("const SETTLED = " + SETTLED + ";\n" + grab("isSettled") + "\n" + grab("outstanding") +
            "\nglobalThis.__job = { isSettled, outstanding };");
  Object.assign(jobCtx, globalThis.__job);

  ok("completed counts as settled", jobCtx.isSettled("completed"));
  ok("declined counts as settled", jobCtx.isSettled("Declined"));
  ok("both spellings of cancelled are settled",
     jobCtx.isSettled("canceled") && jobCtx.isSettled("cancelled"));
  ok("sent is not settled", !jobCtx.isSettled("sent"));
  ok("an empty status is not settled", !jobCtx.isSettled(""));

  const mk = (c) => ({ id:1, contract:c });
  eq("an outstanding contract is picked up",
     jobCtx.outstanding([mk({documentId:"d",sentAt:"2026-01-01",status:"sent"})]).length, 1);
  eq("a signed one is left alone",
     jobCtx.outstanding([mk({documentId:"d",sentAt:"2026-01-01",status:"completed"})]).length, 0);
  eq("a test contract is never polled — it would burn API calls for nothing",
     jobCtx.outstanding([mk({documentId:"d",sentAt:"2026-01-01",status:"sent",testMode:true})]).length, 0);
  eq("a contract that was never sent is skipped",
     jobCtx.outstanding([mk({documentId:"d",status:"sent"})]).length, 0);
  eq("an event with no contract is skipped", jobCtx.outstanding([{id:1}]).length, 0);
  eq("a missing status still counts as outstanding",
     jobCtx.outstanding([mk({documentId:"d",sentAt:"2026-01-01"})]).length, 1);

  // The job must agree with the app about what "still out" means, or the home
  // page chases contracts the job has stopped polling (or the reverse).
  const iso = d => new Date(Date.now() - d*86400000).toISOString();
  const today = new Date().toISOString().slice(0,10);
  ["sent","Sent",""].forEach(function(st) {
    const appSays = ctx.outstandingContracts(
      [{ id:1, couple:"x", contract:{ documentId:"d", sentAt:iso(30), status:st } }], today).length > 0;
    const jobSays = jobCtx.outstanding(
      [{ id:1, contract:{ documentId:"d", sentAt:iso(30), status:st } }]).length > 0;
    ok("app and job agree that status \"" + st + "\" is still outstanding", appSays === jobSays);
  });
  ["completed","declined","voided","expired"].forEach(function(st) {
    const appSays = ctx.outstandingContracts(
      [{ id:1, couple:"x", contract:{ documentId:"d", sentAt:iso(30), status:st } }], today).length > 0;
    const jobSays = jobCtx.outstanding(
      [{ id:1, contract:{ documentId:"d", sentAt:iso(30), status:st } }]).length > 0;
    ok("app and job agree that status \"" + st + "\" is settled", appSays === false && jobSays === false);
  });
}

console.log("\n— the Airbnb overlap check (netlify/functions/sync-property-ical.js) —");
{
  const ICAL = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "sync-property-ical.js"), "utf8");
  const start = ICAL.indexOf("function overlapsExisting(");
  let i = ICAL.indexOf("{", start), depth = 0, end = -1;
  for (; i < ICAL.length; i++) {
    if (ICAL[i] === "{") depth++;
    else if (ICAL[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const icalCtx = {};
  // Indirect eval: a direct one would declare overlapsExisting into this very
  // block and collide with the binding we're trying to capture it into.
  (0, eval)(ICAL.slice(start, end) + "\nglobalThis.__ovl = overlapsExisting;");
  icalCtx.fn = globalThis.__ovl;
  const ovl = icalCtx.fn;
  const diary = [bk("A1", "amly", "2026-06-05", "2026-06-08")];
  eq("an Airbnb block on top of a booking is spotted",
     ovl(diary, "amly", "2026-06-06", "2026-06-09").length, 1);
  eq("a changeover is not flagged",
     ovl(diary, "amly", "2026-06-08", "2026-06-10").length, 0);
  eq("another property is not flagged",
     ovl(diary, "hamlet", "2026-06-06", "2026-06-09").length, 0);
  eq("a cancelled booking doesn't trigger a false alarm",
     ovl([bk("A1","amly","2026-06-05","2026-06-08",{status:"cancelled"})],
                      "amly", "2026-06-06", "2026-06-09").length, 0);
  // The app and the sync function must agree on the changeover rule, or the
  // front page would report clashes the sync deliberately allowed.
  ok("sync and app agree on the changeover rule",
     ovl(diary, "amly", "2026-06-08", "2026-06-10").length ===
     ctx.findAccomClashes(diary, bk("X", "amly", "2026-06-08", "2026-06-10")).length);
}

console.log("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
