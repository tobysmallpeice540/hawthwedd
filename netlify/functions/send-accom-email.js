// netlify/functions/send-accom-email.js
// On-demand single email send for a lettings booking, using the saved email
// templates. Currently used for the "Send booking confirmation email?" prompt
// shown in the app when a manual booking is created with a guest email.
//
// POST /.netlify/functions/send-accom-email
// Body: { bookingId: "a123", emailType: "booking_confirmed" }
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

// Fallback templates — mirrors the defaults in App.jsx, used only if the
// Lettings > Settings > Email Templates page has never been saved yet.
const DEFAULT_TEMPLATES = [
  { id: "booking_confirmed", subject: "Booking Confirmed – {{propertyName}} – Ref {{bookingRef}}",
    body: "Dear {{guestName}},\n\nThank you for booking with Hawthbush Farm! Your reservation is confirmed.\n\nBooking reference: {{bookingRef}}\n{{stayDetails}}\n\nTotal: £{{totalAmount}}\n\nA deposit of £{{depositAmount}} is due by {{depositDueDate}}.{{paymentLinkLine}}\n\nIf you have any questions, please don't hesitate to get in touch.\n\nWarm regards,\nHawthbush Farm", attachments: [] },
  { id: "deposit_request", subject: "Deposit Due – {{propertyName}} – Ref {{bookingRef}}",
    body: "Dear {{guestName}},\n\nThis is a reminder that your deposit is due for your upcoming stay at Hawthbush Farm.\n\nBooking reference: {{bookingRef}}\n{{stayDetails}}\nDeposit due: £{{depositAmount}}\nDue date: {{depositDueDate}}\n\nYou can pay securely here: {{paymentLink}}\n\nWarm regards,\nHawthbush Farm", attachments: [] },
  { id: "balance_request", subject: "Balance Due – {{propertyName}} – Ref {{bookingRef}}",
    body: "Dear {{guestName}},\n\nYour balance is now due ahead of your stay at Hawthbush Farm.\n\nBooking reference: {{bookingRef}}\n{{stayDetails}}\nBalance due: £{{balanceAmount}}\nDue date: {{balanceDueDate}}\n\nYou can pay securely here: {{paymentLink}}\n\nWe look forward to welcoming you!\n\nWarm regards,\nHawthbush Farm", attachments: [] },
  { id: "payment_confirmation", subject: "Payment Received – {{propertyName}} – Ref {{bookingRef}}",
    body: "Dear {{guestName}},\n\nThank you – we have received your payment of £{{amountPaid}} for your booking at Hawthbush Farm.\n\nBooking reference: {{bookingRef}}\n{{stayDetails}}\nAmount received: £{{amountPaid}}\n\nWarm regards,\nHawthbush Farm", attachments: [] },
  { id: "arrival_general", subject: "Your Arrival at Hawthbush Farm – {{checkIn}}",
    body: "Dear {{guestName}},\n\nWe're looking forward to welcoming you to {{propertyName}}!\n\nBooking reference: {{bookingRef}}\n{{stayDetails}}\nCheck-in from {{checkInTime}} · Check-out by {{checkOutTime}}\n\nPlease don't hesitate to contact us if you have any questions before your arrival.\n\nWarm regards,\nHawthbush Farm", attachments: [] },
  { id: "arrival_event", subject: "Your Wedding Weekend at Hawthbush Farm – {{checkIn}}",
    body: "Dear {{guestName}},\n\nWe are so excited to be part of your special day at Hawthbush Farm!\n\nBooking reference: {{bookingRef}}\n{{stayDetails}}\nCheck-in from {{checkInTime}} · Check-out by {{checkOutTime}}\n\nPlease do reach out if there is anything you need ahead of your celebration.\n\nWith warmest wishes,\nHawthbush Farm", attachments: [] },
];

async function sbGet(key) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data?key=eq." + key + "&select=value", {
    headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY }
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return (Array.isArray(rows) && rows[0]) ? rows[0].value : null;
}

async function sbSet(key, value) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data", {
    method: "POST",
    headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
    body: JSON.stringify({ key: key, value: value }),
  });
  if (!res.ok) throw new Error("sbSet failed: " + await res.text());
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
    amountPaid:     "",
    paymentLink:    "",
    paymentLinkLine: "",
  };
  return Object.assign(tokens, extra || {});
}

async function logEmail(subject, to, type, bookingId) {
  try {
    var log = (await sbGet(EMAIL_LOG_KEY)) || [];
    log.push({ id: "el" + Date.now() + "-" + Math.random().toString(36).slice(2, 6), sentAt: new Date().toISOString(), subject: subject, to: to, template: type, bookingId: bookingId });
    await sbSet(EMAIL_LOG_KEY, log.slice(-500));
  } catch (e) { console.error("logEmail failed:", e.message); }
}

async function sendViaResend(to, subject, bodyText, attachments) {
  if (!RESEND_KEY) return { ok: false, error: "RESEND_API_KEY not set" };
  var html = "<div style='font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#333;line-height:1.6'>" + escapeHtml(bodyText) + "</div>";
  var res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_EMAIL, to: to, subject: subject, html: html, attachments: (attachments && attachments.length) ? attachments : undefined }),
  });
  if (!res.ok) return { ok: false, error: "Resend failed: " + await res.text() };
  return { ok: true };
}

// Create a fresh Stripe checkout link for a schedule entry (deposit/balance)
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

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  var body;
  try { body = JSON.parse(event.body); } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }
  var bookingId = body.bookingId;
  var emailType = body.emailType;
  if (!bookingId || !emailType) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing bookingId or emailType" }) };
  }

  try {
    var bookings = (await sbGet(ACCOM_KEY)) || [];
    var idx = bookings.findIndex(function(b) { return String(b.id) === String(bookingId); });
    if (idx === -1) return { statusCode: 404, body: JSON.stringify({ error: "Booking not found" }) };
    var booking = bookings[idx];

    if (!booking.email) return { statusCode: 400, body: JSON.stringify({ error: "Booking has no guest email" }) };

    var properties = (await sbGet(PROPS_KEY)) || [];
    var primaryPropId = booking.propertyId || ((booking.stays || [])[0] || {}).propertyId;
    var property = properties.find(function(p) { return p.id === primaryPropId; });

    var templates = (await sbGet(TEMPLATES_KEY)) || DEFAULT_TEMPLATES;
    var tmpl = templates.find(function(t) { return t.id === emailType; });
    if (!tmpl) return { statusCode: 400, body: JSON.stringify({ error: "Unknown email type: " + emailType }) };

    var extra = {};
    if (emailType === "booking_confirmed") {
      var depositEntry = (booking.schedule || []).find(function(s) { return s.label === "Deposit"; });
      if (depositEntry && !depositEntry.paid && Number(depositEntry.amount) > 0) {
        var link = await createPaymentLink(booking, depositEntry, "Deposit");
        extra.paymentLink = link;
        extra.paymentLinkLine = link ? ("\n\nYou can pay your deposit securely here: " + link) : "";
      }
    }

    var tokens = buildTokens(booking, property, extra);
    var subject = fillTemplate(tmpl.subject, tokens);
    var bodyText = fillTemplate(tmpl.body, tokens);
    var attachments = (tmpl.attachments || []).map(function(a) {
      var base64 = (a.dataUrl || "").split(",")[1] || "";
      return { filename: a.name, content: base64 };
    });

    var sendResult = await sendViaResend(booking.email, subject, bodyText, attachments);
    if (!sendResult.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: sendResult.error }) };
    }

    // Mark the send flag + persist any schedule/stripeId changes (e.g. new payment link)
    var flags = Object.assign({}, booking.emailFlags || {});
    flags[emailType + "Sent"] = true;
    booking.emailFlags = flags;
    bookings[idx] = booking;
    await sbSet(ACCOM_KEY, bookings);

    await logEmail(subject, booking.email, emailType, booking.id);

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };

  } catch (err) {
    console.error("send-accom-email error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
