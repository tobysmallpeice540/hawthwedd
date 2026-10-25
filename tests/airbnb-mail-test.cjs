// Reading Airbnb's emails to the host, pinned. 25 October 2026.
//
// netlify/functions/airbnb-mail/parse.js turns an email into facts (a
// booking's guest, payout and thread; a cancellation; a review; messages) and
// works out what changes on our lettings bookings. The fixtures here follow
// the real layouts line for line, with made-up guests, codes and threads —
// no real guest's details belong in the repo.
//
//   node tests/airbnb-mail-test.cjs
"use strict";
const P = require("../netlify/functions/airbnb-mail/parse.js");

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; return; }
  fail++; console.log("FAIL " + label + (extra !== undefined ? "  →  " + JSON.stringify(extra) : ""));
}
const ROOMS = { ourRooms: ["11112222"] };
const L = "https://www.airbnb.co.uk";
const parse = (m) => P.parseAirbnbEmail(Object.assign({ labels: [], to: "toby@example.invalid" }, m), ROOMS);

// ── Booking confirmed ───────────────────────────────────────────────────────
const confirmation = {
  date: "2026-09-22T15:28:30+00:00", from: "Airbnb <automated@airbnb.com>",
  subject: "Reservation confirmed - Ada Lovelace arrives 16 Apr",
  template: "BOOKING_CONFIRMATION_TO_HOST",
  text: [
    "%opentrack%", L + "/?c=.pi80.x", "", "NEW BOOKING CONFIRMED! ADA ARRIVES 16 APR.", "",
    "Send a message to confirm check-in details or welcome", "Ada.", "",
    L + "/hosting/reservations/details/HMAAAA1111?isPending=true&c=.x   Ada Lovelace",
    "      [" + L + "/hosting/reservations/details/HMAAAA1111?isPending=true]",
    "      Identity verified · 11 reviews", "      Lincoln, United Kingdom", "",
    "Send Ada a MessageSend Ada a Message", "[" + L + "/hosting/thread/1234567890?thread_type=home_booking&email_cta=x]", "",
    L + "/rooms/11112222?c=.x", "", "THE HAMLET - WITH HOT TUB, CINEMA ROOM & TAPROOM", "", "Entire home/flat", "",
    "[" + L + "/rooms/11112222?c=.x]", "", "Check-in           Checkout", "",
    "Fri, 16 Apr 2027   Sun, 18 Apr 2027", "", "16:00              10:00", "", "", "GUESTS", "", "13 adults, 1 infant", "",
    "CONFIRMATION CODE", "", "HMAAAA1111", "", "GUEST PAID", "",
    "£1,303.00 x 2 nights   £2,606.00", "Cleaning fee   £89.00", "TOTAL (GBP)   £2,695.00", "", "HOST PAYOUT", "",
    "2-night room fee   £2,606.00", "Host service fee (15.5% + VAT)   -£501.28", "", "YOU EARN   £2,193.72", ""
  ].join("\r\n")
};
let r = parse(confirmation);
ok(r.kind === "confirmation", "C1 confirmation recognised", r);
const sneaky = parse(Object.assign({}, confirmation, { text: confirmation.text.replace("NEW BOOKING CONFIRMED!", "YOU EARN   £1.00\r\nNEW BOOKING CONFIRMED!") }));
ok(sneaky.payout === 2193.72, "C1b a YOU EARN typed above the payout section is not the payout", sneaky.payout);
ok(r.code === "HMAAAA1111" && r.threadId === "1234567890" && r.roomId === "11112222", "C2 code, thread, room", r);
ok(r.guestName === "Ada Lovelace", "C3 full name from the subject", r.guestName);
ok(r.checkIn === "2027-04-16" && r.checkOut === "2027-04-18", "C4 dates with the year", [r.checkIn, r.checkOut]);
ok(r.payout === 2193.72, "C5 payout is YOU EARN, not what the guest paid", r.payout);
ok(r.guests === "13 adults, 1 infant" && r.guestCount === 13, "C6 guests (infants take no bed)", [r.guests, r.guestCount]);

// ── Reminder before arrival (full name beside the link, payout as it now is) ─
r = parse({
  date: "2026-10-22T15:02:08+00:00", from: "Airbnb <automated@airbnb.com>",
  subject: "Reservation reminder: Grace And Sam is coming soon!",
  template: "BOOKING_RESERVATION_REMINDER_TO_HOST",
  text: [
    "GRACE AND SAM ARRIVES SATURDAY, 24 OCT.", "",
    L + "/hosting/reservations/details/HMBBBB2222?c=.x Grace And Sam Hopper",
    " " + L + "/hosting/reservations/details/HMBBBB2222?c=.x", " Identity verified · 5 reviews", "",
    "[" + L + "/hosting/thread/2223334445?thread_type=home_booking]", L + "/rooms/11112222?c=.x", "",
    "THE HAMLET - WITH HOT TUB, CINEMA ROOM & TAPROOM", "", "Check-in Checkout", "Sat 24 Oct Tue 27 Oct", "",
    "GUESTS", "", "13 adults, 1 pet", "", "CONFIRMATION CODE", "HMBBBB2222", "", "HOST PAYOUT", "", "YOU EARN   £3,615.00", ""
  ].join("\n")
});
ok(r.kind === "reminder" && r.code === "HMBBBB2222" && r.guestName === "Grace And Sam Hopper"
   && r.payout === 3615 && r.guestCount === 13 && r.threadId === "2223334445", "R1 reminder", r);

// ── Cancellation (code in the subject) ──────────────────────────────────────
r = parse({
  date: "2025-11-16T14:31:04+00:00", from: "Airbnb <automated@airbnb.com>",
  subject: "Cancelled: Reservation HMCCCC3333 for 10–12 Apr 2026",
  template: "CANCELLATIONS_RESERVATION_CANCELED_BY_GUEST_TO_HOST",
  text: "These dates are now open for other guests\n\nRESERVATION CANCELLED\n The Hamlet - with Hot Tub\n Listing #11112222\n 10–12 Apr, 14 guests\n" +
        "Unfortunately, your guest Mary had to cancel reservation\nHMCCCC3333 for 10–12 Apr 2026.\n"
});
ok(r.kind === "cancellation" && r.code === "HMCCCC3333" && r.guestFirst === "Mary"
   && r.checkIn === "2026-04-10" && r.checkOut === "2026-04-12", "X1 cancellation", r);
r = parse({ date: "2023-12-12T13:50:18Z", from: "automated@airbnb.com",
  subject: "Reservation HMDDDD4444 on 22 December 2023 Cancelled", template: "", text: "RESERVATION CANCELLED\n Our Barn\n Listing #11112222\n" });
ok(r.kind === "cancellation" && r.code === "HMDDDD4444", "X2 older cancellation subject, naming our listing", r);
r = parse({ date: "2023-12-12T13:50:18Z", from: "automated@airbnb.com",
  subject: "Reservation HMDDDD4444 on 22 December 2023 Cancelled", template: "", text: "RESERVATION CANCELLED\n Somebody's flat\n Listing #99998888\n" });
ok(r.kind === "ignore", "X2b a cancellation subject alone is not enough — not our listing", r);
r = parse({ date: "2023-12-12T13:50:18Z", from: "automated@airbnb.com",
  subject: "Reservation HMDDDD4444 on 22 December 2023 Cancelled", template: "", text: "RESERVATION CANCELLED" });
ok(r.kind === "ignore", "X2c nor with no listing and no template", r);
r = parse({ date: "2026-09-11T16:59:25Z", from: "Airbnb <automated@airbnb.com>", subject: "Airbnb Reservation Cancelled",
  template: "CANCELLATIONS_RESERVATION_CANCELED_BY_GUEST_TO_GUEST", text: "RESERVATION CANCELLED\n Twin Bedroom in a Townhouse\n You got a £330.00 booking credit" });
ok(r.kind === "ignore", "X3 our own trip cancelled is ignored", r);

// ── Review ──────────────────────────────────────────────────────────────────
r = parse({
  date: "2026-10-21T11:23:04Z", from: "Airbnb <automated@airbnb.com>",
  subject: "Mary has left a 4-star review!", template: "HOME_REVIEWS_EMPATHETIC_HOST_REVIEW_RECEIVED",
  text: "REVIEW\n" + L + "/progress/reviews/details/1799?c=.x\nFEEDBACK FROM THEIR STAY\n\n The Hamlet - with Hot Tub, Cinema Room & Taproom\n 30 Oct – 2 Nov 2026\n\nOVERALL RATING 4\n"
});
ok(r.kind === "review" && r.stars === 4 && r.checkIn === "2026-10-30" && r.checkOut === "2026-11-02"
   && r.listing === "The Hamlet - with Hot Tub, Cinema Room & Taproom", "V1 review across a month end", r);
r = parse({ date: "2026-10-21T11:23:04Z", from: "Airbnb <automated@airbnb.com>",
  subject: "Judith has left a 5-star review!", template: "HOME_REVIEWS_REVIEW_RECEIVED_TO_GUEST",
  text: "FEEDBACK\n Barn on a farm\n 18–20 Sept 2026\n" });
ok(r.kind === "ignore", "V2 a host reviewing us as guests is ignored", r);

// ── Payout (one line ours, one another listing) ─────────────────────────────
r = parse({
  date: "2026-10-17T13:05:32Z", from: "Airbnb <automated@airbnb.com>", subject: "We sent a payout of £2,385.83 GBP", template: "",
  text: "£2,385.83 GBP was sent today\n\nBank account\n\nFarm Ltd, Checking 0000 (GBP)\n\nDetails\n\n" +
        "Ada Lovelace £2,385.83 GBP\n\nHome • 16/10/2026 - 18/10/2026\n\nThe Hamlet - with Hot Tub, Cinema Room & Taproom (11112222)\n\nHMAAAA1111\n\n" +
        "Someone Else £100.00 GBP\n\nHome • 01/10/2026 - 02/10/2026\n\nNot ours (99998888)\n\nHMEEEE5555\n\nTotal paid: £2,485.83 GBP\n"
});
ok(r.kind === "payout" && r.items.length === 1 && r.items[0].code === "HMAAAA1111" && r.items[0].amount === 2385.83
   && r.items[0].checkIn === "2026-10-16" && r.items[0].checkOut === "2026-10-18", "P1 payout line, ours only", r);
ok(!JSON.stringify(r).includes("0000"), "P2 the bank account is not kept");

// ── Messages ────────────────────────────────────────────────────────────────
const digest = {
  date: "2026-10-07T09:57:46Z", from: "Airbnb <express@airbnb.com>",
  subject: "RE: Reservation for The Hamlet - with Hot Tub, Cinema Room & Taproom, 24–27 Oct",
  template: "MESSAGING_NEW_MESSAGE_EMAIL_DIGEST",
  text: [
    "RESERVATION FOR THE HAMLET, 24–27 OCT", "",
    "For your protection and safety, always communicate through Airbnb", "[" + L + "/help/article/209?c=.x].", "",
    "   GRACE AND SAM", "   ", "   Booker", "   ", "   Hello! Could we arrive a little", "   early on Saturday?", "   ", "   Thanks, G", "",
    "   ROSANNA", "   ", "   Co-host", "   ", "   Hi Grace, yes of course — from 2pm.", "",
    "Reply", "[" + L + "/hosting/thread/2223334445?thread_type=home_booking&inbox_type=host&c=.x]", "",
    "You can also respond by replying directly to this email.", L + "/rooms/11112222?c=.x"
  ].join("\r\n")
};
r = parse(digest);
ok(r.kind === "digest" && r.threadId === "2223334445" && r.threadKind === "reservation" && r.messages.length === 2, "M1 digest, two messages", r);
ok(r.messages[0].author === "Grace And Sam" && r.messages[0].direction === "guest"
   && r.messages[0].body === "Hello! Could we arrive a little early on Saturday?\n\nThanks, G", "M2 guest message, wrapping undone, paragraphs kept", r.messages[0]);
ok(r.messages[1].author === "Rosanna" && r.messages[1].role === "Co-host" && r.messages[1].direction === "host", "M3 the co-host is our side", r.messages[1]);
r = parse(Object.assign({}, digest, { subject: "RE: Pre-approval for The Hamlet, 16–18 Apr" }));
ok(r.threadKind === "enquiry", "M4 pre-approval belongs to the enquiry stage", r.threadKind);
r = parse(Object.assign({}, digest, { subject: "RE: Reservation for Seaside Villa, 31 May – 5 Jun",
  text: digest.text.replace(/hosting\/thread\/2223334445\?thread_type=home_booking&inbox_type=host/, "messaging/thread/777?inbox_type=guest").replace(/\/rooms\/11112222/, "/rooms/55556666") }));
ok(r.kind === "ignore", "M5 a host messaging us about our own trip is ignored", r);

r = parse({
  date: "2026-10-24T09:49:11Z", from: "Airbnb <automated@airbnb.com>", template: "BOOKING_INITIAL_INQUIRY",
  subject: "Enquiry for The Hamlet - with Hot Tub, Cinema Room & Taproom for 27–29 Oct 2026",
  text: [
    "RESPOND TO HELEN’S ENQUIRY", "", "Helen", "", L + "/hosting/thread/3334445556?thread_type=home_booking&c=.x", "",
    "Identity verified · 6 reviews", "", "England, United Kingdom", "",
    "Dear Toby, we would love to book your place for a", "weekend in May. Is it too early?", "",
    "Pre-approve / DeclinePre-approve / Decline", L + "/hosting/thread/3334445556?c=.x", L + "/rooms/11112222?c=.x"
  ].join("\n")
});
ok(r.kind === "enquiry" && r.threadId === "3334445556" && r.messages[0].author === "Helen"
   && r.messages[0].body === "Dear Toby, we would love to book your place for a weekend in May. Is it too early?", "E1 enquiry and its first message", r);
r = parse({
  date: "2026-01-16T07:38:08Z", from: "\"Rosa (Airbnb)\" <express@airbnb.com>", template: "RESERVATION_INQUIRIES_REMINDER",
  subject: "Enquiry for The Hamlet - with Hot Tub, Cinema Room & Taproom for Apr 17 - 19, 2026",
  text: [
    "RESPOND TO ROSA’S ENQUIRY", "", "Maintain your response rate.", "", "Pre-approve / Decline",
    "[" + L + "/hosting/inbox/4445556667?thread_type=home_booking]", "", "", "", "Rosa", "", "8 reviews", "", "London", "",
    "[" + L + "/messaging/thread/4445556667]", "", "Hello,", "", "This looks amazing! We are a group of", "friends.", "",
    L + "/rooms/11112222?c=.x"
  ].join("\n")
});
ok(r.kind === "enquiry" && r.threadId === "4445556667" && r.messages[0].body === "Hello,\n\nThis looks amazing! We are a group of friends.", "E2 the older enquiry layout", r);
r = parse({
  date: "2026-09-12T09:42:39Z", from: "Airbnb <automated@airbnb.com>", template: "BOOKING_RTB_TO_HOST",
  subject: "Pending: Reservation Request at The Hamlet for 22–28 Dec 2026",
  text: [
    "RESPOND TO JUNE’S REQUEST", "Accept/Decline", L + "/hosting/reservations/details/HMFFFF6666", "June",
    L + "/hosting/reservations/details/HMFFFF6666", "Identity verified · 4 reviews", "Long Newnton, United Kingdom",
    "Family group of grandparents children & grandchildren", L + "/rooms/11112222", "POTENTIAL EARNINGS", "your potential payout is £7,422."
  ].join("\n")
});
ok(r.kind === "request" && r.code === "HMFFFF6666" && r.messages[0].body === "Family group of grandparents children & grandchildren", "Q1 request to book", r);
ok(!("payout" in r), "Q2 a request's potential payout is not taken as money", r);

// Our own reply, sent from Gmail.
const reply = {
  date: "2025-11-22T08:37:49Z", from: "Toby <toby@example.invalid>", to: "abc123@reply.airbnb.com", labels: ["SENT"],
  subject: "Re: Reservation for The Hamlet, 5–7 Dec", template: "",
  text: "Hi Sarah, yes there is a coffee machine in the\ncowshed. Best\nToby\n\nSent from Gmail Mobile\n\n\nOn Fri, 21 Nov 2025 at 16:32, Airbnb <express@airbnb.com> wrote:\n\n> Sarah\n>\n> Booker\n> Is there a coffee machine?\n> Reply\n> <" + L + "/hosting/thread/5556667778?thread_type=home_booking&inbox_type=host&c=.x>\n"
};
r = parse(reply);
ok(r.kind === "sent" && r.threadId === "5556667778" && r.messages[0].direction === "host"
   && r.messages[0].body === "Hi Sarah, yes there is a coffee machine in the cowshed. Best Toby", "S1 our emailed reply joins the thread", r);
r = parse(Object.assign({}, reply, { text: reply.text.replace("hosting/thread/5556667778?thread_type=home_booking&inbox_type=host", "messaging/thread/999?inbox_type=guest") }));
ok(r.kind === "ignore", "S2 a reply on our own trip is ignored", r);
r = parse(Object.assign({}, reply, { to: "express@airbnb.com" }));
ok(r.kind === "ignore", "S3 a reply to express@ (which bounces) is ignored", r);

// Never read.
ok(parse({ date: "2026-01-01T00:00:00Z", from: "automated@airbnb.com", subject: "Your confirmation code is 123456", template: "", text: "123456" }).kind === "ignore", "N1 login codes are ignored");
ok(parse({ date: "2026-01-01T00:00:00Z", from: "someone@example.com", subject: "Reservation confirmed - X arrives 1 Jan", template: "", text: L + "/hosting/reservations/details/HMAAAA1111" }).kind === "ignore", "N2 not from Airbnb");
ok(parse({ date: "2026-01-01T00:00:00Z", from: "automated@airbnb.com", subject: "Reservation reminder – 27 October 2026", template: "BOOKING_RESERVATION_REMINDER_TO_GUEST", text: "Pack your bags!" }).kind === "ignore", "N3 our own trip's reminder");

// ── Small pieces ────────────────────────────────────────────────────────────
ok(JSON.stringify(P.dateRange("28 Dec – 2 Jan 2027")) === JSON.stringify({ in: "2026-12-28", out: "2027-01-02" }), "D1 range across the new year", P.dateRange("28 Dec – 2 Jan 2027"));
ok(JSON.stringify(P.dateRange("16–18 Oct", 2026)) === JSON.stringify({ in: "2026-10-16", out: "2026-10-18" }), "D2 range with the year from the email");
ok(P.dateRange("31–2 Feb 2026") === null, "D3 an impossible range is refused");
ok(P.pounds("£1,234.50") === 1234.5 && P.pounds("-£501.28") === -501.28 && P.pounds("about £9 per adult") === null, "D4 money only from a whole labelled figure");
ok(P.guestCount("9 adults, 3 children, 1 infant, 2 pets") === 12 && P.guestCount("14") === 14 && P.guestCount("lots") === null, "D5 guest count");
ok(["Imported Customer", "Henry Airbnb ", "Julia Air Bnb", "", "Airbnb block"].every(P.isPlaceholderName)
   && !P.isPlaceholderName("Emma Ward"), "D6 placeholder names");
ok(P.roomOfProperty({ airbnbImportUrl: "https://www.airbnb.co.uk/calendar/ical/11112222.ics?s=abc" }) === "11112222", "D7 room from the iCal link");

// ── What changes on our bookings ────────────────────────────────────────────
const props = [{ id: "hamlet", name: "The Hamlet", airbnbImportUrl: "https://www.airbnb.co.uk/calendar/ical/11112222.ics?s=x" }];
const bk = (o) => Object.assign({ source: "airbnb", guestName: "Ada Airbnb", value: 2193, estimated: true, guestCount: 0, status: "confirmed",
  notes: "Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMAAAA1111\nPhone Number (Last 4 Digits): 0000",
  stays: [{ propertyId: "hamlet", checkIn: "2027-04-16", checkOut: "2027-04-18", value: 2193, guestCount: "" }] }, o);
const res = { code: "HMAAAA1111", thread_id: "1234567890", room_id: "11112222", listing: "THE HAMLET - WITH HOT TUB, CINEMA ROOM & TAPROOM",
  guest_name: "Ada Lovelace", check_in: "2027-04-16", check_out: "2027-04-18", guests: "13 adults", guest_count: 13,
  payout_expected: 2193.72, cancelled_at: null, altered_at: null, confirmed_at: "2026-09-22T15:28:30Z" };
const NOW = "2026-10-25T12:00:00Z";
let pl = P.planBookingPatches([bk({ id: "a1" })], { reservations: [res], properties: props }, NOW);
ok(pl.length === 1 && pl[0].set.guestName === "Ada Lovelace" && pl[0].set.value === 2193.72 && pl[0].set.estimated === false
   && pl[0].set.stays[0].value === 2193.72 && pl[0].set.guestCount === 13 && pl[0].set.stays[0].guestCount === 13, "B1 placeholder name, estimate and count replaced", pl);
ok(pl[0].set.airbnb.code === "HMAAAA1111" && pl[0].set.airbnb.threadId === "1234567890" && pl[0].set.airbnb.valueBefore === 2193
   && pl[0].set.airbnb.appliedValue === 2193.72, "B2 the Airbnb record on the booking keeps the old figure", pl[0].set.airbnb);

const applied = P.applyPatches([bk({ id: "a1" }), bk({ id: "a2", notes: "" })], pl).list;
ok(P.planBookingPatches(applied, { reservations: [res], properties: props }, NOW).length === 0, "B3 a second run changes nothing");

// Somebody types over the figure and the name: the sync leaves both alone.
const edited = applied.map((b) => b.id === "a1" ? Object.assign({}, b, { value: 2000, guestName: "Ada L (and friends)", stays: [Object.assign({}, b.stays[0], { value: 2000 })] }) : b);
pl = P.planBookingPatches(edited, { reservations: [Object.assign({}, res, { payout_expected: 2300 })], properties: props }, NOW);
ok(pl.length === 1 && pl[0].set.value === undefined && pl[0].set.guestName === undefined && pl[0].set.airbnb.payoutExpected === 2300,
   "B4 a typed figure or name is never overwritten", pl);

// The payout once sent beats what the booking said we would earn.
pl = P.planBookingPatches(applied, { reservations: [res], payouts: [{ code: "HMAAAA1111", amount: 2100 }], properties: props }, NOW);
ok(pl.length === 1 && pl[0].set.value === 2100 && pl[0].set.airbnb.payoutPaid === 2100, "B5 the sent payout wins", pl);

// A real name typed by staff is kept even the first time.
pl = P.planBookingPatches([bk({ id: "a3", guestName: "Emma Ward" })], { reservations: [res], properties: props }, NOW);
ok(pl[0].set.guestName === undefined && pl[0].set.airbnb.guestName === "Ada Lovelace", "B6 a real name is kept", pl[0].set);

// No code in the notes: matched by property and dates, once only.
pl = P.planBookingPatches([bk({ id: "a4", notes: "" })], { reservations: [res], properties: props }, NOW);
ok(pl.length === 1 && pl[0].code === "HMAAAA1111", "B7 matched by dates when there is no code", pl);
pl = P.planBookingPatches([bk({ id: "a5", notes: "" }), bk({ id: "a6" })], { reservations: [res], properties: props }, NOW);
ok(pl.length === 1 && pl[0].id === "a6", "B8 a code already on a booking is not matched by dates to another", pl.map((p) => p.id));

// A price typed in (not an estimate) is kept the first time too.
pl = P.planBookingPatches([bk({ id: "a10", value: 2600, estimated: false, stays: [{ propertyId: "hamlet", checkIn: "2027-04-16", checkOut: "2027-04-18", value: 2600 }] })],
  { reservations: [res], properties: props }, NOW);
ok(pl.length === 1 && pl[0].set.value === undefined && pl[0].set.airbnb.payoutExpected === 2193.72 && pl[0].set.airbnb.appliedValue === undefined,
   "B6b a typed price is not replaced; Airbnb's figure is recorded beside it", pl[0] && pl[0].set);
// A row known only from a cancellation email is never matched by dates.
pl = P.planBookingPatches([bk({ id: "a11", notes: "" })], { reservations: [{ code: "HMZZZZ9999", check_in: "2027-04-16", check_out: "2027-04-18", cancelled_at: "2026-10-01T00:00:00Z" }], properties: props }, NOW);
ok(pl.length === 0, "B8b a cancellation-only row does not land on a booking by its dates", pl);
pl = P.planBookingPatches([bk({ id: "a12", notes: "", stays: [{ propertyId: "amly", checkIn: "2027-04-16", checkOut: "2027-04-18" }] })],
  { reservations: [res], properties: props.concat([{ id: "amly", name: "Amly Barn", airbnbImportUrl: "https://www.airbnb.co.uk/calendar/ical/33334444.ics" }]) }, NOW);
ok(pl.length === 0, "B8c nor on another property with the same dates", pl);
pl = P.planBookingPatches([bk({ id: "a13", bookingType: "Blocked" })], { reservations: [res], properties: props }, NOW);
ok(pl.length === 0, "B8d a blocked-dates entry is never touched", pl);

// A cancellation is recorded, never acted on.
pl = P.planBookingPatches(applied, { reservations: [Object.assign({}, res, { cancelled_at: "2026-09-23T10:00:00Z" })], properties: props }, NOW);
ok(pl.length === 1 && pl[0].set.airbnb.cancelledAt === "2026-09-23T10:00:00Z" && pl[0].set.status === undefined, "B9 cancellation recorded, status untouched", pl);

// The review finds its stay by listing and dates — with no reservation, by the property's name.
const rv = { listing: "The Hamlet - with Hot Tub, Cinema Room & Taproom", check_in: "2026-10-16", check_out: "2026-10-18", stars: 5, at: "2026-10-21T11:00:00Z" };
const old = bk({ id: "a7", notes: "", guestName: "Reece Smith", value: 2385, estimated: false, stays: [{ propertyId: "hamlet", checkIn: "2026-10-16", checkOut: "2026-10-18", value: 2385 }] });
pl = P.planBookingPatches([old], { reservations: [], reviews: [rv], properties: props }, NOW);
ok(pl.length === 1 && pl[0].set.airbnb.stars === 5 && pl[0].set.value === undefined, "B10 stars from the review alone", pl);
pl = P.planBookingPatches([Object.assign({}, old, { source: "direct" })], { reviews: [rv], properties: props }, NOW);
ok(pl.length === 0, "B11 only Airbnb bookings are touched");

// applyPatches: a deleted booking stays deleted; a dismissed prompt survives.
const withDismiss = applied.map((b) => b.id === "a1" ? Object.assign({}, b, { airbnb: Object.assign({}, b.airbnb, { cancelDismissedAt: "2026-10-01" }) }) : b);
const out = P.applyPatches(withDismiss.filter((b) => b.id !== "a2"), [{ id: "a1", set: { airbnb: { code: "HMAAAA1111", stars: 4 } } }, { id: "a2", set: { value: 1 } }]);
ok(out.applied === 1 && out.list.length === 1 && out.list[0].airbnb.cancelDismissedAt === "2026-10-01" && out.list[0].airbnb.stars === 4, "B12 apply keeps staff's dismissal and resurrects nothing", out);

// ── A booking that has left Airbnb's feed (sync-all-icals) ──────────────────
const F = require("../netlify/functions/sync-all-icals.js")._internals.flagMissingFromFeed;
const NOWI = "2026-10-25T10:00:00.000Z";
const ab = (id, uid, out, o) => Object.assign({ id: id, source: "airbnb", airbnbUid: uid, status: "confirmed",
  stays: [{ propertyId: "hamlet", checkIn: out < "2026-11-01" ? "2026-09-29" : "2026-11-01", checkOut: out }] }, o || {});
const list = [ab("k1", "u1", "2026-11-03"), ab("k2", "u2", "2026-11-10"), ab("k3", "u3", "2026-10-01"),
              ab("k4", "u4", "2026-12-01", { status: "cancelled" }), ab("k5", "u5", "2026-12-05", { airbnbMissingSince: "2026-10-20" }),
              ab("k6", null, "2026-12-09"), Object.assign(ab("k7", "u7", "2026-12-20"), { source: "manual" })];
let fr = F(list, { hamlet: ["u1", "u5"] }, NOWI);
const byId = (l, id) => l.find((b) => b.id === id);
ok(byId(fr.list, "k2").airbnbMissingSince === NOWI && fr.flagged === 1, "F1 a coming booking gone from the feed is marked", fr);
ok(!byId(fr.list, "k1").airbnbMissingSince && !byId(fr.list, "k3").airbnbMissingSince && !byId(fr.list, "k4").airbnbMissingSince
   && !byId(fr.list, "k6").airbnbMissingSince && !byId(fr.list, "k7").airbnbMissingSince, "F2 past, cancelled, uid-less and non-Airbnb bookings are left alone");
ok(!("airbnbMissingSince" in byId(fr.list, "k5")) && fr.cleared === 1, "F3 a booking back in the feed is unmarked");
fr = F(fr.list, { hamlet: ["u1", "u5"] }, "2026-10-25T11:00:00.000Z");
ok(byId(fr.list, "k2").airbnbMissingSince === NOWI && !fr.changed, "F4 the first time it went missing is kept; nothing to write");
fr = F(list, { hamlet: [] }, NOWI);
ok(!fr.changed, "F5 an empty feed while we hold coming bookings marks nothing (suspect feed)");
fr = F(list, {}, NOWI);
ok(!fr.changed, "F6 a property whose feed was not read marks nothing");
ok(list[1].airbnbMissingSince === undefined, "F7 the input list is not changed in place");
fr = F([{ id: "k8", source: "airbnb", airbnbUid: "u8", status: "confirmed", stays: [{ propertyId: "hamlet", checkIn: "2026-10-24", checkOut: "2026-10-27" }] },
        ab("k1", "u1", "2026-11-03")], { hamlet: ["u1"] }, NOWI);
ok(!fr.changed, "F8 a stay already under way is never marked");

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
