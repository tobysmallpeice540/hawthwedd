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
const TERMS_KEY     = "hbf_terms_v1";
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

// The body is stored alongside the subject so the sent email can be read back
// in full from the app. Capped so a runaway template can't bloat the log row.
async function logEmail(subject, to, type, bookingId, bodyText) {
  try {
    var log = (await sbGet(EMAIL_LOG_KEY)) || [];
    log.push({ id: "el" + Date.now() + "-" + Math.random().toString(36).slice(2, 6), sentAt: new Date().toISOString(), subject: subject, to: to, template: type, bookingId: bookingId, body: String(bodyText || "").slice(0, 8000) });
    await sbSet(EMAIL_LOG_KEY, log.slice(-500));
  } catch (e) { console.error("logEmail failed:", e.message); }
}

// ─── SHARED EMAIL SHELL ───────────────────────────────────────────────────────
// Copied verbatim into each sending function (Netlify functions can't share
// local modules without a bundler step, and the rest of this codebase already
// duplicates its helpers the same way). If you change it, change it everywhere:
//   send-accom-email.js · send-accom-reminders.js · stripe-accom-webhook.js
//
// Deliberately table-based with inline styles: Outlook ignores <style> blocks
// and flexbox, so anything cleverer falls apart in exactly the client most
// guests read mail in. Webfonts don't load reliably either, hence Georgia and
// Helvetica rather than the Cormorant/Jost pairing used on the website.
const BRAND = {
  // The live logo from hawthbushfarm.co.uk, requested at 400px wide so it stays
  // crisp on high-DPI screens while rendering at 110px. Hot-linked rather than
  // hosted here so it tracks the website; if the Squarespace site is ever
  // rebuilt this URL should be re-checked.
  logo:    "https://images.squarespace-cdn.com/content/v1/6897aa6fe61ae2143f465ab1/1754770036281-I54E64T6O6J1YLVL9KYF/logo.png?format=400w",
  site:    "https://www.hawthbushfarm.co.uk",
  bg:      "#f9f6f1",
  panel:   "#ffffff",
  text:    "#2d2a25",
  muted:   "#7a7060",
  border:  "#e8e2d9",
  accent:  "#b8a88a"
};

// Turn the plain-text template body into email HTML: blank lines become
// paragraphs, and any bare URL becomes a link (payment links are pasted into
// the templates as raw URLs).
function bodyToHtml(bodyText) {
  var paras = String(bodyText || "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  return paras.map(function (p) {
    var safe = escapeHtml(p.trim());
    safe = safe.replace(/(https?:\/\/[^\s<]+)/g, function (url) {
      return '<a href="' + url + '" style="color:#2d2a25;text-decoration:underline">' + url + '</a>';
    });
    return '<p style="margin:0 0 15px;font-size:15px;line-height:1.65;color:' + BRAND.text + '">' + safe + '</p>';
  }).join("");
}

// opts: { termsUrl, buttonLabel, buttonUrl }
function buildEmailHtml(bodyText, opts) {
  var o = opts || {};
  var inner = bodyToHtml(bodyText);

  if (o.buttonUrl) {
    inner += '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 6px">' +
      '<tr><td align="center" bgcolor="' + BRAND.text + '" style="border-radius:8px">' +
      '<a href="' + o.buttonUrl + '" style="display:inline-block;padding:13px 30px;font-family:Helvetica,Arial,sans-serif;' +
      'font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px">' +
      escapeHtml(o.buttonLabel || "Pay now") + '</a></td></tr></table>';
  }

  var terms = "";
  if (o.termsUrl) {
    terms = '<p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:' + BRAND.muted + '">' +
      'Your booking is subject to our <a href="' + o.termsUrl + '" style="color:' + BRAND.muted + '">Terms &amp; Conditions</a>.' +
      '</p>';
  }

  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Hawthbush Farm</title></head>' +
    '<body style="margin:0;padding:0;background:' + BRAND.bg + ';">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + BRAND.bg + ';padding:26px 12px">' +
    '<tr><td align="center">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%">' +

    // Logo
    '<tr><td align="center" style="padding:0 0 20px">' +
    '<a href="' + BRAND.site + '"><img src="' + BRAND.logo + '" alt="Hawthbush Farm" width="110" ' +
    'style="display:block;border:0;width:110px;height:auto"></a>' +
    '</td></tr>' +

    // Body panel
    '<tr><td style="background:' + BRAND.panel + ';border:1px solid ' + BRAND.border + ';border-radius:14px;padding:30px 34px;' +
    'font-family:Helvetica,Arial,sans-serif">' + inner + '</td></tr>' +

    // Footer
    '<tr><td align="center" style="padding:20px 16px 0;font-family:Helvetica,Arial,sans-serif">' +
    terms +
    '<p style="margin:0 0 4px;font-size:12px;line-height:1.6;color:' + BRAND.muted + '">' +
    'Hawthbush Farm, Gun Hill, Heathfield, East Sussex &middot; ' +
    '<a href="mailto:' + FROM_EMAIL + '" style="color:' + BRAND.muted + '">' + FROM_EMAIL + '</a></p>' +
    '<p style="margin:0;font-size:12px;color:' + BRAND.muted + '">' +
    '<a href="' + BRAND.site + '" style="color:' + BRAND.muted + '">hawthbushfarm.co.uk</a></p>' +
    '</td></tr>' +

    '</table></td></tr></table></body></html>';
}

// The T&C link is only included when terms have actually been written, so a
// blank setting doesn't produce a link to an empty page.
async function getTermsUrl() {
  try {
    var t = await sbGet(TERMS_KEY);
    if (t && String(t.text || "").trim()) return SITE_ORIGIN + "/terms.html";
  } catch (e) { /* a missing T&C must never stop an email going out */ }
  return "";
}

async function sendViaResend(to, subject, bodyText, attachments, payLink, payLabel) {
  if (!RESEND_KEY) return { ok: false, error: "RESEND_API_KEY not set" };
  var html = buildEmailHtml(bodyText, {
    termsUrl: await getTermsUrl(),
    buttonUrl: payLink || "",
    buttonLabel: payLabel || "Pay now"
  });
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

    // This endpoint backs the manual "send now" buttons as well as the
    // confirmation prompt, so every template that needs a payment link has to
    // be able to get one here — not just booking_confirmed.
    var depositEntry = (booking.schedule || []).find(function(s) { return s.label === "Deposit"; });
    var balanceEntry = (booking.schedule || []).find(function(s) { return s.label === "Balance"; });

    // Refuse the money emails when there is no money involved. Sending a
    // request for £0.00 reads as a fault, and Stripe won't take a zero payment.
    if (emailType === "deposit_request" && !(Number(depositEntry && depositEntry.amount) > 0)) {
      return { statusCode: 400, body: JSON.stringify({ error: "The deposit on this booking is £0, so there is nothing to request." }) };
    }
    if (emailType === "balance_request" && !(Number(balanceEntry && balanceEntry.amount) > 0)) {
      return { statusCode: 400, body: JSON.stringify({ error: "The balance on this booking is £0, so there is nothing to request." }) };
    }

    // Whatever link was minted for this email, kept aside so it can also be
    // rendered as a button. A payment request that reaches the guest without a
    // way to pay is a failed email, so the button is added regardless of
    // whether the template happens to include the {{paymentLink}} token —
    // templates saved before that token existed simply had no link at all.
    var payLink = "", payLabel = "";

    var extra = {};
    if (emailType === "booking_confirmed" || emailType === "deposit_request") {
      if (depositEntry && !depositEntry.paid && Number(depositEntry.amount) > 0) {
        var link = await createPaymentLink(booking, depositEntry, "Deposit");
        extra.paymentLink = link;
        extra.paymentLinkLine = link ? ("\n\nYou can pay your deposit securely here: " + link) : "";
        payLink = link; payLabel = "Pay deposit";
      }
    }
    if (emailType === "balance_request") {
      if (balanceEntry && !balanceEntry.paid && Number(balanceEntry.amount) > 0) {
        var blink = await createPaymentLink(booking, balanceEntry, "Balance");
        extra.paymentLink = blink;
        payLink = blink; payLabel = "Pay balance";
      }
    }
    if (emailType === "payment_confirmation") {
      // Whatever has actually been marked paid so far.
      var paidSoFar = (booking.schedule || []).reduce(function(a, s) {
        return a + (s.paid ? Number(s.amount) || 0 : 0);
      }, 0);
      if (!(paidSoFar > 0)) {
        return { statusCode: 400, body: JSON.stringify({ error: "Nothing has been marked as paid on this booking, so there is no payment to confirm." }) };
      }
      extra.amountPaid = paidSoFar.toFixed(2);
    }

    var tokens = buildTokens(booking, property, extra);
    var subject = fillTemplate(tmpl.subject, tokens);
    var bodyText = fillTemplate(tmpl.body, tokens);
    var attachments = (tmpl.attachments || []).map(function(a) {
      var base64 = (a.dataUrl || "").split(",")[1] || "";
      return { filename: a.name, content: base64 };
    });

    var sendResult = await sendViaResend(booking.email, subject, bodyText, attachments, payLink, payLabel);
    if (!sendResult.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: sendResult.error }) };
    }

    // Mark the send flag + persist any schedule/stripeId changes (e.g. new payment link)
    var flags = Object.assign({}, booking.emailFlags || {});
    flags[emailType + "Sent"] = true;
    booking.emailFlags = flags;
    bookings[idx] = booking;
    await sbSet(ACCOM_KEY, bookings);

    await logEmail(subject, booking.email, emailType, booking.id, bodyText);

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };

  } catch (err) {
    console.error("send-accom-email error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
