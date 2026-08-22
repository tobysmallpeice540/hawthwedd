// netlify/functions/stripe-ticket-webhook.js
// Payment confirmed → issue the tickets and send the email.
//
// This is deliberately its own endpoint with its own signing secret, separate
// from stripe-accom-webhook.js, so a cottage booking's metadata can never be
// mistaken for a ticket order or the other way round. Add it in Stripe as a
// SECOND webhook endpoint:
//   https://hawthbushfarm.netlify.app/.netlify/functions/stripe-ticket-webhook
// listening for: checkout.session.completed, checkout.session.expired
//
// Two payment flows land here, told apart by session.metadata.bookingType:
//   "box_ticket"  — a new order from create-ticket-checkout.js. Either paid in
//                   full (tickets issued, QR sent) or a deposit (table
//                   reserved, deliberately no QR).
//   "box_balance" — an outstanding balance settled through pay-balance.js.
//                   Clearing it is what issues the tickets.
//
// Required env vars:
//   STRIPE_SECRET_KEY · STRIPE_TICKET_WEBHOOK_SECRET · SUPABASE_SERVICE_KEY
//   HBF_ADMIN_TOKEN (to call send-ticket-email.js)

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

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

// ── Handler ──────────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const sig = event.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_TICKET_WEBHOOK_SECRET;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return { statusCode: 400, body: "Webhook signature verification failed" };
  }

  const session  = stripeEvent.data.object;
  const metaType = (session.metadata && session.metadata.bookingType) || "";

  if (metaType !== "box_ticket" && metaType !== "box_balance") {
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  }

  try {
    // ── An abandoned checkout: let the seats go straight away ───────────────
    if (stripeEvent.type === "checkout.session.expired") {
      var expId = session.metadata && session.metadata.orderId;
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

    var nowIso = new Date().toISOString();

    if (metaType === "box_balance") {
      // Already settled — a Stripe retry, not a second payment.
      if (order.balance_paid_at) {
        return { statusCode: 200, body: JSON.stringify({ received: true, note: "balance already paid" }) };
      }
      await sbRest("box_orders?id=eq." + order.id, {
        method: "PATCH", prefer: "return=minimal",
        body: {
          status: "paid",
          balance_paid_at: nowIso,
          balance_pence: 0,
          tickets_issued_at: order.tickets_issued_at || nowIso
        }
      });
      // The balance clearing is exactly what issues the tickets, so the QR
      // goes out now and not before.
      await sendEmail("tickets_issued", order.id);
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }

    // ── A new order ─────────────────────────────────────────────────────────
    if (order.status === "paid" || order.status === "deposit_paid") {
      return { statusCode: 200, body: JSON.stringify({ received: true, note: "already recorded" }) };
    }

    var isDeposit = Number(order.deposit_pence) > 0;

    await sbRest("box_orders?id=eq." + order.id, {
      method: "PATCH", prefer: "return=minimal",
      body: isDeposit
        ? { status: "deposit_paid", paid_at: nowIso, stripe_session_id: session.id }
        : { status: "paid", paid_at: nowIso, tickets_issued_at: nowIso, stripe_session_id: session.id }
    });

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
