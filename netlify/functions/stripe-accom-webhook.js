// netlify/functions/stripe-accom-webhook.js
// Handles Stripe webhook events for accommodation bookings.
//
// Two payment flows land here, distinguished by session.metadata.bookingType:
//   "accom_deposit"  — original website booking flow (create-accom-checkout.js).
//                       Matched by b.stripeSessionId === session.id.
//                       First-ever payment on this booking, so also sends the
//                       "Booking Confirmed" email (guarded by emailFlags).
//   "accom_reminder" — a deposit/balance reminder payment link minted by
//                       send-accom-email.js or send-accom-reminders.js.
//                       Matched by metadata.bookingId + metadata.scheduleLabel.
// Either flow: marks the matching schedule entry paid and sends the
// "Payment Confirmation" email (guarded so Stripe retries don't double-send).
//
// Required Netlify env vars:
//   STRIPE_SECRET_KEY      — Stripe secret key (sk_live_...)
//   STRIPE_WEBHOOK_SECRET  — Stripe webhook signing secret (whsec_...)
//   RESEND_API_KEY         — Resend API key
//
// In your Stripe dashboard, add a webhook endpoint pointing to:
//   https://cool-sorbet-b1d599.netlify.app/.netlify/functions/stripe-accom-webhook
// Events to listen for: checkout.session.completed

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const SUPABASE_URL  = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SUPABASE_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJrcWJ5aXNmbXZ3dWxzeXh6d2p6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NTI0MzgsImV4cCI6MjA5NjUyODQzOH0._CsyhvFrtHFC0KrfiLzbrLUaKcvxtbWlHydaH20tvfo";
const RESEND_KEY    = process.env.RESEND_API_KEY;
const FROM_EMAIL    = "hello@hawthbushfarm.co.uk";
const ACCOM_KEY     = "hbf_accom_v1";
const PROPS_KEY     = "hbf_properties_v1";
const TEMPLATES_KEY = "hbf_email_templates_v1";
const EMAIL_LOG_KEY = "hbf_email_log_v1";

const DEFAULT_TEMPLATES = [
  { id: "booking_confirmed", subject: "Booking Confirmed – {{propertyName}} – Ref {{bookingRef}}",
    body: "Dear {{guestName}},\n\nThank you for booking with Hawthbush Farm! Your reservation is confirmed.\n\nBooking reference: {{bookingRef}}\nProperty: {{propertyName}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nDuration: {{nights}} nights\nTotal: £{{totalAmount}}\n\nA deposit of £{{depositAmount}} is due by {{depositDueDate}}.\n\nIf you have any questions, please don't hesitate to get in touch.\n\nWarm regards,\nHawthbush Farm", attachments: [] },
  { id: "payment_confirmation", subject: "Payment Received – {{propertyName}} – Ref {{bookingRef}}",
    body: "Dear {{guestName}},\n\nThank you – we have received your payment of £{{amountPaid}} for your booking at Hawthbush Farm.\n\nBooking reference: {{bookingRef}}\nProperty: {{propertyName}}\nCheck-in: {{checkIn}}\nCheck-out: {{checkOut}}\nAmount received: £{{amountPaid}}\n\nWarm regards,\nHawthbush Farm", attachments: [] },
];

// ── Supabase helpers (no header spread) ──────────────────────────────────────
async function sbGet(key) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data?key=eq." + key + "&select=value", {
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": "Bearer " + SUPABASE_KEY
    }
  });
  if (!res.ok) throw new Error("sbGet failed: " + await res.text());
  const rows = await res.json();
  return (rows && rows[0]) ? rows[0].value : null;
}

async function sbSet(key, value) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data", {
    method: "POST",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates"
    },
    body: JSON.stringify({ key: key, value: value })
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

function buildTokens(booking, property, extra) {
  var stays = (booking.stays && booking.stays.length) ? booking.stays : [booking];
  var propNames = stays.map(function(s) { return s.propertyName || s.propertyId; }).join(" + ");
  var depositEntry = (booking.schedule || []).find(function(s) { return s.label === "Deposit"; });
  var tokens = {
    guestName:      booking.guestName || "Guest",
    bookingRef:     String(booking.id || "").toUpperCase(),
    propertyName:   propNames,
    checkIn:        fmtDateNice(booking.checkIn),
    checkOut:       fmtDateNice(booking.checkOut),
    nights:         booking.nights || "",
    totalAmount:    Number(booking.value || 0).toFixed(2),
    depositAmount:  depositEntry ? Number(depositEntry.amount || 0).toFixed(2) : "",
    depositDueDate: depositEntry ? fmtDateNice(depositEntry.dueDate) : "",
    amountPaid:     "",
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

async function sendViaResend(to, subject, bodyText) {
  if (!RESEND_KEY || !to) return { ok: false, error: "RESEND_API_KEY not set or no recipient" };
  var html = "<div style='font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#333;line-height:1.6'>" + escapeHtml(bodyText) + "</div>";
  var res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_EMAIL, to: to, subject: subject, html: html }),
  });
  if (!res.ok) return { ok: false, error: "Resend failed: " + await res.text() };
  return { ok: true };
}

async function sendPaymentEmails(booking, amountPaidPence, templates, properties, opts) {
  var property = properties.find(function(p) { return p.id === (booking.propertyId || ((booking.stays || [])[0] || {}).propertyId); });
  var amountPaid = (amountPaidPence / 100).toFixed(2);

  // Booking Confirmed — only for the very first (accom_deposit) payment on a booking
  if (opts.sendBookingConfirmed && booking.email && !(booking.emailFlags || {}).bookingConfirmedSent) {
    var bcTmpl = templates.find(function(t) { return t.id === "booking_confirmed"; }) || DEFAULT_TEMPLATES.find(function(t) { return t.id === "booking_confirmed"; });
    var bcTokens = buildTokens(booking, property, {});
    var bcSubject = fillTemplate(bcTmpl.subject, bcTokens);
    var bcBody = fillTemplate(bcTmpl.body, bcTokens);
    var bcRes = await sendViaResend(booking.email, bcSubject, bcBody);
    if (bcRes.ok) {
      await logEmail(bcSubject, booking.email, "booking_confirmed", booking.id);
      booking.emailFlags = Object.assign({}, booking.emailFlags || {}, { bookingConfirmedSent: true });
    } else {
      console.error("booking_confirmed send failed:", bcRes.error);
    }
  }

  // Payment Confirmation — every successful payment
  if (booking.email) {
    var pcTmpl = templates.find(function(t) { return t.id === "payment_confirmation"; }) || DEFAULT_TEMPLATES.find(function(t) { return t.id === "payment_confirmation"; });
    var pcTokens = buildTokens(booking, property, { amountPaid: amountPaid });
    var pcSubject = fillTemplate(pcTmpl.subject, pcTokens);
    var pcBody = fillTemplate(pcTmpl.body, pcTokens);
    var pcRes = await sendViaResend(booking.email, pcSubject, pcBody);
    if (pcRes.ok) {
      await logEmail(pcSubject, booking.email, "payment_confirmation", booking.id);
    } else {
      console.error("payment_confirmation send failed:", pcRes.error);
    }
  }

  return booking;
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const sig = event.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return { statusCode: 400, body: "Webhook signature verification failed" };
  }

  if (stripeEvent.type !== "checkout.session.completed") {
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  }

  const session = stripeEvent.data.object;
  const metaType = session.metadata && session.metadata.bookingType;

  if (metaType !== "accom_deposit" && metaType !== "accom_reminder") {
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  }

  try {
    const sessionId = session.id;
    const paidAt    = new Date().toISOString();
    const paidDate  = paidAt.slice(0, 10);
    const amountPence = session.amount_total || 0;

    const bookings   = (await sbGet(ACCOM_KEY)) || [];
    const properties = (await sbGet(PROPS_KEY)) || [];
    const templates   = (await sbGet(TEMPLATES_KEY)) || DEFAULT_TEMPLATES;

    let found = false;
    let alreadyPaid = false;
    let targetIdx = -1;

    if (metaType === "accom_deposit") {
      targetIdx = bookings.findIndex(function(b) { return b.stripeSessionId === sessionId; });
    } else {
      const bookingId = session.metadata.bookingId;
      targetIdx = bookings.findIndex(function(b) { return String(b.id) === String(bookingId); });
    }

    if (targetIdx === -1) {
      console.warn("No booking found for Stripe session:", sessionId, metaType);
      return { statusCode: 200, body: JSON.stringify({ received: true, warning: "Booking not found" }) };
    }

    found = true;
    var booking = Object.assign({}, bookings[targetIdx]);

    if (metaType === "accom_deposit") {
      booking.status = "confirmed";
      var schedule1 = (booking.schedule || []).map(function(s) {
        if (s.stripeId === sessionId || s.label === "Deposit") {
          if (s.paid) alreadyPaid = true;
          return Object.assign({}, s, { paid: true, paidDate: paidDate });
        }
        return s;
      });
      booking.schedule = schedule1;
      if (session.payment_intent) booking.depositStripeId = session.payment_intent;
    } else {
      var scheduleLabel = session.metadata.scheduleLabel;
      var schedule2 = (booking.schedule || []).map(function(s) {
        if (s.label === scheduleLabel) {
          if (s.paid) alreadyPaid = true;
          return Object.assign({}, s, { paid: true, paidDate: paidDate });
        }
        return s;
      });
      booking.schedule = schedule2;
    }

    if (!alreadyPaid) {
      booking = await sendPaymentEmails(booking, amountPence, templates, properties, { sendBookingConfirmed: metaType === "accom_deposit" });
    } else {
      console.log("Schedule entry already marked paid — skipping duplicate email for session", sessionId);
    }

    bookings[targetIdx] = booking;
    await sbSet(ACCOM_KEY, bookings);
    console.log("Booking updated for Stripe session:", sessionId, metaType);

    return { statusCode: 200, body: JSON.stringify({ received: true }) };

  } catch (err) {
    console.error("stripe-accom-webhook error:", err);
    // Return 500 so Stripe retries
    return { statusCode: 500, body: "Internal error — Stripe will retry" };
  }
};
