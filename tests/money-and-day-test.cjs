// Damage deposit, the client statement, the VAT split and the function sheet,
// pinned. 23 October 2026.
//
//   · A damage deposit is refundable: never in the invoice stages, shown on the
//     statement as refundable while it is still to come, and only what is KEPT
//     reaches the VAT split (outside the scope).
//   · The statement promises only what is not already an invoice: no stage 1,
//     no stage linked to Xero, no stage whose date has passed, nothing for the
//     pre-2027 hand-invoiced seasons.
//   · The VAT split adds back up to the inc-VAT money it was given, with VAT
//     worked out from inc-VAT figures; adjustments keep their sign; a portal
//     part that did not load is reported, not read as zero.
//   · The function sheet escapes whatever the couple typed.
//
// The functions live inside App.jsx, which can't be imported outside a
// bundler, so their source is lifted out verbatim and evaluated here — the
// same approach as pencil-test.cjs: a retyped copy proves nothing.
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "src", "App.jsx"), "utf8");
const DAY = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "dayOrder.js"), "utf8")
  .replace(/export /g, "");

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
function liftConst(name) {
  const m = new RegExp("\\nconst " + name + "\\s+=").exec(SRC);
  if (!m) throw new Error("Could not find const " + name);
  const start = m.index + 1;
  let i = start, depth = 0;
  for (; i < SRC.length; i++) {
    const c = SRC[i];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if ((c === ";" || c === "\n") && depth === 0) break;
  }
  return SRC.slice(start, i + 1);
}

const CONSTS = ["XERO_ACCOUNT_EVENTS", "XERO_ACCOUNT_ACCOM", "INVOICE_STAGE_LABELS", "INVOICE_FIRST_EVENT_YEAR",
                "DAMAGE_DEPOSIT_STATES", "STATEMENT_STAGE_LABELS", "VAT_CATEGORIES", "STAFFING_FIELDS",
                "STAFFING_LABELS", "BAR_USAGE_LABEL", "DEFAULT_AUTOMATIONS", "AIRBNB_ESTIMATE_PCT"];
const NAMES = ["round2", "parseMoney", "isValidEventDate", "addDaysIso", "fmtDateLong", "fmtWeekdayLong", "eventTypeLabel",
               "eventAccomStays", "eventAccomExtras", "accomLineDescription", "invoiceStageDates",
               "computeEventInvoiceStages", "findPushedInvoice", "isInvoiceableYear", "fmtMoney", "hhmm",
               "damageDepositInfo", "eventStatementRows", "vatOfInclusive", "signedAmount", "eventVatSplit",
               "venueAnswerText", "venueFormAnswered", "fsEsc", "functionSheetHtml",
               "lastContactFrom", "automationDays",
               "longStayDiscountAmount", "seasonForDate", "getPriceForNight", "quoteStay",
               "lettingValue", "estimateLettingValue", "cashflowForecast", "cashflowExVat"];
const ctx = {};
eval(DAY + "\n" + CONSTS.map(liftConst).join("\n") + "\n" + NAMES.map(lift).join("\n\n") + "\n" +
     NAMES.concat(CONSTS).map(n => "ctx." + n + " = " + n + ";").join("\n"));

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}
function eq(label, got, want) { ok(label + "  (got " + JSON.stringify(got) + ")", JSON.stringify(got) === JSON.stringify(want)); }

const TODAY = "2026-10-23";
const ev = { id: 501, couple: "Ann & Bo", eventType: "Wedding (Peak)", date: "2027-06-05", status: "Confirmed",
             venueFee: "12000", deposit: "1000" };
const accom = [{ id: "a1", linkedEventId: 501, status: "confirmed", stays: [
  { propertyId: "hamlet", propertyName: "The Hamlet", checkIn: "2027-06-04", checkOut: "2027-06-06", nights: 2, value: 1800 }],
  extras: [{ desc: "Hot tub", amount: 100 }] }];

console.log("damage deposit");
{
  eq("none by default", ctx.damageDepositInfo(ev).amount, 0);
  const d = ctx.damageDepositInfo(Object.assign({}, ev, { damageDeposit: "250" }));
  ok("250 not received is outstanding", d.outstanding && !d.held && d.kept === 0);
  const p = ctx.damageDepositInfo(Object.assign({}, ev, { damageDeposit: "250", damageDepositState: "part", damageDepositKept: "80" }));
  ok("part kept: 80 kept, 170 back", p.kept === 80 && p.refund === 170 && !p.outstanding);
  const over = ctx.damageDepositInfo(Object.assign({}, ev, { damageDeposit: "250", damageDepositState: "part", damageDepositKept: "900" }));
  eq("cannot keep more than was taken", over.kept, 250);
  const stages = ctx.computeEventInvoiceStages(Object.assign({}, ev, { damageDeposit: "250" }), accom);
  ok("never on an invoice stage", stages.every(st => st.lines.every(l => !/damage/i.test(l.desc))));
  const same = ctx.computeEventInvoiceStages(ev, accom);
  eq("stage totals unchanged by a deposit", stages.map(s => s.total), same.map(s => s.total));
}

console.log("statement");
{
  const rows = ctx.eventStatementRows(ev, accom, [], TODAY);
  eq("stages 2 and 3, not 1", rows.map(r => r.label), ["Second payment", "Final balance"]);
  // Invoiced 1 Dec the year before, DUE 15 Jan of the wedding year (25 Oct 2026).
  eq("second is due 15 Jan of the wedding year", rows[0].due_on, "2027-01-15");
  eq("second is still invoiced 1 Dec the year before", ctx.computeEventInvoiceStages(ev, accom)[1].invoiceDate, "2026-12-01");
  eq("final is 28 days before", rows[1].due_on, "2027-05-08");
  // (12000 + 1800 + 100 - 1000) / 2 = 6450 each
  eq("amounts are the stage totals", rows.map(r => r.amount), [6450, 6450]);
  ok("lines carry only desc and amount", rows[0].lines.every(l => Object.keys(l).join() === "desc,amount"));
  const linked = ctx.eventStatementRows(ev, accom, [{ eventId: 501, stage: 2, xeroInvoiceId: "x" }], TODAY);
  eq("a linked stage is left to the invoice list", linked.map(r => r.label), ["Final balance"]);
  const invoicedNotDue = ctx.eventStatementRows(ev, accom, [], "2026-12-02");
  eq("invoiced but not yet due is still to come", invoicedNotDue.map(r => r.label), ["Second payment", "Final balance"]);
  const late = ctx.eventStatementRows(ev, accom, [], "2027-01-16");
  eq("a stage whose due date has passed is not promised", late.map(r => r.label), ["Final balance"]);
  // A January wedding: 15 Jan falls after the final balance, so the second
  // payment is due with it, never after the wedding.
  const jan = Object.assign({}, ev, { date: "2027-01-10" });
  const js = ctx.computeEventInvoiceStages(jan, accom);
  eq("January wedding: second due with the final balance", js[1].dueDate, js[2].invoiceDate);
  const old = ctx.eventStatementRows(Object.assign({}, ev, { date: "2026-11-20" }), [], [], TODAY);
  eq("hand-invoiced seasons publish nothing", old.length, 0);
  const dd = ctx.eventStatementRows(Object.assign({}, ev, { damageDeposit: "250" }), accom, [], TODAY);
  ok("outstanding deposit shown refundable, due with the final", dd.length === 3 && dd[2].refundable && dd[2].amount === 250 && dd[2].due_on === "2027-05-08");
  const got = ctx.eventStatementRows(Object.assign({}, ev, { damageDeposit: "250", damageDepositState: "received" }), accom, [], TODAY);
  eq("a received deposit is not asked for again", got.length, 2);
  eq("no date, no rows", ctx.eventStatementRows(Object.assign({}, ev, { date: "" }), accom, [], TODAY).length, 0);
}

console.log("VAT split");
{
  const portal = {
    drinks: { summary: { total: 2400, vat: 400 } },
    food: { choice: { package_name: "Hog roast", price_pp: 18, numbers: 100, vat_rate: 20 } },
    addons: { requests: [{ name: "Fire pit", qty: 2, unit_price: 60, vat_rate: 20, status: "approved" },
                         { name: "Asked only", qty: 1, unit_price: 99, vat_rate: 20, status: "requested" }] }
  };
  const e2 = Object.assign({}, ev, { damageDeposit: "250", damageDepositState: "part", damageDepositKept: "50",
    vatAdjustments: [{ id: "a", category: "venue", amount: "-500", note: "Ceremony fee, exempt" },
                     { id: "b", category: "exempt", amount: "500", note: "Ceremony fee, exempt" },
                     { id: "c", category: "food", amount: "", note: "blank" }] });
  const s = ctx.eventVatSplit(e2, accom, portal);
  const cat = id => s.cats.find(c => c.id === id);
  eq("venue: fee less the adjustment", cat("venue").inc, 11500);
  eq("venue VAT from inc", cat("venue").vat, 1916.67);
  eq("accommodation: stay plus extra", cat("accommodation").inc, 1900);
  eq("drinks take the summary's own VAT", [cat("drinks").inc, cat("drinks").vat], [2400, 400]);
  eq("food: per head × numbers", cat("food").inc, 1800);
  eq("extras: only confirmed", cat("extras").inc, 120);
  eq("exempt: moved fee plus deposit kept, no VAT", [cat("exempt").inc, cat("exempt").vat], [550, 0]);
  eq("total is everything inc VAT", s.inc, 11500 + 1900 + 2400 + 1800 + 120 + 550);
  ok("inc = vat + ex in every category", s.cats.every(c => Math.abs(c.inc - c.vat - c.ex) < 0.005));
  eq("nothing missing", s.missing, []);
  const none = ctx.eventVatSplit(ev, [], { drinks: null, food: {}, addons: null });
  eq("unloaded parts are reported", none.missing, ["drinks", "extras"]);
  const cork = ctx.eventVatSplit(Object.assign({}, ev, { corkageTotal: "450" }), [], { drinks: {}, food: {}, addons: {} });
  eq("diary corkage stands in when the portal has no drinks", cork.cats.find(c => c.id === "drinks").inc, 450);
  eq("an unknown category falls to exempt",
     ctx.eventVatSplit(Object.assign({}, ev, { venueFee: "", vatAdjustments: [{ category: "nope", amount: 10 }] }), [], {}).cats.find(c => c.id === "exempt").inc, 10);
  eq("signedAmount keeps the minus parseMoney drops", [ctx.signedAmount("-12.5"), ctx.signedAmount("abc"), ctx.parseMoney("-12")], [-12.5, 0, 12]);
}

console.log("function sheet");
{
  const html = ctx.functionSheetHtml(
    Object.assign({}, ev, { notes: "<script>alert(1)</script>", dayManager: ["TS"], staffShifts: { TS: { start: "09:00", end: "18:00" } } }),
    {
      numbers: { told_us: true, seated_adults: 90, seated_children: 6, seated_babies: 1, seated_total: 97, evening_total: 140 },
      day: { questions: [{ qkey: "officiant_name", section: "Your ceremony", label: "Who is conducting it?", kind: "text" },
                         { qkey: "dropoff_date", section: "Dropping off", label: "When?", kind: "date" },
                         { qkey: "confetti", section: "On the day", label: "Confetti?", kind: "yesno" }],
             answers: { officiant_name: "Jo <b>Reg</b>", dropoff_date: "2027-06-04", confetti: "yes" },
             contacts: [{ id: "1", name: "Sam", role: "Best man", phone: "07700 900123" }] },
      timeline: { days: [{ day_key: "event", label: "The day", fixed: [{ time: "00:30", title: "Site closes" }] }],
                  blocks: [{ day_key: "event", start_time: "14:00", title: "Ceremony", prompts: "Who will greet?", answers: ["Uncle Tom"] }] },
      items: { items: [{ name: "Signs", qty: 3, take_home_by: "Sam", received_at: "2027-06-04T10:00:00Z" }] },
      guests: { __error: "not_admin" },
      drinks: { __error: "failed (500)" }
    },
    [{ id: "TS", name: "Toby" }], "23 Oct 2026");
  ok("couple's text is escaped", html.indexOf("<script>alert") === -1 && html.indexOf("&lt;script&gt;") !== -1 && html.indexOf("Jo &lt;b&gt;Reg") !== -1);
  ok("numbers from the portal", html.indexOf("Seated in all") !== -1 && html.indexOf(">97<") !== -1);
  ok("ceremony and contact", html.indexOf("Conducted by") !== -1 && html.indexOf("Best man") !== -1 && html.indexOf("07700 900123") !== -1);
  ok("timeline answers shown, site close after the ceremony",
     html.indexOf("Uncle Tom") !== -1 && html.indexOf("Ceremony") < html.indexOf("Site closes"));
  ok("rota with shift", html.indexOf("Toby") !== -1 && html.indexOf("09:00–18:00") !== -1);
  ok("checklist ticks what has arrived", /Signs × 3[\s\S]*Sam[\s\S]*✓[\s\S]*☐/.test(html));
  ok("drop-off slot", html.indexOf("Dropping off:") !== -1);
  ok("other venue-form answers in notes", html.indexOf("Confetti?") !== -1 && html.indexOf(">Yes<") !== -1);
  ok("a part that failed says so", html.indexOf("Drinks could not be loaded") !== -1);
  ok("non-admin is told why dietary notes are missing", html.indexOf("only shown to an admin login") !== -1);
}

console.log("cashflow: Airbnb paid out the day after arrival");
{
  const lets = [
    { id: "a1", source: "airbnb", status: "confirmed", guestName: "Sam Airbnb", value: 900,
      stays: [{ propertyId: "hamlet", checkIn: "2026-11-27", checkOut: "2026-12-01", value: 900 }],
      schedule: [{ label: "Deposit", amount: 450, paid: true }, { label: "Balance", amount: 450, paid: false, dueDate: "2026-11-01" }] },
    { id: "a2", source: "airbnb", status: "confirmed", guestName: "Gone Airbnb", value: 500, stays: [{ propertyId: "hamlet", checkIn: "2026-10-01", checkOut: "2026-10-03" }] },
    { id: "a3", source: "airbnb", status: "confirmed", guestName: "Unpriced Airbnb", value: 0, stays: [{ propertyId: "nowhere", checkIn: "2026-11-05", checkOut: "2026-11-07" }] },
    { id: "a4", source: "airbnb", status: "cancelled", guestName: "Cancelled", value: 700, stays: [{ propertyId: "hamlet", checkIn: "2026-11-05", checkOut: "2026-11-07" }] },
    { id: "d1", source: "direct", status: "confirmed", guestName: "Direct", schedule: [{ label: "Balance", amount: 300, paid: false, dueDate: "2026-11-10" }] },
    { id: "a5", source: "airbnb", status: "confirmed", guestName: "Paid Airbnb", value: 3615, airbnb: { payoutExpected: 3615, payoutPaid: 3615 },
      stays: [{ propertyId: "hamlet", checkIn: "2026-10-24", checkOut: "2026-10-27" }] },
    { id: "a6", source: "airbnb", status: "confirmed", guestName: "Here now", value: 400, airbnb: { payoutExpected: 400 },
      stays: [{ propertyId: "amly", checkIn: "2026-10-22", checkOut: "2026-10-26" }] },
    { id: "a7", source: "airbnb", status: "confirmed", guestName: "Month end", value: 600,
      stays: [{ propertyId: "amly", checkIn: "2026-12-31", checkOut: "2027-01-02" }] }
  ];
  const f = ctx.cashflowForecast([], lets, null, "2026-10-24", []);
  const month = (m) => f.months.find((r) => r.month === m);
  eq("counted the day after arrival, not by its schedule", [month("2026-11").lets, month("2026-12").lets], [1200, 0]);
  ok("labelled as an Airbnb payout", month("2026-11").items.some((i) => i.what === "Airbnb payout" && i.when === "2026-11-28"));
  ok("a payout the emails show as sent is taken as received", !f.months.some((r) => r.items.some((i) => i.who === "Paid Airbnb")));
  ok("arrived, not yet paid out: due now", month("2026-10").items.some((i) => i.who === "Here now" && i.when === "2026-10-24" && i.amount === 400));
  ok("arriving 31 Dec pays out in January", month("2027-01").items.some((i) => i.who === "Month end" && i.when === "2027-01-01"));
  eq("a let already over is taken as received", f.months.reduce((a, r) => a + r.items.filter((i) => i.who === "Gone Airbnb").length, 0), 0);
  eq("one with no figure and no rate is reported, not counted", f.unpriced.map((u) => u.who), ["Unpriced Airbnb"]);
  eq("not reported as overdue", f.overdue.lets, 0);
}

console.log("Airbnb fallback estimate: 95% of our calendar rate");
{
  const props = [{ id: "hamlet", baseRate: 1000, seasons: [], longStayThreshold: 0 }];
  const est = ctx.lettingValue({ source: "airbnb", value: 0, stays: [{ propertyId: "hamlet", checkIn: "2027-03-05", checkOut: "2027-03-07" }] }, props);
  eq("two nights at 1000 come to 1900", [est.value, est.estimated], [1900, true]);
  const real = ctx.lettingValue({ source: "airbnb", value: 2193.1, stays: [{ propertyId: "hamlet", checkIn: "2027-03-05", checkOut: "2027-03-07" }] }, props);
  eq("a booking with Airbnb's figure keeps it", [real.value, real.estimated], [2193.1, false]);
}

console.log("cashflow: net of VAT for the report");
{
  const ev = { id: 910, couple: "Net", eventType: "Wedding", status: "Confirmed", date: "2027-06-05", venueFee: "12000", deposit: "1000" };
  const held = Object.assign({}, ev, { id: 911, couple: "Held", status: "Holding", date: "2027-07-03" });
  const lets = [
    { id: "n1", source: "direct", status: "confirmed", guestName: "Direct", schedule: [
      { label: "Balance", amount: 300, paid: false, dueDate: "2026-11-10" },
      { label: "Deposit", amount: 120, paid: false, dueDate: "2026-10-01" }] }
  ];
  const inc = ctx.cashflowForecast([ev, held], lets, null, "2026-10-24", []);
  const f = ctx.cashflowExVat(inc);
  const m = (k) => f.months.find((r) => r.month === k);
  eq("events and lettings lose a sixth", [m("2026-12").conf, m("2026-11").lets], [4583.33, 250]);
  eq("holding too (deposit now plus the second invoice)", [m("2026-10").hold, m("2026-12").hold], [833.33, 4583.33]);
  eq("overdue too", f.overdue.lets, 100);
  ok("every month adds up to the lines it lists", f.months.every((r) =>
    Math.abs(r.conf + r.hold + r.lets - r.items.reduce((a, i) => a + i.amount, 0)) < 0.005));
  ok("the inc-VAT forecast is left as it was", inc.months.find((r) => r.month === "2026-12").conf === 5500);
}

console.log("cashflow: wedding accommodation, when decided");
{
  const ev = { id: 900, couple: "Ann & Bo", eventType: "Wedding", status: "Confirmed", date: "2027-06-05", venueFee: "12000", deposit: "1000" };
  const held = Object.assign({}, ev, { id: 901, couple: "Held", status: "Holding", date: "2027-07-03" });
  const old = { id: 902, couple: "Old", eventType: "Wedding", status: "Confirmed", date: "2026-11-30", venueFee: "5000" };
  const lets = [
    { id: "w1", linkedEventId: 900, status: "confirmed", bookingType: "Wedding", stays: [
      { propertyId: "hamlet", propertyName: "The Hamlet", checkIn: "2027-06-04", checkOut: "2027-06-06", nights: 2, value: 2900 },
      { propertyId: "amly", propertyName: "Amly Barn", checkIn: "2027-06-04", checkOut: "2027-06-06", nights: 2, value: 1050, maybe: true },
      { propertyId: "glamping", propertyName: "Glamping", checkIn: "2027-06-04", checkOut: "2027-06-06", nights: 2, value: 0 }],
      schedule: [{ label: "Deposit", amount: 999, paid: false, dueDate: "2027-01-01" }] },
    { id: "w2", linkedEventId: 901, status: "confirmed", stays: [{ propertyId: "hamlet", checkIn: "2027-07-02", checkOut: "2027-07-04", nights: 2, value: 2000 }] },
    { id: "w3", linkedEventId: 902, status: "confirmed", stays: [{ propertyId: "amly", checkIn: "2026-11-29", checkOut: "2026-12-01", value: 780 }],
      schedule: [{ label: "Balance", amount: 780, paid: false, dueDate: "2026-11-01" }] }
  ];
  const f = ctx.cashflowForecast([ev, held, old], lets, null, "2026-10-24", []);
  const m = (k) => f.months.find((r) => r.month === k) || { conf: 0, hold: 0, lets: 0, items: [] };
  // second invoice 1 Dec 2026: venue 6000 - deposit 500 = 5500, Hamlet half 1450; Amly (provisional) and glamping (unpriced) left out
  eq("December: venue part to Events, decided rooms to Lettings", [m("2026-12").conf, m("2026-12").lets], [5500, 1450]);
  eq("May (final, 28 days before): the same split", [m("2027-05").conf, m("2027-05").lets], [5500, 1450]);
  ok("labelled as wedding accommodation", m("2026-12").items.some((i) => /Wedding accommodation/.test(i.what) && i.amount === 1450));
  ok("its own placeholder schedule is not counted as well", !f.months.some((r) => r.items.some((i) => i.amount === 999)));
  // held: venue 6000 - 500 deposit + Hamlet half 1000, all of it Holding
  eq("a held event's rooms stay in Holding", m("2026-12").hold, 6500);
  ok("held event: nothing in Lettings for it", !f.months.some((r) => r.items.some((i) => i.who === "Held" && i.kind === "Lettings")));
  eq("a hand-invoiced season's rooms come from their own schedule", m("2026-11").lets, 780);
}

console.log("follow-up settings: the app and the function agree");
{
  const A = require("../netlify/functions/automations.js")._test;
  eq("the same three steps", Object.keys(ctx.DEFAULT_AUTOMATIONS), A.STEPS);
  eq("same standard wording in both", Object.keys(ctx.DEFAULT_AUTOMATIONS).map(k => [ctx.DEFAULT_AUTOMATIONS[k].subject, ctx.DEFAULT_AUTOMATIONS[k].body]),
     Object.keys(A.DEFAULTS).map(k => [A.DEFAULTS[k].subject, A.DEFAULTS[k].body]));
  eq("same days and Freezing defaults", Object.keys(ctx.DEFAULT_AUTOMATIONS).map(k => [ctx.DEFAULT_AUTOMATIONS[k].days, !!ctx.DEFAULT_AUTOMATIONS[k].freezeOn, ctx.DEFAULT_AUTOMATIONS[k].freezeDays || null]),
     Object.keys(A.DEFAULTS).map(k => [A.DEFAULTS[k].days, !!A.DEFAULTS[k].freezeOn, A.DEFAULTS[k].freezeDays || null]));
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
