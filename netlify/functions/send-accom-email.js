// netlify/functions/send-accom-email.js
// On-demand single email send for a lettings booking, using the saved email
// templates. Currently used for the "Send booking confirmation email?" prompt
// shown in the app when a manual booking is created with a guest email.
//
// POST /.netlify/functions/send-accom-email
// Body: { bookingId: "a123", emailType: "booking_confirmed" }
//
// Admin only: the caller's Supabase session must belong to an active admin.
// This sends guests real payment requests, so it is not open to the web.
//
// Required env vars: RESEND_API_KEY, STRIPE_SECRET_KEY

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
const SITE_ORIGIN   = "https://hawthbushfarm.netlify.app";
// Returned with every response so the app can show which version of this
// function actually answered — the quickest way to tell a code problem from a
// "not deployed yet" problem.
const FN_BUILD      = "2026-08-12e";

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
  // Throws on a refused read. Returning null here used to let logEmail read
  // a failed read as "no log yet" and overwrite the whole email log with one
  // row; the same shape would have done it to the bookings.
  if (!res.ok) throw new Error("sbGet " + key + " failed: " + res.status);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error("sbGet " + key + ": unexpected response");
  return rows[0] ? rows[0].value : null;
}

// ── Who is calling ────────────────────────────────────────────────────────────
// The staff app sends the signed-in user's Supabase session as a Bearer token.
// Supabase checks the token; the profile (role, active) is then read with the
// service key. Same shape as resolveAdmin in signwell.js — copied, not shared,
// like every helper in this folder.
async function resolveStaff(event, roles) {
  var h = (event && event.headers) || {};
  var jwt = String(h["authorization"] || h["Authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt || !SUPABASE_KEY) return null;
  try {
    var res = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + jwt }
    });
    if (!res.ok) return null;
    var user = await res.json();
    if (!user || !user.id) return null;
    var pr = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + encodeURIComponent(user.id) + "&select=role,active,name,email", {
      headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY }
    });
    if (!pr.ok) return null;
    var rows = await pr.json();
    var p = Array.isArray(rows) ? rows[0] : null;
    if (!p || p.active === false || roles.indexOf(p.role) === -1) return null;
    return { id: user.id, role: p.role, who: p.name || p.email || user.email || "" };
  } catch (e) {
    console.error("resolveStaff failed:", e.message);
    return null;
  }
}

async function sbSet(key, value) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data", {
    method: "POST",
    headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
    body: JSON.stringify({ key: key, value: value, updated_at: new Date().toISOString() }),
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

var WA_ARRIVAL = {};   // hbf_whatsapp_settings_v1.arrival, read once per run
var WA_HOSTED = {};    // templates.js hostedPacks(): hosted pack links, per property / kind of event
var WA_EVENTS = [];    // hawthbush_bookings_v6, only to tell a linked letting's kind of event
var PACKS = require("./whatsapp-reminders/templates.js");
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
    checkIn:        fmtDateNice(arrivalOf(booking)),
    checkOut:       fmtDateNice(departureOf(booking)),
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
  // The gate code and the arrival pack, set on Settings → WhatsApp and shared
  // with the pre-arrival WhatsApp (30 Oct): {{gateCode}}, {{arrivalPack}} —
  // the first property of the stay that has a pack link.
  tokens.gateCode = String(WA_ARRIVAL.gateCode || "");
  tokens.arrivalPack = "";
  var packs = WA_ARRIVAL.packs || {};
  for (var i = 0; i < stays.length; i++) {
    if (packs[stays[i].propertyId]) { tokens.arrivalPack = String(packs[stays[i].propertyId]); break; }
  }
  // Else the hosted link to the pack on this booking's arrival email: the one
  // marked for its kind of event or property, else the one for everyone.
  if (!tokens.arrivalPack) tokens.arrivalPack = PACKS.pickHostedPack(WA_HOSTED, PACKS.usesEventTemplate(booking), PACKS.packTags(booking, WA_EVENTS));
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
// Web addresses in an email become links, with or without the http(s)://
// ("hawthbushfarm.co.uk/book-viewing", "www.example.com" — 28 Oct). An email
// address is left alone; a full stop or bracket after an address stays text.
var LINK_RE = /(^|[^@\w.\/-])((?:https?:\/\/|www\.)[^\s<]+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:co\.uk|org\.uk|com|org|net|uk|events)(?:\/[^\s<]*)?)/gi;
function linkifyEscaped(safe, short) {
  return String(safe).replace(LINK_RE, function (m, pre, url) {
    var tail = (/[.,;:!?)]+$/.exec(url) || [""])[0];
    url = url.slice(0, url.length - tail.length);
    if (!url) return m;
    var href = /^https?:\/\//i.test(url) ? url : "https://" + url;
    // Show something readable rather than a 200-character query string.
    var label = short && url.length > 60 ? url.replace(/^https?:\/\//i, "").split("/")[0] + "/…" : url;
    return pre + '<a href="' + href + '" style="color:#2d2a25;text-decoration:underline">' + label + '</a>' + tail;
  });
}
function bodyToHtml(bodyText) {
  var paras = String(bodyText || "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  return paras.map(function (p) {
    var safe = escapeHtml(p.trim());
    safe = linkifyEscaped(safe, true);
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
    body: JSON.stringify({ from: FROM_HEADER, to: to, subject: subject, html: html, attachments: (attachments && attachments.length) ? attachments : undefined }),
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
        product_data: { name: label + " — " + propNames, description: fmtDateNice(arrivalOf(booking)) + " to " + fmtDateNice(departureOf(booking)) },
        unit_amount: amountPence,
      },
      quantity: 1,
    }],
    metadata: { bookingType: "accom_reminder", bookingId: String(booking.id), scheduleLabel: label },
    success_url: "https://www.hawthbushfarm.co.uk/book?paid=1",
    // Back / cancel goes to the booking page on the main website.
    cancel_url:  "https://www.hawthbushfarm.co.uk/book",
  });
  entry.stripeId = session.id;
  return session.url;
}

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  var me = await resolveStaff(event, ["admin"]);
  if (!me) {
    return { statusCode: 403, headers: { "Content-Type": "application/json" },
             body: JSON.stringify({ error: "Only a signed-in administrator can send lettings emails.", fn: FN_BUILD }) };
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
    // Gate code and arrival packs for {{gateCode}} / {{arrivalPack}}; a failed
    // read leaves them blank rather than stopping the emails.
    try { WA_ARRIVAL = ((await sbGet("hbf_whatsapp_settings_v1")) || {}).arrival || {}; } catch (e) { WA_ARRIVAL = {}; }
    var primaryPropId = booking.propertyId || ((booking.stays || [])[0] || {}).propertyId;
    var property = properties.find(function(p) { return p.id === primaryPropId; });

    var templates = (await sbGet(TEMPLATES_KEY)) || DEFAULT_TEMPLATES;
    // The fixed links to the packs on the arrival emails, for {{arrivalPack}}
    // where a property has no link of its own (arrival-pack.js).
    WA_HOSTED = PACKS.hostedPacks(templates, process.env.HBF_ADMIN_TOKEN);
    try { WA_EVENTS = (await sbGet("hawthbush_bookings_v6")) || []; } catch (e) { WA_EVENTS = []; }
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
    var linkError = "";
    var minted = {};   // schedule label -> checkout session id made by this send
    async function linkFor(entry, label) {
      if (!entry || Number(entry.amount) <= 0) return "";
      if (entry.paid) { linkError = "The " + label + " is already marked as paid, so no payment link was created."; return ""; }
      try {
        var url = await createPaymentLink(booking, entry, label);
        if (url && entry.stripeId) minted[label] = entry.stripeId;
        return url;
      } catch (e) {
        linkError = "Stripe wouldn't create a payment link: " + (e.message || e);
        return "";
      }
    }

    if (emailType === "booking_confirmed" || emailType === "deposit_request") {
      var link = await linkFor(depositEntry, "Deposit");
      extra.paymentLink = link;
      extra.paymentLinkLine = link ? ("\n\nYou can pay your deposit securely here: " + link) : "";
      payLink = link; payLabel = "Pay deposit £" + Number(depositEntry.amount || 0).toFixed(2);
    }
    if (emailType === "balance_request") {
      var blink = await linkFor(balanceEntry, "Balance");
      extra.paymentLink = blink;
      extra.paymentLinkLine = blink ? ("\n\nYou can pay your balance securely here: " + blink) : "";
      payLink = blink; payLabel = "Pay balance £" + Number(balanceEntry.amount || 0).toFixed(2);
    }

    // Refuse to send a request for money that contains no way to pay. Silently
    // sending one is worse than not sending it — the guest gets a bill with a
    // dead end, and nobody finds out until they complain.
    if ((emailType === "deposit_request" || emailType === "balance_request") && !payLink) {
      return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        error: linkError || "No payment link could be created, so the email wasn't sent.",
        fn: FN_BUILD
      }) };
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
    // Only the attachments for this booking: those for everyone, and those
    // marked for its properties or its kind of event (31 Oct).
    var attachments = PACKS.attachmentsFor(tmpl, PACKS.packTags(booking, WA_EVENTS)).map(function(a) {
      var base64 = (a.dataUrl || "").split(",")[1] || "";
      return { filename: a.name, content: base64 };
    });

    var sendResult = await sendViaResend(booking.email, subject, bodyText, attachments, payLink, payLabel);
    if (!sendResult.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: sendResult.error }) };
    }

    // Mark the send flag + persist the new payment link's session id. The
    // array is re-read NOW, not reused from before the Stripe and Resend
    // round-trips: writing back that old copy would erase anything saved in
    // the meantime. Only this booking's two changes are applied to the fresh
    // copy, and a booking deleted meanwhile stays deleted.
    var fresh = (await sbGet(ACCOM_KEY)) || [];
    var merged = applyEmailSent(fresh, booking.id, emailType, minted);
    if (merged) await sbSet(ACCOM_KEY, merged);
    else console.warn("send-accom-email: booking " + booking.id + " vanished before its flag could be saved");

    await logEmail(subject, booking.email, emailType, booking.id, bodyText);

    return { statusCode: 200, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, fn: FN_BUILD, paymentLink: payLink || null }) };

  } catch (err) {
    console.error("send-accom-email error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// Apply one send's changes to a freshly read bookings array. Returns the new
// array, or null if the booking is no longer there (never resurrect it).
// stripeIds: { "<schedule label>": "<checkout session id>" } for a link minted
// by this send; only an unpaid entry takes it.
function applyEmailSent(bookings, bookingId, emailType, stripeIds) {
  var idx = (bookings || []).findIndex(function(b) { return b && String(b.id) === String(bookingId); });
  if (idx === -1) return null;
  var b = Object.assign({}, bookings[idx]);
  var flags = Object.assign({}, b.emailFlags || {});
  flags[emailType + "Sent"] = true;
  b.emailFlags = flags;
  if (stripeIds && Object.keys(stripeIds).length && Array.isArray(b.schedule)) {
    b.schedule = b.schedule.map(function(s) {
      if (s && stripeIds[s.label] && !s.paid) return Object.assign({}, s, { stripeId: stripeIds[s.label] });
      return s;
    });
  }
  var out = bookings.slice();
  out[idx] = b;
  return out;
}

exports._internals = { applyEmailSent, resolveStaff };
