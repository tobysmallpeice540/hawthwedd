// netlify/functions/send-accom-reminders.js
// Scheduled function — runs daily via cron (see netlify.toml).
// Checks every lettings booking for due reminder emails:
//   - Deposit request  (unpaid deposit, N days before due date)
//   - Balance request  (unpaid balance, N days before due date)
//   - Arrival info      (two reminder points before check-in — general or wedding template)
// Each send is guarded by an emailFlags flag so it only ever goes out once.
//
// Required env vars: RESEND_API_KEY, STRIPE_SECRET_KEY

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const SUPABASE_URL  = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SUPABASE_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJrcWJ5aXNmbXZ3dWxzeXh6d2p6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NTI0MzgsImV4cCI6MjA5NjUyODQzOH0._CsyhvFrtHFC0KrfiLzbrLUaKcvxtbWlHydaH20tvfo";
const RESEND_KEY    = process.env.RESEND_API_KEY;
const FROM_EMAIL    = "hello@hawthbushfarm.co.uk";
const ACCOM_KEY     = "hbf_accom_v1";
const PROPS_KEY     = "hbf_properties_v1";
const TEMPLATES_KEY = "hbf_email_templates_v1";
const EMAIL_LOG_KEY = "hbf_email_log_v1";
const SITE_ORIGIN   = "https://hawthbushfarm.netlify.app";

// Fallback templates — mirrors DEFAULT_EMAIL_TEMPLATES in App.jsx, used only if
// the Lettings > Settings > Email Templates page has never been saved yet.
const DEFAULT_TEMPLATES = [
  { id: "deposit_request", triggerDays: 3,
    subject: "Deposit Due – {{propertyName}} – Ref {{bookingRef}}",
    body: "Dear {{guestName}},\n\nThis is a reminder that your deposit is due for your upcoming stay at Hawthbush Farm.\n\nBooking reference: {{bookingRef}}\n{{stayDetails}}\nDeposit due: £{{depositAmount}}\nDue date: {{depositDueDate}}\n\nYou can pay securely here: {{paymentLink}}\n\nWarm regards,\nHawthbush Farm", attachments: [] },
  { id: "balance_request", triggerDays: 28,
    subject: "Balance Due – {{propertyName}} – Ref {{bookingRef}}",
    body: "Dear {{guestName}},\n\nYour balance is now due ahead of your stay at Hawthbush Farm.\n\nBooking reference: {{bookingRef}}\n{{stayDetails}}\nBalance due: £{{balanceAmount}}\nDue date: {{balanceDueDate}}\n\nYou can pay securely here: {{paymentLink}}\n\nWe look forward to welcoming you!\n\nWarm regards,\nHawthbush Farm", attachments: [] },
  { id: "arrival_general", triggerDays: 28, triggerDays2: 3, triggerDays2Enabled: false,
    subject: "Your Arrival at Hawthbush Farm – {{checkIn}}",
    body: "Dear {{guestName}},\n\nWe're looking forward to welcoming you to {{propertyName}}!\n\nBooking reference: {{bookingRef}}\n{{stayDetails}}\nCheck-in from {{checkInTime}} · Check-out by {{checkOutTime}}\n\nPlease don't hesitate to contact us if you have any questions before your arrival.\n\nWarm regards,\nHawthbush Farm", attachments: [] },
  { id: "arrival_event", triggerDays: 28, triggerDays2: 3, triggerDays2Enabled: false,
    subject: "Your Wedding Weekend at Hawthbush Farm – {{checkIn}}",
    body: "Dear {{guestName}},\n\nWe are so excited to be part of your special day at Hawthbush Farm!\n\nBooking reference: {{bookingRef}}\n{{stayDetails}}\nCheck-in from {{checkInTime}} · Check-out by {{checkOutTime}}\n\nPlease do reach out if there is anything you need ahead of your celebration.\n\nWith warmest wishes,\nHawthbush Farm", attachments: [] },
];

async function sbGet(key) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data?key=eq." + key + "&select=value", {
    headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY }
  });
  if (!res.ok) throw new Error("sbGet failed: " + await res.text());
  const rows = await res.json();
  return (rows && rows[0]) ? rows[0].value : null;
}

async function sbSet(key, value) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data", {
    method: "POST",
    headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
    body: JSON.stringify({ key: key, value: value }),
  });
  if (!res.ok) throw new Error("sbSet failed: " + await res.text());
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

function daysBetween(a, b) {
  return Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);
}

function fmtDateNice(iso) {
  if (!iso) return "";
  var d = new Date(String(iso).slice(0, 10) + "T00:00:00");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function fillTemplate(str, tokens) {
  return String(str || "").replace(/\{\{(\w+)\}\}/g, function(m, key) {
    return (tokens[key] !== undefined && tokens[key] !== null) ? String(tokens[key]) : "";
  });
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

// One line per stay: "PropertyName: 2 October 2026 – 5 October 2026 (3 nights)"
// — so a multi-property booking lists every property with its own dates,
// not just the primary/first stay.
function buildStayDetailsText(booking) {
  var stays = (booking.stays && booking.stays.length) ? booking.stays : [booking];
  return stays.map(function(s) {
    var nights = s.nights;
    if (!nights && s.checkIn && s.checkOut) {
      nights = Math.round((new Date(s.checkOut + "T00:00:00") - new Date(s.checkIn + "T00:00:00")) / 86400000);
    }
    var name = s.propertyName || s.propertyId || "Property";
    var range = fmtDateNice(s.checkIn) + " – " + fmtDateNice(s.checkOut);
    return name + ": " + range + (nights ? " (" + nights + " night" + (nights === 1 ? "" : "s") + ")" : "");
  }).join("\n");
}

function buildTokens(booking, property, extra) {
  var stays = (booking.stays && booking.stays.length) ? booking.stays : [booking];
  var propNames = stays.map(function(s) { return s.propertyName || s.propertyId; }).join(" + ");
  var depositEntry = (booking.schedule || []).find(function(s) { return s.label === "Deposit"; });
  var balanceEntry = (booking.schedule || []).find(function(s) { return s.label === "Balance"; });
  var isWedding = booking.bookingType === "Wedding";
  var checkInTime  = property ? (isWedding ? property.checkInFromWedding  : property.checkInFrom)  : "";
  var checkOutTime = property ? (isWedding ? property.checkOutByWedding  : property.checkOutBy)   : "";
  var tokens = {
    guestName:      booking.guestName || "Guest",
    guestEmail:     booking.email || "",
    guestPhone:     booking.phone || "",
    bookingRef:     String(booking.id || "").toUpperCase(),
    propertyName:   propNames,
    stayDetails:    buildStayDetailsText(booking),
    checkIn:        fmtDateNice(booking.checkIn),
    checkOut:       fmtDateNice(booking.checkOut),
    nights:         booking.nights || "",
    checkInTime:    checkInTime  || "",
    checkOutTime:   checkOutTime || "",
    totalAmount:    Number(booking.value || 0).toFixed(2),
    depositAmount:  depositEntry ? Number(depositEntry.amount || 0).toFixed(2) : "",
    balanceAmount:  balanceEntry ? Number(balanceEntry.amount || 0).toFixed(2) : "",
    depositDueDate: depositEntry ? fmtDateNice(depositEntry.dueDate) : "",
    balanceDueDate: balanceEntry ? fmtDateNice(balanceEntry.dueDate) : "",
    paymentLink:    "",
  };
  return Object.assign(tokens, extra || {});
}

// The body is stored alongside the subject so the sent email can be read back
// in full from the app. Capped so a runaway template can't bloat the log row.
async function logEmail(subject, to, type, bookingId, bodyText) {
  try {
    var log = (await sbGet(EMAIL_LOG_KEY)) || [];
    log.push({ id: "el" + Date.now() + "-" + Math.random().toString(36).slice(2, 6), sentAt: new Date().toISOString(), subject: subject, to: to, template: type, bookingId: bookingId, body: String(bodyText || "").slice(0, 8000) });
    await sbSet(EMAIL_LOG_KEY, log.slice(-500));
  } catch (e) { console.error("logEmail failed:", e.message); }
}

async function sendViaResend(to, subject, bodyText) {
  if (!RESEND_KEY) return { ok: false, error: "RESEND_API_KEY not set" };
  var html = "<div style='font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#333;line-height:1.6'>" + escapeHtml(bodyText) + "</div>";
  var res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_EMAIL, to: to, subject: subject, html: html }),
  });
  if (!res.ok) return { ok: false, error: "Resend failed: " + await res.text() };
  return { ok: true };
}

async function createPaymentLink(booking, entry, label) {
  var amountPence = Math.round(Number(entry.amount || 0) * 100);
  if (amountPence <= 0) return "";
  var stays = (booking.stays && booking.stays.length) ? booking.stays : [booking];
  var propNames = stays.map(function(s) { return s.propertyName || s.propertyId; }).join(" + ");
  var session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: booking.email,
    line_items: [{
      price_data: {
        currency: "gbp",
        product_data: { name: label + " — " + propNames, description: fmtDateNice(booking.checkIn) + " to " + fmtDateNice(booking.checkOut) },
        unit_amount: amountPence,
      },
      quantity: 1,
    }],
    metadata: { bookingType: "accom_reminder", bookingId: String(booking.id), scheduleLabel: label },
    success_url: SITE_ORIGIN + "/book-accom.html?paid=1",
    cancel_url:  SITE_ORIGIN + "/book-accom.html?cancelled=1",
  });
  entry.stripeId = session.id;
  return session.url;
}

function getTmpl(templates, id) {
  return templates.find(function(t) { return t.id === id; }) || DEFAULT_TEMPLATES.find(function(t) { return t.id === id; });
}

exports.handler = async function() {
  var today = todayStr();
  console.log("[send-accom-reminders] Running for " + today);

  var sentCount = 0;
  var errors = [];

  try {
    var bookings   = (await sbGet(ACCOM_KEY)) || [];
    var properties = (await sbGet(PROPS_KEY)) || [];
    var templates  = (await sbGet(TEMPLATES_KEY)) || DEFAULT_TEMPLATES;

    var changed = false;

    for (var i = 0; i < bookings.length; i++) {
      var booking = bookings[i];

      if (booking.status === "cancelled" || booking.bookingType === "Blocked") continue;

      // Accommodation attached to a farm event is billed through that event's
      // Xero invoices, so it must never get its own deposit/balance chasing —
      // the guest would be asked for money they are already being invoiced for.
      // Arrival information is still sent; only the payment flow is suppressed.
      var billedViaEvent = !!booking.linkedEventId;

      if (!booking.email) continue;

      var flags = Object.assign({}, booking.emailFlags || {});
      var propId = booking.propertyId || ((booking.stays || [])[0] || {}).propertyId;
      var property = properties.find(function(p) { return p.id === propId; });

      var didSend = false;

      // ── Deposit request ──────────────────────────────────────────────────
      var depositEntry = (booking.schedule || []).find(function(s) { return s.label === "Deposit"; });
      if (!billedViaEvent && depositEntry && !depositEntry.paid && depositEntry.dueDate && !flags.depositRequestSent) {
        var depTmpl = getTmpl(templates, "deposit_request");
        var depDays = (depTmpl.triggerDays !== undefined && depTmpl.triggerDays !== null) ? depTmpl.triggerDays : 3;
        if (depDays > 0 && daysBetween(today, depositEntry.dueDate) <= depDays) {
          try {
            var depLink = await createPaymentLink(booking, depositEntry, "Deposit");
            var depTokens = buildTokens(booking, property, { paymentLink: depLink });
            var depSubject = fillTemplate(depTmpl.subject, depTokens);
            var depBody = fillTemplate(depTmpl.body, depTokens);
            var depRes = await sendViaResend(booking.email, depSubject, depBody);
            if (depRes.ok) {
              await logEmail(depSubject, booking.email, "deposit_request", booking.id, depBody);
              flags.depositRequestSent = true;
              didSend = true;
              sentCount++;
            } else {
              errors.push("Booking " + booking.id + " deposit_request: " + depRes.error);
            }
          } catch (e) { errors.push("Booking " + booking.id + " deposit_request: " + e.message); }
        }
      }

      // ── Balance request ──────────────────────────────────────────────────
      var balanceEntry = (booking.schedule || []).find(function(s) { return s.label === "Balance"; });
      if (!billedViaEvent && balanceEntry && !balanceEntry.paid && balanceEntry.dueDate && !flags.balanceRequestSent) {
        var balTmpl = getTmpl(templates, "balance_request");
        var balDays = (balTmpl.triggerDays !== undefined && balTmpl.triggerDays !== null) ? balTmpl.triggerDays : 28;
        if (balDays > 0 && daysBetween(today, balanceEntry.dueDate) <= balDays) {
          try {
            var balLink = await createPaymentLink(booking, balanceEntry, "Balance");
            var balTokens = buildTokens(booking, property, { paymentLink: balLink });
            var balSubject = fillTemplate(balTmpl.subject, balTokens);
            var balBody = fillTemplate(balTmpl.body, balTokens);
            var balRes = await sendViaResend(booking.email, balSubject, balBody);
            if (balRes.ok) {
              await logEmail(balSubject, booking.email, "balance_request", booking.id, balBody);
              flags.balanceRequestSent = true;
              didSend = true;
              sentCount++;
            } else {
              errors.push("Booking " + booking.id + " balance_request: " + balRes.error);
            }
          } catch (e) { errors.push("Booking " + booking.id + " balance_request: " + e.message); }
        }
      }

      // ── Arrival info (general or wedding), two reminder points ────────────
      if (booking.checkIn) {
        var arrivalId = booking.bookingType === "Wedding" ? "arrival_event" : "arrival_general";
        var arrTmpl = getTmpl(templates, arrivalId);
        var arrTokens = buildTokens(booking, property, {});
        var arrSubject = fillTemplate(arrTmpl.subject, arrTokens);
        var arrBody = fillTemplate(arrTmpl.body, arrTokens);
        var daysToArrival = daysBetween(today, booking.checkIn);

        var days1 = (arrTmpl.triggerDays !== undefined && arrTmpl.triggerDays !== null) ? arrTmpl.triggerDays : 28;
        if (!flags.arrivalInfo1Sent && days1 > 0 && daysToArrival >= 0 && daysToArrival <= days1) {
          try {
            var arr1Res = await sendViaResend(booking.email, arrSubject, arrBody);
            if (arr1Res.ok) {
              await logEmail(arrSubject, booking.email, arrivalId, booking.id, arrBody);
              flags.arrivalInfo1Sent = true;
              didSend = true;
              sentCount++;
            } else {
              errors.push("Booking " + booking.id + " " + arrivalId + " (1st): " + arr1Res.error);
            }
          } catch (e) { errors.push("Booking " + booking.id + " " + arrivalId + " (1st): " + e.message); }
        }

        var days2 = (arrTmpl.triggerDays2 !== undefined && arrTmpl.triggerDays2 !== null) ? arrTmpl.triggerDays2 : 3;
        if (arrTmpl.triggerDays2Enabled && !flags.arrivalInfo2Sent && days2 > 0 && daysToArrival >= 0 && daysToArrival <= days2) {
          try {
            var arr2Res = await sendViaResend(booking.email, arrSubject, arrBody);
            if (arr2Res.ok) {
              await logEmail(arrSubject, booking.email, arrivalId, booking.id, arrBody);
              flags.arrivalInfo2Sent = true;
              didSend = true;
              sentCount++;
            } else {
              errors.push("Booking " + booking.id + " " + arrivalId + " (2nd): " + arr2Res.error);
            }
          } catch (e) { errors.push("Booking " + booking.id + " " + arrivalId + " (2nd): " + e.message); }
        }
      }

      if (didSend) {
        booking.emailFlags = flags;
        bookings[i] = booking;
        changed = true;
      }
    }

    if (changed) {
      await sbSet(ACCOM_KEY, bookings);
    }

    console.log("[send-accom-reminders] Sent " + sentCount + " emails. Errors: " + errors.length);
    if (errors.length) console.error(errors.join("\n"));

    return { statusCode: 200, body: JSON.stringify({ sent: sentCount, errors: errors }) };

  } catch (err) {
    console.error("[send-accom-reminders] Fatal error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
