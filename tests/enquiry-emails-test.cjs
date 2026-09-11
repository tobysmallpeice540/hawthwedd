// The Emails Sent panel on an enquiry.
//
// It used to be "Viewing Emails Sent" and filtered to template ids beginning
// `viewing_`, so an enquiry that had been sent the brochure — or arrival
// information, or a balance request — read as one nobody had written to.
//
// `EmailHistoryPanel` lives inside App.jsx and cannot be imported, so this does
// two things: it lifts the one pure function out of the shipped source and
// exercises it, and it reads the call sites back to check the filter really is
// gone from the enquiry and really is still there on the event form, which was
// deliberate rather than forgotten.
const fs = require("fs");
const path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "src", "App.jsx"), "utf8");

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log("  FAIL " + label); }
}
const eq = (l, got, want) =>
  ok(l + "  (got " + JSON.stringify(got) + ")", got === want);

// ── Lift emailKindLabel and its table out of the shipped file ───────────────
function lift(startsWith, endsWith) {
  const i = SRC.indexOf(startsWith);
  if (i === -1) throw new Error("not found in App.jsx: " + startsWith);
  const j = SRC.indexOf(endsWith, i);
  if (j === -1) throw new Error("no close for: " + startsWith);
  return SRC.slice(i, j + endsWith.length);
}
const table = lift("const EMAIL_KIND_LABELS = {", "\n};");
const fn    = lift("function emailKindLabel(kind) {", "\n}");
const emailKindLabel = new Function(table + "\n" + fn + "\nreturn emailKindLabel;")();

console.log("\nNaming an email");
eq("the brochure reply", emailKindLabel("brochure_request"), "Brochure");
eq("a viewing confirmation", emailKindLabel("viewing_confirm"), "Viewing confirmed");
eq("a moved viewing", emailKindLabel("viewing_amend"), "Viewing moved");
eq("a declined viewing", emailKindLabel("viewing_decline"), "Viewing declined");
eq("a deposit request", emailKindLabel("deposit_request"), "Deposit request");
eq("a balance request", emailKindLabel("balance_request"), "Balance request");
eq("money in", emailKindLabel("payment_confirmation"), "Payment received");
eq("arrival info, either template", emailKindLabel("arrival_event"), "Arrival info");
eq("a portal sign-in", emailKindLabel("portal-signin"), "Portal sign-in");

// Every kind the live log actually holds, read out of production on
// 11 September 2026. None of them may come back blank.
const LIVE_KINDS = ["viewing_confirm", "deposit_request", "booking_confirmed",
  "payment_confirmation", "viewing_amend", "portal-signin", "portal-invite",
  "balance_request", "arrival_general", "viewing_decline", "brochure_request",
  "table_reserved"];
ok("every kind in the live log has a name",
   LIVE_KINDS.every(k => !!emailKindLabel(k)));

// A template added later must still read sensibly without anyone editing the
// table — the failure to avoid is a raw id shown to Toby.
eq("an unknown id is tidied, not dropped", emailKindLabel("welcome_pack_v2"), "Welcome pack v2");
eq("and a hyphenated one too", emailKindLabel("supplier-reminder"), "Supplier reminder");
eq("nothing at all stays nothing", emailKindLabel(""), "");
eq("and so does a missing one", emailKindLabel(undefined), "");

// ── The matching rule, as EmailHistoryPanel writes it ───────────────────────
// Modelled from the shipped source: match on booking id or on recipient
// address, then apply the type filter if there is one.
function matches(log, { bookingId, emails, typeFilter }) {
  const emailSet = (emails || []).filter(Boolean).map(e => e.toLowerCase());
  return log.filter(e => {
    const byBooking = bookingId && e.bookingId && String(e.bookingId) === String(bookingId);
    const byEmail = emailSet.length && e.to && emailSet.indexOf(String(e.to).toLowerCase()) !== -1;
    if (!byBooking && !byEmail) return false;
    if (typeFilter && !typeFilter(e.type || e.template || "")) return false;
    return true;
  });
}

const LOG = [
  { id: "1", to: "jo@example.com",  template: "viewing_confirm",  subject: "Viewing confirmed" },
  { id: "2", to: "JO@Example.com",  template: "brochure_request", subject: "Your brochure" },
  { id: "3", to: "jo@example.com",  template: "arrival_general",  subject: "Your arrival" },
  { id: "4", to: "someone@else.com", template: "brochure_request", subject: "Your brochure" },
  { id: "5", to: "jo@example.com",  template: "balance_request",  subject: "Balance due" },
];

console.log("\nWhat an enquiry shows");
const shown = matches(LOG, { emails: ["jo@example.com"] }).map(e => e.id);
eq("everything sent to that address", JSON.stringify(shown), JSON.stringify(["1", "2", "3", "5"]));
ok("including the brochure reply", shown.indexOf("2") !== -1);
ok("and never somebody else's", shown.indexOf("4") === -1);
ok("an address matches whatever case it was logged in", shown.indexOf("2") !== -1);

// What the old filter did, kept here so the regression is legible.
const oldWay = matches(LOG, { emails: ["jo@example.com"], typeFilter: t => t.indexOf("viewing_") === 0 })
  .map(e => e.id);
eq("the old viewings-only filter showed one of the four", JSON.stringify(oldWay), JSON.stringify(["1"]));

// ── The call sites, read back out of the shipped file ───────────────────────
console.log("\nThe shipped call sites");

const enquiryCall = lift('<EmailHistoryPanel emails={[form.email]}', "/>");
ok("the enquiry panel is titled Emails Sent", enquiryCall.indexOf('title="Emails Sent"') !== -1);
ok("and no longer filters to viewings", enquiryCall.indexOf("typeFilter") === -1);
ok("its empty state speaks of emails, not viewings",
   enquiryCall.indexOf("No emails sent to this enquiry yet.") !== -1);

// The event form keeps its viewings-only list on purpose: a booked wedding's
// deposit and arrival emails have their own place, and this one answers "did
// we ever get them through the door".
ok("the event form still filters to viewings",
   SRC.indexOf('title="Viewing Emails Sent"') !== -1);
eq("and it is the only one left that does",
   SRC.split('title="Viewing Emails Sent"').length - 1, 1);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
