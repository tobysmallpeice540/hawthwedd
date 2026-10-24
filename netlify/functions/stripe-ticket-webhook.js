// netlify/functions/stripe-ticket-webhook.js
// Payment confirmed → issue the tickets and send the email.
//
// This is deliberately its own endpoint with its own signing secret, separate
// from stripe-accom-webhook.js, so a cottage booking's metadata can never be
// mistaken for a ticket order or the other way round. Add it in Stripe as a
// SECOND webhook endpoint:
//   https://hawthbushfarm.netlify.app/.netlify/functions/stripe-ticket-webhook
// listening for: checkout.session.completed, checkout.session.expired and
// charge.refunded (a refund of money behind the bar records itself),
// signing secret in STRIPE_TICKET_WEBHOOK_SECRET.
//
// Chef-run events need a THIRD endpoint at the SAME URL, created as a Connect
// endpoint ("Events on connected accounts"), listening for ALL FOUR of:
//   checkout.session.completed   — a chef ticket is paid
//   checkout.session.expired     — an abandoned chef checkout frees its seats
//   account.updated              — a chef's Stripe setup is approved
//   charge.refunded              — a chef refund, so the commission goes back
// signing secret in STRIPE_TICKET_CONNECT_WEBHOOK_SECRET. Missing
// charge.refunded means a refund made in the chef's own dashboard never
// returns Hawthbush's commission and never voids the tickets.
//
// Three payment flows land here, told apart by session.metadata.bookingType
// ("bar_tab", money behind the bar from bar-checkout.js, is handled near the
// bottom of this file):
//   "box_ticket"  — a new order from create-ticket-checkout.js. Either paid in
//                   full (tickets issued, QR sent) or a deposit (table
//                   reserved, deliberately no QR).
//   "box_balance" — an outstanding balance settled through pay-balance.js.
//                   Clearing it is what issues the tickets.
//
// Required env vars:
//   STRIPE_TICKET_SECRET_KEY · STRIPE_TICKET_WEBHOOK_SECRET · SUPABASE_SERVICE_KEY
//   HBF_ADMIN_TOKEN (to call send-ticket-email.js)

// Ticketing runs on its OWN Stripe account, separate from the cottage bookings.
// That is a bookkeeping decision, not a technical one: Stripe settles as a
// single lump sum per account, so sharing one would put ticket income and
// letting income in the same bank deposit with no way to split them afterwards.
// Two accounts means two payout streams and a clean reconciliation.
//
// Deliberately NO fallback to STRIPE_SECRET_KEY. If this variable is missing the
// function fails loudly at load, which is right — falling back would quietly
// take ticket money into the lettings account and undo the whole point.
//
// The API version is pinned deliberately, and should stay pinned.
//
// This Stripe account dates from 2018 and its default version was 2018-11-08,
// which predates price_data, discounts, expires_at and mode:"payment" on
// Checkout — every session this code creates would have been rejected. Pinning
// fixes that here rather than depending on an account-wide setting, so a
// future change to the account default cannot silently alter what these
// functions send.
//
// 2024-06-20 is the version stripe-node 16.x is generated against, so the
// library and the API agree. If the library is upgraded, move this with it.
//
// The Stripe ACCOUNT is on a newer version (2026-07-29.dahlia), so webhook
// payloads arrive newer than the version used to make calls. That mismatch is
// intentional and safe — Stripe supports it, and this webhook reads only
// session.id and session.metadata, which are stable across every version.
// Do not "fix" it by bumping this string alone: the pinned version must match
// the installed stripe package, and that package is shared with the cottage
// booking functions, which are live.
const stripe = require("stripe")(process.env.STRIPE_TICKET_SECRET_KEY, {
  apiVersion: "2024-06-20"
});

const SUPABASE_URL   = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SERVICE_KEY    = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_TOKEN    = process.env.HBF_ADMIN_TOKEN;
const SITE_ORIGIN    = "https://hawthbushfarm.netlify.app";

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

// The single sender. Failing to email is bad but recording the payment is
// what actually matters, so a failure here is logged and swallowed.
async function sendEmail(kind, orderId, extra) {
  try {
    var res = await fetch(SITE_ORIGIN + "/.netlify/functions/send-ticket-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ token: ADMIN_TOKEN, kind: kind, orderId: orderId }, extra || {}))
    });
    if (!res.ok) console.error("send-ticket-email " + kind + " failed:", await res.text());
  } catch (e) {
    console.error("send-ticket-email " + kind + " threw:", e.message);
  }
}

// A payment can land after the 15-minute hold has lapsed and the seats have
// gone to someone else. The money is real, so the booking stands — but it is
// flagged loudly rather than silently oversold, and it shows in the app as a
// red warning on the event.
async function flagIfOversold(order) {
  try {
    var evRows = await sbRest("box_events?id=eq." + order.event_id + "&select=capacity,name");
    var ev = evRows && evRows[0];
    if (!ev || !ev.capacity) return;
    var sold = await sbRest("rpc/box_sold_total", { method: "POST", body: { p_event_id: order.event_id } });
    if (Number(sold) > Number(ev.capacity)) {
      var note = (order.notes ? order.notes + "\n" : "") +
        "⚠ OVERSOLD: this payment landed after the hold lapsed — " + sold + " sold against a capacity of " + ev.capacity + ".";
      await sbRest("box_orders?id=eq." + order.id, {
        method: "PATCH", prefer: "return=minimal", body: { notes: note }
      });
      console.error("OVERSOLD on " + ev.name + ": " + sold + "/" + ev.capacity + " (order " + order.order_ref + ")");
    }
  } catch (e) { console.error("oversold check failed:", e.message); }
}

// ── Refunds on a chef's account ──────────────────────────────────────────────
// Either side may refund a chef order: Hawthbush from the app (box-admin.js
// orders.refund), or the chef from their own Stripe dashboard. Whichever it
// was, Stripe reports it here, and two things follow.
//
// 1. Hawthbush's commission goes back. Toby's rule: a refunded ticket earns no
//    commission. A refund made from the app already returns the fee
//    (refund_application_fee), but Stripe does NOT return it when the chef
//    refunds from their dashboard — so the shortfall is worked out here and
//    refunded. Worked out, not assumed: what should have come back
//    (proportional to how much of the charge has been refunded) minus what
//    already has. That makes a retry, or an app refund arriving here too,
//    simply find nothing left to do.
//
// 2. A fully refunded booking stops being a booking: tickets void, stock back,
//    and the buyer told — unless the app already did all that.
async function findOrderForCharge(charge, account) {
  var pi = typeof charge.payment_intent === "string" ? charge.payment_intent
    : (charge.payment_intent && charge.payment_intent.id);
  if (pi) {
    var byPi = await sbRest("box_orders?stripe_payment_intent_id=eq." + encodeURIComponent(pi) + "&select=*");
    if (byPi && byPi[0]) return byPi[0];
    // The payment intent is only stored once checkout.session.completed has
    // been processed. Fall back to asking Stripe which session it came from.
    try {
      var sessions = await stripe.checkout.sessions.list({ payment_intent: pi, limit: 1 }, { stripeAccount: account });
      var s = sessions && sessions.data && sessions.data[0];
      if (s) {
        var bySession = await sbRest("box_orders?stripe_session_id=eq." + encodeURIComponent(s.id) + "&select=*");
        if (bySession && bySession[0]) return bySession[0];
      }
    } catch (e) { console.error("session lookup for refund failed:", e.message); }
  }
  return null;
}

async function handleChefRefund(charge, account) {
  // 1. The commission.
  var feeId = typeof charge.application_fee === "string" ? charge.application_fee
    : (charge.application_fee && charge.application_fee.id);
  if (feeId && charge.amount > 0) {
    // Application fees live on Hawthbush's own account — no stripeAccount here.
    var fee = await stripe.applicationFees.retrieve(feeId);
    var shouldBeBack = charge.refunded
      ? fee.amount
      : Math.floor(fee.amount * (charge.amount_refunded || 0) / charge.amount);
    // Known limit: two PARTIAL refunds processed at the same instant could each
    // read the same amount_refunded and together return slightly more than
    // the proportional share. Full refunds — the normal case — cannot, because
    // the target is the whole fee and the key below is the same every time.
    var owed = shouldBeBack - (fee.amount_refunded || 0);
    if (owed > 0) {
      await stripe.applicationFees.createRefund(feeId, {
        amount: owed,
        metadata: { reason: "ticket refunded", charge: charge.id }
      }, { idempotencyKey: "hbf-fee-refund-" + charge.id + "-" + (charge.refunded ? "full" : (charge.amount_refunded || 0)) });
      console.log("Returned £" + (owed / 100).toFixed(2) + " commission on " + charge.id);
    }
  }

  // 2. The booking.
  var order = await findOrderForCharge(charge, account);
  if (!order) {
    console.warn("charge.refunded on " + account + " with no matching box order:", charge.id);
    return;
  }
  if (order.stripe_account_id !== account) {
    console.error("charge.refunded account mismatch for " + order.order_ref);
    return;
  }

  var refundedSoFar = "£" + ((charge.amount_refunded || 0) / 100).toFixed(2);
  if (!charge.refunded) {
    // A partial refund — a goodwill gesture, say. The booking stands.
    if ((order.notes || "").indexOf("Partly refunded " + refundedSoFar) === -1) {
      await sbRest("box_orders?id=eq." + order.id, {
        method: "PATCH", prefer: "return=minimal",
        body: { notes: (order.notes ? order.notes + "\n" : "") + "Partly refunded " + refundedSoFar + " in Stripe on " + new Date().toISOString().slice(0, 10) }
      });
    }
    return;
  }

  if (order.status === "refunded" || order.status === "cancelled") return;   // the app already handled it

  await sbRest("box_orders?id=eq." + order.id, {
    method: "PATCH", prefer: "return=minimal",
    body: {
      status: "refunded",
      tickets_issued_at: null,
      notes: (order.notes ? order.notes + "\n" : "") + "Refunded in full (" + refundedSoFar + ") from the seller's Stripe account on " +
        new Date().toISOString().slice(0, 10) + " — tickets voided, commission returned."
    }
  });
  if (order.email) await sendEmail("booking_cancelled", order.id);
}

// ── Handler ──────────────────────────────────────────────────────────────────
// ── Money behind the bar (bookingType "bar_tab", from bar-checkout.js) ───────
//
// Always on Hawthbush's own ticketing account, never a chef's. The database
// checks the session and the amount against the pending row before anything
// is marked paid, and says whether this is the first delivery, so a retried
// webhook never emails anyone twice.
const RESEND_KEY    = process.env.RESEND_API_KEY;
const FROM_EMAIL    = "hello@hawthbushfarm.co.uk";
const FROM_HEADER   = "Hawthbush Farm <" + FROM_EMAIL + ">";
const OFFICE_EMAIL  = "hello@hawthbushfarm.co.uk";
const EMAIL_LOG_KEY = "hbf_email_log_v1";

async function sbRpcService(fn, args) {
  var res = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + fn, {
    method: "POST",
    headers: { "apikey": SERVICE_KEY, "Authorization": "Bearer " + SERVICE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(args || {})
  });
  var text = await res.text();
  if (!res.ok) throw new Error(fn + " " + res.status + ": " + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}

function barMoney(v) {
  return "£" + Number(v).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function barDate(iso) {
  var d = iso ? new Date(iso) : new Date();
  return d.toLocaleDateString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "long", year: "numeric" });
}
function barEsc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function barEmailHtml(paragraphs) {
  return '<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f9f6f1;font-family:Helvetica,Arial,sans-serif;color:#2d2a25">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">' +
    '<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">' +
    '<tr><td align="center" style="padding:0 0 18px"><img src="' + SITE_ORIGIN + '/email-logo.png" alt="Hawthbush Farm" width="100" style="display:block;width:100px;height:auto"></td></tr>' +
    '<tr><td style="background:#fff;border:1px solid #e8e2d9;border-radius:14px;padding:28px 30px;font-size:15px;line-height:1.6">' +
    paragraphs.map(function (p) { return '<p style="margin:0 0 14px">' + p + "</p>"; }).join("") +
    "</td></tr>" +
    '<tr><td align="center" style="padding:16px;font-size:12px;color:#7a7060">Hawthbush Farm &middot; <a href="mailto:' + FROM_EMAIL + '" style="color:#7a7060">' + FROM_EMAIL + "</a></td></tr>" +
    "</table></td></tr></table></body></html>";
}

async function barSend(to, subject, paragraphs, eventId) {
  if (!RESEND_KEY) { console.error("bar email not sent — RESEND_API_KEY missing:", subject); return false; }
  try {
    var res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_HEADER, to: to, subject: subject, html: barEmailHtml(paragraphs) })
    });
    if (!res.ok) { console.error("bar email failed:", subject, (await res.text()).slice(0, 300)); return false; }
  } catch (e) { console.error("bar email threw:", subject, e.message); return false; }
  // Into Recent Automated Emails with everything else. Re-reads first: a
  // shared array written back from a stale copy is how records get lost.
  try {
    var rows = await sbRest("app_data?key=eq." + EMAIL_LOG_KEY + "&select=value");
    var log = (rows && rows[0] && rows[0].value) || [];
    log.push({ id: "el" + Date.now() + "-" + Math.random().toString(36).slice(2, 6), sentAt: new Date().toISOString(),
               subject: subject, to: Array.isArray(to) ? to.join(", ") : to, template: "bar_payment",
               bookingId: String(eventId || ""), body: paragraphs.join("\n").replace(/<[^>]+>/g, "").slice(0, 4000) });
    await sbRest("app_data", { method: "POST", prefer: "resolution=merge-duplicates",
      body: { key: EMAIL_LOG_KEY, value: log.slice(-500), updated_at: new Date().toISOString() } });
  } catch (e) { console.error("bar email log failed:", e.message); }
  return true;
}

const BAR_RECEIPT_STD = {
  subject: "We've received {amount} behind your bar",
  body: "Thank you — we received {amount} to go behind the bar on {date}.\n\n" +
        "That makes {total} behind the bar for {event} ({eventDate}).\n\n" +
        "When the tab runs out the bar goes back to pay as you go, and anything left over is refunded to the card it came from after the event.\n\n" +
        "You can see this on the Evening bar page of your planner at any time."
};
async function barReceiptTemplate() {
  try {
    var rows = await sbRest("app_data?key=eq.hbf_portal_email_templates_v1&select=value");
    var list = (rows && rows[0] && rows[0].value) || [];
    var t = list.find(function (x) { return x && x.id === "bar_receipt"; }) || {};
    return { subject: String(t.subject || "").trim() || BAR_RECEIPT_STD.subject,
             body: String(t.body || "").trim() || BAR_RECEIPT_STD.body };
  } catch (e) { console.warn("bar receipt template unreadable, using the standard wording: " + e.message); return BAR_RECEIPT_STD; }
}

async function handleBarTab(stripeEvent) {
  var session = stripeEvent.data.object;

  if (stripeEvent.type === "checkout.session.expired") {
    await sbRpcService("wp_bar_payment_expired", { p_session: session.id });
    return;
  }
  if (stripeEvent.type !== "checkout.session.completed") return;
  if (session.payment_status !== "paid") {
    // Cards settle at once. Anything slower would need the async-payment
    // events, which this endpoint does not listen for — so say so.
    console.error("bar session " + session.id + " completed but not paid (" + session.payment_status + ") — not recorded");
    return;
  }

  var amount = Number(session.amount_total) / 100;
  var payer = (session.customer_details && session.customer_details.email) || session.customer_email || "";
  var r = await sbRpcService("wp_bar_payment_paid", {
    p_session: session.id, p_amount_total: amount,
    p_payment_intent: typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent && session.payment_intent.id) || null,
    p_email: payer
  });

  if (!r || r.ok === false) {
    // Money has arrived that we could not match. Tell the office rather than
    // let it sit unnoticed in Stripe.
    var why = (r && r.error) || "no reply";
    console.error("bar payment for session " + session.id + " not recorded: " + why, JSON.stringify(r));
    await barSend(OFFICE_EMAIL, "Bar payment received but not matched — please check Stripe", [
      "A payment of <strong>" + barMoney(amount) + "</strong> behind the bar arrived in Stripe (ticketing account) " +
      "but could not be matched to a booking (" + barEsc(why) + ").",
      "Stripe reference: " + barEsc(session.id) + (session.client_reference_id ? " · " + barEsc(session.client_reference_id) : "") +
      (payer ? " · paid by " + barEsc(payer) : ""),
      "Nothing has been recorded against an event. Check it in Stripe and record it on the event by hand if it belongs to one."
    ], null);
    return;
  }
  if (!r.first_time) return;   // a retried delivery: already recorded and emailed

  var when = barDate(r.paid_at);
  var name = r.couple || "your event";
  var to = [];
  (r.client_emails || []).concat(r.payer_email ? [r.payer_email] : []).forEach(function (e) {
    e = String(e || "").trim().toLowerCase();
    if (e && to.indexOf(e) < 0) to.push(e);
  });

  if (to.length) {
    // Wording from Settings → Email templates → Client portal, if changed there.
    var tpl = await barReceiptTemplate();
    var fill = function (text, html) {
      var vals = { "{amount}": barMoney(r.amount), "{total}": barMoney(r.total), "{date}": when,
                   "{event}": name, "{eventDate}": r.event_date ? barDate(r.event_date + "T12:00:00Z") : "the day" };
      var out = html ? barEsc(text) : String(text);
      Object.keys(vals).forEach(function (k) {
        var v = html ? barEsc(vals[k]) : vals[k];
        if (html && (k === "{amount}" || k === "{total}")) v = "<strong>" + v + "</strong>";
        out = out.split(k).join(v);
      });
      return out;
    };
    var paras = tpl.body.split(/\n\s*\n/).map(function (p) { return fill(p.trim(), true).replace(/\n/g, "<br>"); }).filter(Boolean);
    await barSend(to, fill(tpl.subject, false), paras, r.event_id);
  }
  await barSend(OFFICE_EMAIL, "Bar money received: " + barMoney(r.amount) + " — " + name, [
    "<strong>" + barMoney(r.amount) + "</strong> was paid behind the bar for <strong>" + barEsc(name) + "</strong>" +
    (r.event_date ? " (" + barEsc(barDate(r.event_date + "T12:00:00Z")) + ")" : "") + " on " + when + ".",
    "Total behind the bar now: <strong>" + barMoney(r.total) + "</strong>." + (r.payer_email ? " Paid by " + barEsc(r.payer_email) + "." : ""),
    "Already recorded on the event — nothing to do. Stripe reference " + barEsc(session.id) + "."
  ], r.event_id);
}

// ── A refund of money behind the bar ────────────────────────────────────────
// Staff refund in the Stripe dashboard; nothing is typed into the app. Stripe
// sends charge.refunded with the charge's CUMULATIVE amount refunded, and the
// database records that figure against the bar payment with the same payment
// intent — so a retried delivery, or a second partial refund, is worked out
// rather than added twice. A charge that is not a bar payment (a ticket
// refund on Hawthbush's own account) is not_found and left alone here.
const BAR_REFUND_STD = {
  subject: "We've refunded {refund} of your bar money",
  body: "We have refunded {refund} of the money behind the bar to the card it came from, on {date}. " +
        "Refunds usually reach the card within 5 to 10 working days.\n\n" +
        "That leaves {total} behind the bar for {event} ({eventDate}).\n\n" +
        "You can see this on the Evening bar page of your planner at any time."
};
async function barRefundTemplate() {
  try {
    var rows = await sbRest("app_data?key=eq.hbf_portal_email_templates_v1&select=value");
    var list = (rows && rows[0] && rows[0].value) || [];
    var t = list.find(function (x) { return x && x.id === "bar_refund"; }) || {};
    return { subject: String(t.subject || "").trim() || BAR_REFUND_STD.subject,
             body: String(t.body || "").trim() || BAR_REFUND_STD.body };
  } catch (e) { console.warn("bar refund template unreadable, using the standard wording: " + e.message); return BAR_REFUND_STD; }
}

async function handleBarRefund(charge) {
  var pi = typeof charge.payment_intent === "string" ? charge.payment_intent : (charge.payment_intent && charge.payment_intent.id) || null;
  if (!pi) return;
  var r = await sbRpcService("wp_bar_payment_refunded", {
    p_payment_intent: pi, p_refunded_total: Number(charge.amount_refunded || 0) / 100
  });
  if (!r || r.ok === false) {
    if (r && r.error === "not_found") return;   // not money behind the bar
    throw new Error("wp_bar_payment_refunded: " + JSON.stringify(r));
  }
  if (!r.changed) return;   // already recorded and emailed

  var when = barDate();
  var name = r.couple || "your event";
  var eventDate = r.event_date ? barDate(r.event_date + "T12:00:00Z") : "the day";
  var to = [];
  (r.client_emails || []).concat(r.payer_email ? [r.payer_email] : []).forEach(function (e) {
    e = String(e || "").trim().toLowerCase();
    if (e && to.indexOf(e) < 0) to.push(e);
  });

  // A correction that lowers the refund (rare: Stripe reports a smaller
  // cumulative figure) is the office's business, not the client's.
  if (to.length && Number(r.refund) > 0) {
    var tpl = await barRefundTemplate();
    var vals = { "{refund}": barMoney(r.refund), "{amount}": barMoney(r.refund), "{total}": barMoney(r.total),
                 "{date}": when, "{event}": name, "{eventDate}": eventDate };
    var fill = function (text, html) {
      var out = html ? barEsc(text) : String(text);
      Object.keys(vals).forEach(function (k) {
        var v = html ? barEsc(vals[k]) : vals[k];
        if (html && (k === "{refund}" || k === "{amount}" || k === "{total}")) v = "<strong>" + v + "</strong>";
        out = out.split(k).join(v);
      });
      return out;
    };
    var paras = tpl.body.split(/\n\s*\n/).map(function (p) { return fill(p.trim(), true).replace(/\n/g, "<br>"); }).filter(Boolean);
    await barSend(to, fill(tpl.subject, false), paras, r.event_id);
  }
  await barSend(OFFICE_EMAIL, "Bar money refunded: " + barMoney(Math.abs(r.refund)) + " — " + name, [
    (Number(r.refund) > 0
      ? "<strong>" + barMoney(r.refund) + "</strong> of the money behind the bar was refunded"
      : "The refund recorded against the money behind the bar was corrected by " + barMoney(Math.abs(r.refund))) +
    " for <strong>" + barEsc(name) + "</strong> (" + barEsc(eventDate) + ") on " + when + ".",
    "That payment: " + barMoney(r.paid) + " paid, " + barMoney(r.refunded_total) + " refunded in all. " +
    "Total behind the bar now: <strong>" + barMoney(r.total) + "</strong>.",
    "Already recorded on the event — nothing to do. Stripe reference " + barEsc(charge.id) + "."
  ], r.event_id);
}

// A balance payment for an order that is no longer live. Noted on the order
// (keyed by the session, so a retried delivery adds nothing and emails nobody
// twice) and the office is told.
async function recordStrayBalance(order, session) {
  var tag = "[stray balance " + session.id + "]";
  if ((order.notes || "").indexOf(tag) !== -1) return;
  var amount = "£" + ((session.amount_total || 0) / 100).toFixed(2);
  await sbRest("box_orders?id=eq." + order.id, {
    method: "PATCH", prefer: "return=minimal",
    body: { notes: (order.notes ? order.notes + "\n" : "") + tag + " " + amount + " balance paid in Stripe on " +
      new Date().toISOString().slice(0, 10) + " after the order was " + order.status + ". Not applied — refund or reinstate by hand." }
  });
  if (!RESEND_KEY) { console.error("office alert not sent — RESEND_API_KEY missing: stray balance on " + order.order_ref); return; }
  try {
    var res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_HEADER, to: OFFICE_EMAIL,
        subject: "Balance paid on a " + order.status + " box office order " + (order.order_ref || "") + " — please check",
        html: barEmailHtml([
          "A balance payment of <strong>" + barEsc(amount) + "</strong> came through Stripe for box office order <strong>" +
            barEsc(order.order_ref || order.id) + "</strong>, which is marked <strong>" + barEsc(order.status) + "</strong>.",
          "It has <strong>not</strong> been marked paid and no tickets have been issued. It is noted on the order.",
          "Buyer: " + barEsc(((order.first_name || "") + " " + (order.last_name || "")).trim()) + " " + barEsc(order.email || "") + "<br>Checkout session: " + barEsc(session.id),
          "Refund it in Stripe, or reinstate the order in the app."
        ]) })
    });
    if (!res.ok) console.error("office alert failed:", (await res.text()).slice(0, 300));
  } catch (e) { console.error("office alert threw:", e.message); }
}

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const sig = event.headers["stripe-signature"];

  // Two Stripe endpoints point at this one URL, each with its own signing
  // secret:
  //   STRIPE_TICKET_WEBHOOK_SECRET          events on Hawthbush's own ticketing
  //                                         account (the original endpoint)
  //   STRIPE_TICKET_CONNECT_WEBHOOK_SECRET  events on CONNECTED accounts — the
  //                                         chefs. Their payments happen on
  //                                         their accounts, so Stripe only ever
  //                                         reports them to a Connect endpoint.
  // A genuine event verifies against exactly one of them. Which one tells us
  // where the money is, and that is checked against the order below.
  let stripeEvent = null;
  let viaConnect = false;
  const secrets = [
    { secret: process.env.STRIPE_TICKET_WEBHOOK_SECRET, connect: false },
    { secret: process.env.STRIPE_TICKET_CONNECT_WEBHOOK_SECRET, connect: true }
  ];
  for (var si = 0; si < secrets.length && !stripeEvent; si++) {
    if (!secrets[si].secret) continue;
    try {
      stripeEvent = stripe.webhooks.constructEvent(event.body, sig, secrets[si].secret);
      viaConnect = secrets[si].connect;
    } catch (err) { /* try the next secret */ }
  }
  if (!stripeEvent) {
    console.error("Webhook signature verification failed against every configured secret");
    return { statusCode: 400, body: "Webhook signature verification failed" };
  }

  // Set by Stripe on every event that happened on a connected account.
  const connectedAccount = stripeEvent.account || null;
  if (viaConnect !== !!connectedAccount) {
    // A Connect-signed event without an account, or the reverse, is not
    // something Stripe sends. Refuse rather than guess where the money is.
    console.error("Webhook endpoint/account mismatch:", stripeEvent.type, stripeEvent.id);
    return { statusCode: 400, body: "Unexpected event for this endpoint" };
  }

  try {
    // ── A chef's Stripe account has changed state ───────────────────────────
    // Keeps "Ready for payments" in the app true without anyone pressing
    // Check Stripe status.
    if (stripeEvent.type === "account.updated" && connectedAccount) {
      var acct = stripeEvent.data.object;
      await sbRest("box_payees?stripe_account_id=eq." + encodeURIComponent(acct.id), {
        method: "PATCH", prefer: "return=minimal",
        body: { charges_enabled: !!acct.charges_enabled, details_submitted: !!acct.details_submitted }
      });
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }

    // ── A refund on a chef's account ────────────────────────────────────────
    if (stripeEvent.type === "charge.refunded" && connectedAccount) {
      await handleChefRefund(stripeEvent.data.object, connectedAccount);
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }

    // ── A refund on Hawthbush's own ticketing account ───────────────────────
    // Only money behind the bar is acted on. Whatever it was, it stops here:
    // a charge is not a checkout session and must never reach the code below.
    if (stripeEvent.type === "charge.refunded") {
      await handleBarRefund(stripeEvent.data.object);
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }
  } catch (err) {
    console.error("stripe-ticket-webhook error:", stripeEvent.type, err);
    return { statusCode: 500, body: "Internal error — Stripe will retry" };
  }

  const session  = stripeEvent.data.object;
  const metaType = (session.metadata && session.metadata.bookingType) || "";

  if (metaType === "bar_tab") {
    if (connectedAccount) return { statusCode: 200, body: JSON.stringify({ received: true, note: "bar money is never on a chef account" }) };
    try {
      await handleBarTab(stripeEvent);
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    } catch (err) {
      console.error("bar_tab webhook error:", stripeEvent.type, err);
      return { statusCode: 500, body: "Internal error — Stripe will retry" };
    }
  }

  if (metaType !== "box_ticket" && metaType !== "box_balance") {
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  }

  try {
    // ── An abandoned checkout: let the seats go straight away ───────────────
    if (stripeEvent.type === "checkout.session.expired") {
      var expId = session.metadata && session.metadata.orderId;
      // On a chef's account the metadata is not proof of anything: a chef has
      // their own API keys and could make a session carrying any order id. So
      // only the exact session we created for that order may release it.
      if (connectedAccount && metaType === "box_ticket" && expId) {
        var expRows = await sbRest("box_orders?id=eq." + expId + "&select=stripe_session_id,stripe_account_id");
        var expOrd = expRows && expRows[0];
        if (!expOrd || expOrd.stripe_session_id !== session.id || expOrd.stripe_account_id !== connectedAccount) {
          return { statusCode: 200, body: JSON.stringify({ received: true, warning: "Session does not match order" }) };
        }
      }
      if (metaType === "box_ticket" && expId) {
        await sbRest("box_orders?id=eq." + expId + "&status=eq.pending", {
          method: "DELETE", prefer: "return=minimal"
        });
      }
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }

    if (stripeEvent.type !== "checkout.session.completed") {
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }

    var orderId = session.metadata && session.metadata.orderId;
    var rows = orderId
      ? await sbRest("box_orders?id=eq." + orderId + "&select=*")
      : await sbRest("box_orders?stripe_session_id=eq." + encodeURIComponent(session.id) + "&select=*");
    var order = rows && rows[0];

    if (!order) {
      console.warn("No box order found for Stripe session:", session.id, metaType);
      return { statusCode: 200, body: JSON.stringify({ received: true, warning: "Order not found" }) };
    }

    // The money must have landed where the order says it should. A chef order
    // is paid on that chef's account; a Hawthbush order on Hawthbush's. If they
    // disagree, record nothing and shout — this is never a normal state.
    if ((order.stripe_account_id || null) !== connectedAccount) {
      console.error("Payment account mismatch for " + order.order_ref + ": order expects " +
        (order.stripe_account_id || "Hawthbush's account") + ", event came from " + (connectedAccount || "Hawthbush's account"));
      return { statusCode: 200, body: JSON.stringify({ received: true, warning: "Account mismatch — not recorded" }) };
    }
    // Same reasoning as for an expired session: on a chef's account only the
    // session this app created for the order can confirm it.
    if (connectedAccount && order.stripe_session_id !== session.id) {
      console.error("Chef session " + session.id + " does not match order " + order.order_ref + " — not recorded");
      return { statusCode: 200, body: JSON.stringify({ received: true, warning: "Session does not match order" }) };
    }

    var nowIso = new Date().toISOString();

    if (metaType === "box_balance") {
      // Already settled — a Stripe retry, not a second payment.
      if (order.balance_paid_at) {
        return { statusCode: 200, body: JSON.stringify({ received: true, note: "balance already paid" }) };
      }
      // A balance paid on an order that has since been cancelled or refunded
      // must not bring it back: no "paid", no tickets. The money is real, so
      // it is written into the order's notes (once per session) and the
      // office is told to refund or reinstate by hand.
      if (order.status === "cancelled" || order.status === "refunded") {
        await recordStrayBalance(order, session);
        return { statusCode: 200, body: JSON.stringify({ received: true, note: "order " + order.status + " — balance recorded, office told" }) };
      }
      // Conditional on the state just read, so a cancellation (or another
      // delivery) landing in between makes this change nothing.
      var balRows = await sbRest("box_orders?id=eq." + order.id +
          "&balance_paid_at=is.null&status=not.in.(cancelled,refunded)", {
        method: "PATCH", prefer: "return=representation",
        body: {
          status: "paid",
          balance_paid_at: nowIso,
          balance_pence: 0,
          tickets_issued_at: order.tickets_issued_at || nowIso
        }
      });
      if (!Array.isArray(balRows) || !balRows.length) {
        // Re-read to tell "another delivery got there first" from "it was
        // cancelled in the meantime" — only the second needs a human.
        var nowRows = await sbRest("box_orders?id=eq." + order.id + "&select=*");
        var nowOrd = nowRows && nowRows[0];
        if (nowOrd && (nowOrd.status === "cancelled" || nowOrd.status === "refunded") && !nowOrd.balance_paid_at) {
          await recordStrayBalance(nowOrd, session);
        }
        return { statusCode: 200, body: JSON.stringify({ received: true, note: "balance not applied — order changed" }) };
      }
      // The balance clearing is exactly what issues the tickets, so the QR
      // goes out now and not before.
      await sendEmail("tickets_issued", order.id);
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }

    // ── A new order ─────────────────────────────────────────────────────────
    if (order.status === "paid" || order.status === "deposit_paid") {
      return { statusCode: 200, body: JSON.stringify({ received: true, note: "already recorded" }) };
    }
    // A refund or cancellation can land before this message does (Stripe
    // retries a failed delivery for hours). Never bring a refunded or cancelled
    // booking back to life by issuing its tickets.
    if (order.status === "refunded" || order.status === "cancelled") {
      console.error("checkout.session.completed for " + order.order_ref + " arrived after it was " + order.status + " — left as it is");
      return { statusCode: 200, body: JSON.stringify({ received: true, note: "order already " + order.status }) };
    }

    var isDeposit = Number(order.deposit_pence) > 0;

    var paidFields = isDeposit
      ? { status: "deposit_paid", paid_at: nowIso, stripe_session_id: session.id }
      : { status: "paid", paid_at: nowIso, tickets_issued_at: nowIso, stripe_session_id: session.id };
    // Kept so a refund can be made from the app. Only written for chef orders:
    // the column arrives with the chef migration, and Hawthbush's own orders
    // are refunded in its own dashboard as before.
    if (order.stripe_account_id && session.payment_intent) {
      paidFields.stripe_payment_intent_id = typeof session.payment_intent === "string"
        ? session.payment_intent : session.payment_intent.id;
    }
    // Conditional on the order still being pending: if a cancellation or a
    // parallel delivery got there first, this changes nothing and nobody is
    // emailed. Only a PATCH that actually moved a row sends the confirmation.
    var newRows = await sbRest("box_orders?id=eq." + order.id + "&status=eq.pending", {
      method: "PATCH", prefer: "return=representation",
      body: paidFields
    });
    if (!Array.isArray(newRows) || !newRows.length) {
      console.warn("checkout.session.completed for " + order.order_ref + ": order was no longer pending — nothing changed");
      return { statusCode: 200, body: JSON.stringify({ received: true, note: "order no longer pending" }) };
    }

    await flagIfOversold(order);

    // No QR until paid in full. A deposit gets the "table reserved" email,
    // which states the balance and its due date and carries no code.
    await sendEmail(isDeposit ? "table_reserved" : "booking_confirmed", order.id);

    return { statusCode: 200, body: JSON.stringify({ received: true }) };

  } catch (err) {
    console.error("stripe-ticket-webhook error:", err);
    // 500 so Stripe retries — every write above is idempotent.
    return { statusCode: 500, body: "Internal error — Stripe will retry" };
  }
};
