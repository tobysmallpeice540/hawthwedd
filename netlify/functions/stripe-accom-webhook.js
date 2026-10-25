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
// The service key, not the anon key. Server-side code has no business
// holding the same credential the public pages carry — and once app_data
// has row level security this is what keeps the scheduled jobs working.
// No fallback to the anon key on purpose: a missing variable should fail
// loudly rather than quietly reopen what this change closes.
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY    = process.env.RESEND_API_KEY;
const FROM_EMAIL    = "hello@hawthbushfarm.co.uk";
// What the recipient sees in their inbox. Without a display name, mail clients
// fall back to the local part of the address — so everything arrived from
// "hello", which tells nobody anything. FROM_EMAIL itself stays a bare address
// because the footer uses it for a mailto: link.
const FROM_HEADER  = "Hawthbush Farm <" + FROM_EMAIL + ">";
const ACCOM_KEY     = "hbf_accom_v1";
const PROPS_KEY     = "hbf_properties_v1";
const TEMPLATES_KEY = "hbf_email_templates_v1";
const EMAIL_LOG_KEY = "hbf_email_log_v1";
const TERMS_KEY     = "hbf_terms_v1";
// Used by getTermsUrl below. It was referenced but never defined, so the
// ReferenceError was swallowed by getTermsUrl's catch and the T&C link never
// appeared on these emails.
const SITE_ORIGIN   = "https://hawthbushfarm.netlify.app";
// Where "this needs a human" emails go — same address as the ticket webhook's
// OFFICE_EMAIL and submit-brochure's default notifyEmail.
const OFFICE_EMAIL  = "hello@hawthbushfarm.co.uk";

const DEFAULT_TEMPLATES = [
  { id: "booking_confirmed", subject: "Booking Confirmed – {{propertyName}} – Ref {{bookingRef}}",
    body: "Dear {{guestName}},\n\nThank you for booking with Hawthbush Farm! Your reservation is confirmed.\n\nBooking reference: {{bookingRef}}\n{{stayDetails}}\n\nTotal: £{{totalAmount}}\n\nA deposit of £{{depositAmount}} is due by {{depositDueDate}}.\n\nIf you have any questions, please don't hesitate to get in touch.\n\nWarm regards,\nHawthbush Farm", attachments: [] },
  { id: "payment_confirmation", subject: "Payment Received – {{propertyName}} – Ref {{bookingRef}}",
    body: "Dear {{guestName}},\n\nThank you – we have received your payment of £{{amountPaid}} for your booking at Hawthbush Farm.\n\nBooking reference: {{bookingRef}}\n{{stayDetails}}\nAmount received: £{{amountPaid}}\n\nWarm regards,\nHawthbush Farm", attachments: [] },
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

// Arrival and departure across every stay (earliest in, latest out); the flat
// fields are only a fallback — many bookings carry only their stays.
function arrivalOf(booking) {
  var ins = (booking.stays || []).map(function(s) { return s && s.checkIn; }).filter(Boolean).sort();
  return ins.length ? ins[0] : (booking.checkIn || null);
}
function departureOf(booking) {
  var outs = (booking.stays || []).map(function(s) { return s && s.checkOut; }).filter(Boolean).sort();
  return outs.length ? outs[outs.length - 1] : (booking.checkOut || null);
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
  var tokens = {
    guestName:      booking.guestName || "Guest",
    bookingRef:     String(booking.id || "").toUpperCase(),
    propertyName:   propNames,
    stayDetails:    buildStayDetailsText(booking),
    checkIn:        fmtDateNice(arrivalOf(booking)),
    checkOut:       fmtDateNice(departureOf(booking)),
    nights:         booking.nights || "",
    totalAmount:    Number(booking.value || 0).toFixed(2),
    depositAmount:  depositEntry ? Number(depositEntry.amount || 0).toFixed(2) : "",
    depositDueDate: depositEntry ? fmtDateNice(depositEntry.dueDate) : "",
    amountPaid:     "",
    receiptUrl:     "",
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
      // Show something readable rather than a 200-character query string.
      var label = url.length > 60 ? url.replace(/^https?:\/\//, "").split("/")[0] + "/…" : url;
      return '<a href="' + url + '" style="color:#2d2a25;text-decoration:underline">' + label + '</a>';
    });
    return '<p style="margin:0 0 15px;font-size:15px;line-height:1.65;color:' + BRAND.text + '">' + safe + '</p>';
  }).join("");
}

// opts: { termsUrl, buttonLabel, buttonUrl }
function buildEmailHtml(bodyText, opts) {
  var o = opts || {};

  var payButton = "";
  if (o.buttonUrl) {
    payButton = '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0">' +
      '<tr><td align="center" bgcolor="' + BRAND.text + '" style="border-radius:8px">' +
      '<a href="' + o.buttonUrl + '" style="display:inline-block;padding:14px 34px;font-family:Helvetica,Arial,sans-serif;' +
      'font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px">' +
      escapeHtml(o.buttonLabel || "Pay now") + '</a></td></tr>' +
      // The Stripe cue reassures the guest about where their card details go —
      // it replaces the reassurance the visible checkout.stripe.com URL used
      // to give before the raw link was taken out.
      '<tr><td align="center" style="padding-top:8px;font-family:Helvetica,Arial,sans-serif;font-size:11px;color:' + BRAND.muted + '">' +
      'Secure card payment powered by Stripe</td></tr></table>';
  }

  // Checkout URLs run past a hundred characters and wrap over several lines,
  // which looks broken. The button carries the link instead — and it goes
  // exactly where the URL sat, so the sentence introducing it still leads into
  // it and the sign-off stays at the bottom. With no URL in the wording (an
  // older template), the button is appended after the text.
  var inner;
  if (o.buttonUrl && String(bodyText || "").indexOf(o.buttonUrl) !== -1) {
    var halves = String(bodyText).split(o.buttonUrl);
    var before = halves[0].replace(/[ \t]+$/, "").replace(/\n+$/, "");
    var after  = halves.slice(1).join(o.buttonUrl).replace(/^\n+/, "");
    inner = bodyToHtml(before) + payButton + bodyToHtml(after);
  } else {
    inner = bodyToHtml(bodyText) + payButton;
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

async function sendViaResend(to, subject, bodyText, payLink, payLabel) {
  if (!RESEND_KEY || !to) return { ok: false, error: "RESEND_API_KEY not set or no recipient" };
  var html = buildEmailHtml(bodyText, {
    termsUrl: await getTermsUrl(),
    buttonUrl: payLink || "",
    buttonLabel: payLabel || "Pay now"
  });
  var res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_HEADER, to: to, subject: subject, html: html }),
  });
  if (!res.ok) return { ok: false, error: "Resend failed: " + await res.text() };
  return { ok: true };
}

// Stripe's receipt page for a completed session. The session itself doesn't
// carry it — it lives on the charge behind the payment intent — so the intent
// is retrieved with the charge expanded. Wrapped in its own try/catch and
// always resolving: a missing receipt link must never stop a payment being
// recorded, which is the part that actually matters.
async function fetchReceiptUrl(session) {
  try {
    if (!session.payment_intent) return { receiptUrl: "", paymentIntentId: "" };
    var piId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent.id;
    var pi = await stripe.paymentIntents.retrieve(piId, { expand: ["latest_charge"] });
    var charge = pi && pi.latest_charge;
    return {
      receiptUrl: (charge && charge.receipt_url) || "",
      paymentIntentId: piId
    };
  } catch (e) {
    console.error("Could not fetch Stripe receipt URL:", e.message);
    return { receiptUrl: "", paymentIntentId: "" };
  }
}

async function sendPaymentEmails(booking, amountPaidPence, templates, properties, opts) {
  var property = properties.find(function(p) { return p.id === (booking.propertyId || ((booking.stays || [])[0] || {}).propertyId); });
  var amountPaid = (amountPaidPence / 100).toFixed(2);

  opts.result = opts.result || {};
  // Booking Confirmed — only for the very first (accom_deposit) payment on a
  // booking. The flag was already claimed in the record written before this
  // ran (see applyPayment), so the caller says whether to send it.
  if (opts.sendBookingConfirmed && booking.email) {
    var bcTmpl = templates.find(function(t) { return t.id === "booking_confirmed"; }) || DEFAULT_TEMPLATES.find(function(t) { return t.id === "booking_confirmed"; });
    var bcTokens = buildTokens(booking, property, {});
    var bcSubject = fillTemplate(bcTmpl.subject, bcTokens);
    var bcBody = fillTemplate(bcTmpl.body, bcTokens);
    var bcRes = await sendViaResend(booking.email, bcSubject, bcBody);
    if (bcRes.ok) {
      await logEmail(bcSubject, booking.email, "booking_confirmed", booking.id, bcBody);
    } else {
      console.error("booking_confirmed send failed:", bcRes.error);
      opts.result.bookingConfirmedFailed = true;
    }
  }

  // Payment Confirmation — every successful payment of an actual amount.
  // A £0.00 receipt is confusing rather than reassuring.
  if (booking.email && Number(amountPaid) > 0) {
    var pcTmpl = templates.find(function(t) { return t.id === "payment_confirmation"; }) || DEFAULT_TEMPLATES.find(function(t) { return t.id === "payment_confirmation"; });
    var pcTokens = buildTokens(booking, property, { amountPaid: amountPaid, receiptUrl: opts.receiptUrl || "" });
    var pcSubject = fillTemplate(pcTmpl.subject, pcTokens);
    var pcBody = fillTemplate(pcTmpl.body, pcTokens);
    // The receipt doubles as proof of payment, so it goes on the confirmation
    // as a button rather than only being visible in the office.
    var pcRes = await sendViaResend(booking.email, pcSubject, pcBody, opts.receiptUrl || "", "View your receipt");
    if (pcRes.ok) {
      await logEmail(pcSubject, booking.email, "payment_confirmation", booking.id, pcBody);
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

    // The slow Stripe call comes first, so the bookings array is read only
    // once everything else is in hand and written straight back.
    const receipt = await fetchReceiptUrl(session);

    const properties = (await sbGet(PROPS_KEY)) || [];
    const templates   = (await sbGet(TEMPLATES_KEY)) || DEFAULT_TEMPLATES;

    // Re-read immediately before the write, and change only this booking.
    const bookings   = (await sbGet(ACCOM_KEY)) || [];
    const r = applyPayment(bookings, {
      metaType: metaType, sessionId: sessionId,
      bookingId: session.metadata.bookingId, scheduleLabel: session.metadata.scheduleLabel,
      amountPence: amountPence, paidDate: paidDate,
      receiptUrl: receipt.receiptUrl, paymentIntentId: receipt.paymentIntentId,
      paymentIntent: session.payment_intent
    });

    if (r.notFound) {
      console.warn("No booking found for Stripe session:", sessionId, metaType);
      await notifyOffice("Lettings payment received but no booking matches — please check Stripe",
        "A lettings payment came through Stripe, but no booking in the app matches it — it may have been deleted.\n\n" +
        "Amount: £" + (amountPence / 100).toFixed(2) + "\n" +
        "Type: " + metaType + "\n" +
        "Booking ref (from Stripe): " + (session.metadata.bookingId || "—") + "\n" +
        "Guest: " + (session.metadata.guestName || "—") + " " + (session.customer_email || session.metadata.email || "") + "\n" +
        "Checkout session: " + sessionId + "\n\n" +
        "Nothing has been recorded. Refund it in Stripe, or re-create the booking and mark the payment by hand.");
      return { statusCode: 200, body: JSON.stringify({ received: true, warning: "Booking not found" }) };
    }

    if (r.duplicate) {
      console.log("Payment already recorded — retried delivery for session", sessionId);
      return { statusCode: 200, body: JSON.stringify({ received: true, duplicate: true }) };
    }

    // The record goes in BEFORE any email. If this write fails Stripe retries
    // and nothing has been sent; once it has landed, a retry finds the entry
    // already paid and sends nothing.
    await sbSet(ACCOM_KEY, r.list);
    console.log("Booking updated for Stripe session:", sessionId, metaType);

    var booking = r.booking;

    if (r.cancelled) {
      // Money on a cancelled booking: recorded, status untouched, no guest
      // email — somebody has to decide between a refund and a reinstatement.
      await notifyOffice("Payment received on a CANCELLED booking " + String(booking.id).toUpperCase() + " — please check",
        "A lettings payment came in for a booking that is marked cancelled. It has been recorded against the booking, " +
        "but the booking has been left cancelled and the guest has not been emailed.\n\n" +
        "Booking: " + String(booking.id).toUpperCase() + " — " + (booking.guestName || "") + " " + (booking.email || "") + "\n" +
        buildStayDetailsText(booking) + "\n" +
        "Amount: £" + (amountPence / 100).toFixed(2) + "\n\n" +
        "Refund it in Stripe, or reinstate the booking in the app.");
      return { statusCode: 200, body: JSON.stringify({ received: true, cancelled: true }) };
    }

    if (r.setAside) {
      await notifyOffice(
        (r.setAside === "entry_already_paid" ? "Possible DOUBLE payment on " : "Lettings payment needs matching on ") + String(booking.id).toUpperCase(),
        (r.setAside === "entry_already_paid"
          ? "A lettings payment came in for a payment that is already marked paid by a different Stripe payment, so the same instalment may have been paid twice. "
          : "A lettings payment came in, but no payment on the booking matches it (it was for \"" + (session.metadata.scheduleLabel || "") + "\", which may have been renamed or split since the link went out). ") +
        "It has been recorded on the booking under payments to match, nothing has been marked paid, and the guest has not been emailed.\n\n" +
        "Booking: " + String(booking.id).toUpperCase() + " — " + (booking.guestName || "") + " " + (booking.email || "") + "\n" +
        buildStayDetailsText(booking) + "\n" +
        "Amount: £" + (amountPence / 100).toFixed(2) + "\n" +
        "Checkout session: " + sessionId + "\n\n" +
        (r.setAside === "entry_already_paid" ? "Refund one of the two in Stripe if it is a duplicate." : "Mark the right payment paid in the app."));
      return { statusCode: 200, body: JSON.stringify({ received: true, setAside: r.setAside }) };
    }

    if (r.alreadyPaid) {
      console.log("Schedule entry already marked paid — skipping duplicate email for session", sessionId);
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }

    var result = {};
    await sendPaymentEmails(booking, amountPence, templates, properties, {
      sendBookingConfirmed: r.sendBookingConfirmed,
      receiptUrl: receipt.receiptUrl,
      result: result
    });

    // The confirmation flag was claimed in the write above. If that email
    // then failed, give the flag back so the office can see it was not sent.
    if (r.sendBookingConfirmed && result.bookingConfirmedFailed) {
      try {
        var fresh = (await sbGet(ACCOM_KEY)) || [];
        var k = fresh.findIndex(function(b) { return b && String(b.id) === String(booking.id); });
        if (k !== -1 && (fresh[k].emailFlags || {}).bookingConfirmedSent) {
          var fl = Object.assign({}, fresh[k].emailFlags); delete fl.bookingConfirmedSent;
          fresh = fresh.slice(); fresh[k] = Object.assign({}, fresh[k], { emailFlags: fl });
          await sbSet(ACCOM_KEY, fresh);
        }
      } catch (e) { console.error("Could not release bookingConfirmedSent:", e.message); }
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };

  } catch (err) {
    console.error("stripe-accom-webhook error:", err);
    // Return 500 so Stripe retries
    return { statusCode: 500, body: "Internal error — Stripe will retry" };
  }
};

// ── The payment, applied to a freshly read bookings array ─────────────────────
// Pure, so it can be tested. Returns one of:
//   { notFound: true }
//   { duplicate: true }            — this payment is already on the record
//   { list, booking, cancelled, sendBookingConfirmed }
// Rules:
//   · only the matched booking changes; everything else is written as read;
//   · the schedule entry is marked paid with this payment's details;
//   · status is promoted from "pending" to "confirmed" and from nothing else —
//     a cancelled booking stays cancelled (the caller tells the office);
//   · for the first online payment the bookingConfirmedSent flag is claimed
//     here, in the same write, so a retry can never send it twice.
function applyPayment(bookings, p) {
  var list = Array.isArray(bookings) ? bookings.slice() : [];
  var idx;
  if (p.metaType === "accom_deposit") {
    idx = list.findIndex(function(b) { return b && b.stripeSessionId === p.sessionId; });
  } else {
    idx = list.findIndex(function(b) { return b && String(b.id) === String(p.bookingId); });
  }
  if (idx === -1) return { notFound: true };

  var booking = Object.assign({}, list[idx]);
  var matches = p.metaType === "accom_deposit"
    ? function(s) { return s.stripeId === p.sessionId || s.label === "Deposit"; }
    : function(s) { return s.label === p.scheduleLabel; };

  var thisPayment = function(s) {
    return s && ((p.paymentIntentId && s.paymentIntentId === p.paymentIntentId) || (p.sessionId && s.paidSessionId === p.sessionId));
  };
  // A retried delivery: this very payment is already on the record, on a
  // schedule entry or among the payments set aside below.
  var dup = (booking.schedule || []).some(function(s) { return s && s.paid && thisPayment(s); }) ||
            (booking.unmatchedPayments || []).some(thisPayment);
  if (dup) return { duplicate: true };

  var paymentRecord = {
    paidDate: p.paidDate,
    paidAmount: Math.round(p.amountPence) / 100,
    receiptUrl: p.receiptUrl,
    paymentIntentId: p.paymentIntentId,
    paidSessionId: p.sessionId
  };
  // The entry this pays: the first matching one not yet paid, else the first
  // matching one.
  var sched = booking.schedule || [];
  var target = sched.findIndex(function(s) { return s && matches(s) && !s.paid; });
  if (target === -1) target = sched.findIndex(function(s) { return s && matches(s); });

  // Set aside rather than lost or written over (24 Oct second review):
  //   · no entry matches — the label was renamed or split after the link was
  //     sent. Nothing was marked paid and the guest was told "received";
  //   · the entry is already paid by a DIFFERENT Stripe payment — the same
  //     instalment paid twice (an old checkout tab finished after a link was
  //     paid). Overwriting it hid the first payment.
  // Either way the money is recorded on the booking, the office is told, and
  // the guest is not emailed.
  var setAside = null;
  if (target === -1) setAside = "no_matching_entry";
  else if (sched[target].paid && (sched[target].paidSessionId || sched[target].paymentIntentId)) setAside = "entry_already_paid";

  var alreadyPaid = false;
  if (setAside) {
    booking.unmatchedPayments = (booking.unmatchedPayments || []).concat([Object.assign({
      reason: setAside, label: p.metaType === "accom_deposit" ? "Deposit" : (p.scheduleLabel || "")
    }, paymentRecord)]);
  } else {
    // Paid by hand, or by an older delivery that recorded no Stripe ids: the
    // details are recorded, the guest is not emailed again.
    if (sched[target].paid) alreadyPaid = true;
    booking.schedule = sched.map(function(s, i) {
      return i === target ? Object.assign({}, s, { paid: true }, paymentRecord) : s;
    });
  }
  if (p.metaType === "accom_deposit" && p.paymentIntent && !setAside) booking.depositStripeId = p.paymentIntent;

  var cancelled = booking.status === "cancelled";

  // Money received on a pending booking confirms it, however it arrived —
  // the deposit is often paid against a reminder session rather than the
  // original checkout (booking W15032 sat pending with £1,170 banked).
  // Deliberately only promotes FROM pending.
  if (booking.status === "pending" && ((booking.schedule || []).some(function(s) { return s && s.paid; }) || setAside)) {
    booking.status = "confirmed";
  }

  var sendBookingConfirmed = false;
  if (!cancelled && !alreadyPaid && !setAside && p.metaType === "accom_deposit" && booking.email &&
      !(booking.emailFlags || {}).bookingConfirmedSent) {
    sendBookingConfirmed = true;
    booking.emailFlags = Object.assign({}, booking.emailFlags || {}, { bookingConfirmedSent: true });
  }

  list[idx] = booking;
  // alreadyPaid without being a duplicate: the entry was already marked paid
  // (by hand, or by an older delivery before paidSessionId was recorded). The
  // Stripe details are recorded, but the guest is not emailed again.
  return { list: list, booking: booking, cancelled: cancelled, sendBookingConfirmed: sendBookingConfirmed, alreadyPaid: alreadyPaid, setAside: setAside };
}

async function notifyOffice(subject, text) {
  try {
    if (!RESEND_KEY) { console.error("notifyOffice: RESEND_API_KEY not set —", subject); return; }
    var res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_HEADER, to: OFFICE_EMAIL, subject: subject, html: buildEmailHtml(text, {}) }),
    });
    if (!res.ok) console.error("notifyOffice failed:", await res.text());
  } catch (e) { console.error("notifyOffice failed:", e.message); }
}

exports._internals = { applyPayment };
