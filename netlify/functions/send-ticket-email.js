// netlify/functions/send-ticket-email.js
// The box office's only email sender. Every box-office email — confirmations,
// deposit receipts, balance chases, waitlist releases, resends — is sent by
// POSTing to this function.
//
// The rest of this codebase copies _email-shell.js verbatim into each sending
// function, because Netlify functions can't share local modules. That
// convention is kept here in the sense that matters: the shell is not imported
// from anywhere. It simply isn't copied four more times, because the box
// office has exactly one sender and the others (stripe-ticket-webhook.js,
// box-billing.js, box-admin.js) call it over HTTP rather than each growing
// their own copy of the templates, the token list and the Outlook table markup.
//
// POST body:
//   { token, kind, orderId, payLink?, extra? }
//     token   — HBF_ADMIN_TOKEN. Not a public endpoint: it emails buyers.
//     kind    — booking_confirmed | table_reserved | balance_due |
//               balance_overdue | tickets_issued | event_reminder |
//               tickets_released | booking_cancelled
//     orderId — box_orders.id (not needed for tickets_released, which takes
//               { eventId, to, name } instead)
//
// Every send is guarded by a flag on box_orders.email_flags, so a Stripe retry
// or a second press of a button in the app can't send the same email twice.
//
// Required env vars: SUPABASE_SERVICE_KEY, HBF_ADMIN_TOKEN, RESEND_API_KEY

const SUPABASE_URL   = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SERVICE_KEY    = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_TOKEN    = process.env.HBF_ADMIN_TOKEN;
const RESEND_KEY     = process.env.RESEND_API_KEY;
const FROM_EMAIL     = "hello@hawthbushfarm.co.uk";
const SITE_ORIGIN    = "https://hawthbushfarm.netlify.app";
const TEMPLATES_KEY  = "hbf_box_templates_v1";
const EMAIL_LOG_KEY  = "hbf_email_log_v1";
const TICKET_TERMS_KEY = "hbf_ticket_terms_v1";

// House defaults. Mirrors DEFAULT_BOX_TEMPLATES in App.jsx — used only until
// Box Office → Settings has been saved once. triggerDays is the house timing;
// balance_due is overridden per event by box_events.balance_days.
const DEFAULT_TEMPLATES = [
  { id: "booking_confirmed", label: "Booking confirmed", triggerDays: null,
    subject: "Your tickets — {{eventName}} — {{orderRef}}",
    body: "Hello {{firstName}},\n\nThank you — your tickets for {{eventName}} are confirmed.\n\n{{eventDate}} at {{eventTime}}\n{{venue}}\n\nTickets: {{qty}}\nOrder reference: {{orderRef}}\nTotal paid: £{{totalAmount}}\n\nYour QR code is below. One code covers the whole booking — bring it on your phone or print it, and we'll scan it once for everyone arriving with you.\n\nYou can also open your tickets any time here: {{ticketsLink}}\n\nWe look forward to seeing you.\n\nHawthbush Farm" },

  { id: "table_reserved", label: "Table reserved (deposit paid)", triggerDays: null,
    subject: "Table reserved — {{eventName}} — {{orderRef}}",
    body: "Hello {{firstName}},\n\nThank you — we've received your deposit of £{{depositAmount}} and your table at {{eventName}} is reserved.\n\n{{eventDate}} at {{eventTime}}\n{{venue}}\n\nPlaces held: {{qty}}\nOrder reference: {{orderRef}}\nBalance outstanding: £{{balanceAmount}}, due by {{balanceDueDate}}\n\nWe'll email you nearer the time with a link to pay the balance — or you can pay it whenever suits you here: {{ticketsLink}}\n\nYour tickets are issued once the balance is settled.\n\nHawthbush Farm" },

  { id: "balance_due", label: "Balance due", triggerDays: 30,
    subject: "Balance due — {{eventName}} — {{orderRef}}",
    body: "Hello {{firstName}},\n\nThe balance for your booking at {{eventName}} is now due.\n\n{{eventDate}} at {{eventTime}}\n{{venue}}\n\nPlaces held: {{qty}}\nOrder reference: {{orderRef}}\nBalance outstanding: £{{balanceAmount}}\nDue by: {{balanceDueDate}}\n\nYou can pay securely here: {{payLink}}\n\nYour tickets are issued as soon as the balance clears.\n\nHawthbush Farm" },

  { id: "balance_overdue", label: "Balance overdue", triggerDays: 3,
    subject: "Your balance for {{eventName}} — {{orderRef}}",
    body: "Hello {{firstName}},\n\nWe haven't yet received the balance for your booking at {{eventName}}, which was due on {{balanceDueDate}}.\n\nBalance outstanding: £{{balanceAmount}}\nOrder reference: {{orderRef}}\n\nYou can pay here: {{payLink}}\n\nYour table is still held. If something has changed, or if there's a problem, do just reply to this email and we'll sort it out.\n\nHawthbush Farm" },

  { id: "tickets_issued", label: "Tickets issued (balance cleared)", triggerDays: null,
    subject: "Here are your tickets — {{eventName}} — {{orderRef}}",
    body: "Hello {{firstName}},\n\nThank you — your balance is settled and your tickets for {{eventName}} are attached below.\n\n{{eventDate}} at {{eventTime}}\n{{venue}}\n\nTickets: {{qty}}\nOrder reference: {{orderRef}}\n\nOne QR code covers the whole booking. Bring it on your phone or print it, and we'll scan it once for everyone with you.\n\nYou can open your tickets any time here: {{ticketsLink}}\n\nWe look forward to seeing you.\n\nHawthbush Farm" },

  { id: "event_reminder", label: "Event reminder", triggerDays: 2,
    subject: "{{eventName}} is on {{eventDate}}", 
    body: "Hello {{firstName}},\n\nJust a reminder that {{eventName}} is on {{eventDate}}.\n\nDoors and start: {{eventTime}}\n{{venue}}\n\nTickets: {{qty}}\nOrder reference: {{orderRef}}\n\nThere's plenty of parking in the field by the barn — follow the signs from the lane. Your QR code is below, and it's also here if you need it on the night: {{ticketsLink}}\n\nSee you soon.\n\nHawthbush Farm" },

  { id: "tickets_released", label: "Tickets released (waitlist)", triggerDays: null,
    subject: "Tickets released — {{eventName}}",
    body: "Hello {{firstName}},\n\nYou asked to be told if more tickets became available for {{eventName}} — some have just been released.\n\n{{eventDate}} at {{eventTime}}\n{{venue}}\n\nThey're first come, first served, so do book quickly: {{ticketsLink}}\n\nHawthbush Farm" },

  { id: "booking_cancelled", label: "Booking cancelled", triggerDays: null,
    subject: "Booking cancelled — {{eventName}} — {{orderRef}}",
    body: "Hello {{firstName}},\n\nYour booking for {{eventName}} ({{orderRef}}, {{qty}} tickets) has been cancelled and the tickets are no longer valid.\n\nAny refund due will be returned to the card you paid with and usually reaches your account within a few working days.\n\nIf this is a surprise, please reply to this email and we'll put it right.\n\nHawthbush Farm" },
];

// Which flag on box_orders.email_flags guards each kind.
const FLAG_FOR = {
  booking_confirmed: "bookingConfirmedSent",
  table_reserved:    "tableReservedSent",
  balance_due:       "balanceDueSent",
  balance_overdue:   "balanceOverdueSent",
  tickets_issued:    "ticketsIssuedSent",
  event_reminder:    "eventReminderSent",
  booking_cancelled: "bookingCancelledSent",
};

// Which emails carry the QR. A deposit-only booking never does — there is
// nothing to scan until the balance is paid.
const CARRIES_QR = { booking_confirmed: true, tickets_issued: true, event_reminder: true };

// ── Supabase helpers (service key, no header spread) ─────────────────────────
async function sbRest(path, opts) {
  var o = opts || {};
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    method: o.method || "GET",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json",
      "Prefer": o.prefer || "return=representation"
    },
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  var text = await res.text();
  if (!res.ok) throw new Error("supabase " + res.status + ": " + text);
  try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
}

async function sbGet(key) {
  var rows = await sbRest("app_data?key=eq." + key + "&select=value");
  return (rows && rows[0]) ? rows[0].value : null;
}

async function sbSet(key, value) {
  await sbRest("app_data", {
    method: "POST",
    prefer: "resolution=merge-duplicates",
    body: { key: key, value: value, updated_at: new Date().toISOString() }
  });
}

// ── Formatting ───────────────────────────────────────────────────────────────
// Everything is Europe/London, always. The server runs in UTC, so the zone is
// named explicitly rather than left to the machine.
function fmtDateLondon(ts) {
  if (!ts) return "";
  var d = new Date(ts);
  if (isNaN(d)) return "";
  return d.toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function fmtDateShort(ts) {
  if (!ts) return "";
  var d = new Date(String(ts).length <= 10 ? ts + "T12:00:00Z" : ts);
  if (isNaN(d)) return "";
  return d.toLocaleDateString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "long", year: "numeric" });
}

function fmtTimeLondon(ts) {
  if (!ts) return "";
  var d = new Date(ts);
  if (isNaN(d)) return "";
  return d.toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
}

function money(pence) { return (Math.round(Number(pence) || 0) / 100).toFixed(2); }

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

// ─── SHARED EMAIL SHELL ───────────────────────────────────────────────────────
// Matches _email-shell.js — the same warm palette as the website, Georgia and
// Helvetica rather than the Cormorant/Jost webfonts (which don't load reliably
// in mail clients), and deliberately table-based with inline styles because
// Outlook ignores <style> blocks and flexbox.
const BRAND = {
  logo:    "https://images.squarespace-cdn.com/content/v1/6897aa6fe61ae2143f465ab1/1754770036281-I54E64T6O6J1YLVL9KYF/logo.png?format=400w",
  site:    "https://www.hawthbushfarm.co.uk",
  bg:      "#f9f6f1",
  panel:   "#ffffff",
  text:    "#2d2a25",
  muted:   "#7a7060",
  border:  "#e8e2d9",
  accent:  "#b8a88a"
};

function bodyToHtml(bodyText) {
  var paras = String(bodyText || "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  return paras.map(function (p) {
    var safe = escapeHtml(p.trim());
    safe = safe.replace(/(https?:\/\/[^\s<]+)/g, function (url) {
      var label = url.length > 60 ? url.replace(/^https?:\/\//, "").split("/")[0] + "/…" : url;
      return '<a href="' + url + '" style="color:#2d2a25;text-decoration:underline">' + label + '</a>';
    });
    return '<p style="margin:0 0 15px;font-size:15px;line-height:1.65;color:' + BRAND.text + '">' + safe + '</p>';
  }).join("");
}

// The QR block. It is an ordinary hosted <img>, not a data: URI and not an
// attachment, and that is the whole reason ticket-qr.js exists: Gmail strips
// data: images and Resend attachments don't display inline reliably, whereas
// a PNG at a URL renders in every client anyone has tried.
function qrBlock(qrUrl, orderRef, ticketsLink) {
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:8px 0 4px">' +
    '<tr><td align="center" style="background:#ffffff;border:1px solid ' + BRAND.border + ';border-radius:14px;padding:22px 18px">' +
    '<img src="' + qrUrl + '" alt="Your ticket QR code" width="220" height="220" style="display:block;border:0;width:220px;height:220px;image-rendering:pixelated">' +
    '<p style="margin:14px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:19px;font-weight:bold;letter-spacing:2px;color:' + BRAND.text + '">' + escapeHtml(orderRef) + '</p>' +
    '<p style="margin:5px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:' + BRAND.muted + '">One code for the whole booking</p>' +
    (ticketsLink ? '<p style="margin:12px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:' + BRAND.muted + '">' +
      "Can't see the code? <a href=\"" + ticketsLink + '" style="color:' + BRAND.muted + '">Open your ticket online</a></p>' : "") +
    '</td></tr></table>';
}

// opts: { termsUrl, buttonLabel, buttonUrl, qrUrl, orderRef, ticketsLink }
function buildEmailHtml(bodyText, opts) {
  var o = opts || {};

  var payButton = "";
  if (o.buttonUrl) {
    payButton = '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0">' +
      '<tr><td align="center" bgcolor="' + BRAND.text + '" style="border-radius:8px">' +
      '<a href="' + o.buttonUrl + '" style="display:inline-block;padding:14px 34px;font-family:Helvetica,Arial,sans-serif;' +
      'font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px">' +
      escapeHtml(o.buttonLabel || "Pay now") + '</a></td></tr>' +
      '<tr><td align="center" style="padding-top:8px;font-family:Helvetica,Arial,sans-serif;font-size:11px;color:' + BRAND.muted + '">' +
      'Secure card payment powered by Stripe</td></tr></table>';
  }

  // The button replaces the raw URL where the wording introduces it, so the
  // sentence still leads into it and the sign-off stays at the bottom.
  var inner;
  if (o.buttonUrl && String(bodyText || "").indexOf(o.buttonUrl) !== -1) {
    var halves = String(bodyText).split(o.buttonUrl);
    var before = halves[0].replace(/[ \t]+$/, "").replace(/\n+$/, "");
    var after  = halves.slice(1).join(o.buttonUrl).replace(/^\n+/, "");
    inner = bodyToHtml(before) + payButton + bodyToHtml(after);
  } else {
    inner = bodyToHtml(bodyText) + payButton;
  }

  if (o.qrUrl) inner += qrBlock(o.qrUrl, o.orderRef || "", o.ticketsLink || "");

  var terms = "";
  if (o.termsUrl) {
    terms = '<p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:' + BRAND.muted + '">' +
      'Tickets are sold subject to our <a href="' + o.termsUrl + '" style="color:' + BRAND.muted + '">Terms &amp; Conditions</a>.' +
      '</p>';
  }

  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Hawthbush Farm</title></head>' +
    '<body style="margin:0;padding:0;background:' + BRAND.bg + ';">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + BRAND.bg + ';padding:26px 12px">' +
    '<tr><td align="center">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%">' +
    '<tr><td align="center" style="padding:0 0 20px">' +
    '<a href="' + BRAND.site + '"><img src="' + BRAND.logo + '" alt="Hawthbush Farm" width="110" ' +
    'style="display:block;border:0;width:110px;height:auto"></a>' +
    '</td></tr>' +
    '<tr><td style="background:' + BRAND.panel + ';border:1px solid ' + BRAND.border + ';border-radius:14px;padding:30px 34px;' +
    'font-family:Helvetica,Arial,sans-serif">' + inner + '</td></tr>' +
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

// Tickets have their own terms, and the email links to those or to nothing —
// never to the cottage terms, which cover something else entirely.
async function getTermsUrl() {
  try {
    var t = await sbGet(TICKET_TERMS_KEY);
    if (t && String(t.text || "").trim()) return SITE_ORIGIN + "/terms.html?tickets=1";
  } catch (e) { /* a missing T&C must never stop an email going out */ }
  return "";
}

async function logEmail(subject, to, type, orderRef, bodyText) {
  try {
    var log = (await sbGet(EMAIL_LOG_KEY)) || [];
    log.push({
      id: "el" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      sentAt: new Date().toISOString(), subject: subject, to: to,
      template: type, bookingId: orderRef, body: String(bodyText || "").slice(0, 8000)
    });
    await sbSet(EMAIL_LOG_KEY, log.slice(-500));
  } catch (e) { console.error("logEmail failed:", e.message); }
}

async function sendViaResend(to, subject, html) {
  if (!RESEND_KEY) return { ok: false, error: "RESEND_API_KEY not set" };
  if (!to) return { ok: false, error: "no recipient" };
  var res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_EMAIL, to: to, subject: subject, html: html })
  });
  if (!res.ok) return { ok: false, error: "Resend failed: " + await res.text() };
  return { ok: true };
}

function getTemplate(templates, id) {
  var list = (templates && templates.length) ? templates : DEFAULT_TEMPLATES;
  return list.find(function(t) { return t.id === id; })
      || DEFAULT_TEMPLATES.find(function(t) { return t.id === id; });
}

function buildTokens(order, ev, extra) {
  var tokens = {
    firstName:      order.first_name || "there",
    lastName:       order.last_name || "",
    eventName:      ev.name || "",
    eventDate:      fmtDateLondon(ev.starts_at),
    eventTime:      fmtTimeLondon(ev.starts_at),
    venue:          [ev.venue_name, ev.venue_postcode].filter(Boolean).join(", "),
    orderRef:       order.order_ref || "",
    qty:            order.total_qty || 0,
    totalAmount:    money(order.total_pence),
    depositAmount:  money(order.deposit_pence),
    balanceAmount:  money(order.balance_pence),
    balanceDueDate: fmtDateShort(order.balance_due_on),
    payLink:        "",
    ticketsLink:    SITE_ORIGIN + "/my-ticket/" + order.qr_token
  };
  return Object.assign(tokens, extra || {});
}

// ── Handler ──────────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  var body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  var token = body.token || event.headers["x-admin-token"];
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorised" }) };
  }

  var kind = body.kind;

  try {
    var templates = (await sbGet(TEMPLATES_KEY)) || DEFAULT_TEMPLATES;

    // The waitlist release is the one email with no order behind it — it goes
    // to a name and address on the waiting list, not to a booking.
    if (kind === "tickets_released") {
      var evRows = await sbRest("box_events?id=eq." + body.eventId + "&select=*");
      var wev = evRows && evRows[0];
      if (!wev) return { statusCode: 404, body: JSON.stringify({ error: "Event not found" }) };
      var wt = getTemplate(templates, "tickets_released");
      var wTokens = {
        firstName:   (body.name || "").split(" ")[0] || "there",
        eventName:   wev.name,
        eventDate:   fmtDateLondon(wev.starts_at),
        eventTime:   fmtTimeLondon(wev.starts_at),
        venue:       [wev.venue_name, wev.venue_postcode].filter(Boolean).join(", "),
        ticketsLink: SITE_ORIGIN + "/tickets/" + wev.slug + (wev.access_code ? "?code=" + encodeURIComponent(wev.access_code) : ""),
        qty: "", orderRef: "", totalAmount: "", depositAmount: "", balanceAmount: "", balanceDueDate: "", payLink: ""
      };
      var wSubject = fillTemplate(wt.subject, wTokens);
      var wBody    = fillTemplate(wt.body, wTokens);
      var wHtml    = buildEmailHtml(wBody, {
        termsUrl: await getTermsUrl(),
        buttonUrl: wTokens.ticketsLink,
        buttonLabel: "Book tickets"
      });
      var wRes = await sendViaResend(body.to, wSubject, wHtml);
      if (!wRes.ok) return { statusCode: 502, body: JSON.stringify({ error: wRes.error }) };
      await logEmail(wSubject, body.to, "tickets_released", "", wBody);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    var orders = await sbRest("box_orders?id=eq." + body.orderId + "&select=*");
    var order = orders && orders[0];
    if (!order) return { statusCode: 404, body: JSON.stringify({ error: "Order not found" }) };

    var events = await sbRest("box_events?id=eq." + order.event_id + "&select=*");
    var ev = events && events[0];
    if (!ev) return { statusCode: 404, body: JSON.stringify({ error: "Event not found" }) };

    if (!order.email) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, skipped: "no email address" }) };
    }

    // The guard. A Stripe retry, a double-clicked button in the app, or a
    // second daily run must not put the same email in someone's inbox twice.
    var flag = FLAG_FOR[kind];
    var flags = order.email_flags || {};
    if (flag && flags[flag] && !body.force) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "already sent" }) };
    }

    var tmpl = getTemplate(templates, kind);
    if (!tmpl) return { statusCode: 400, body: JSON.stringify({ error: "Unknown template: " + kind }) };

    var tokens = buildTokens(order, ev, { payLink: body.payLink || "" });
    var subject = fillTemplate(tmpl.subject, tokens);
    var text    = fillTemplate(tmpl.body, tokens);

    // The QR only ever goes out on a booking that is genuinely paid in full.
    // A deposit booking has tickets_issued_at null and gets no code at all.
    var qrUrl = "";
    if (CARRIES_QR[kind] && order.tickets_issued_at) {
      qrUrl = SITE_ORIGIN + "/.netlify/functions/ticket-qr?t=" + encodeURIComponent(order.qr_token);
    }

    var html = buildEmailHtml(text, {
      termsUrl: await getTermsUrl(),
      buttonUrl: body.payLink || "",
      buttonLabel: kind === "balance_overdue" || kind === "balance_due" ? "Pay the balance" : "Pay now",
      qrUrl: qrUrl,
      orderRef: order.order_ref,
      ticketsLink: tokens.ticketsLink
    });

    var sent = await sendViaResend(order.email, subject, html);
    if (!sent.ok) {
      console.error("send-ticket-email failed:", kind, sent.error);
      return { statusCode: 502, body: JSON.stringify({ error: sent.error }) };
    }

    await logEmail(subject, order.email, kind, order.order_ref, text);

    if (flag) {
      var nextFlags = Object.assign({}, flags);
      nextFlags[flag] = true;
      await sbRest("box_orders?id=eq." + order.id, {
        method: "PATCH", prefer: "return=minimal", body: { email_flags: nextFlags }
      });
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };

  } catch (err) {
    console.error("send-ticket-email error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
