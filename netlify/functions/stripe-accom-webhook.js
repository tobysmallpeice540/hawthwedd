// netlify/functions/stripe-accom-webhook.js
// Handles Stripe webhook events for accommodation bookings.
// On checkout.session.completed: marks the booking confirmed + deposit paid.
//
// Required Netlify env vars:
//   STRIPE_SECRET_KEY      — Stripe secret key (sk_live_...)
//   STRIPE_WEBHOOK_SECRET  — Stripe webhook signing secret (whsec_...)
//   SUPABASE_URL           — https://rkqbyisfmvwulsyxzwjz.supabase.co
//   SUPABASE_ANON_KEY      — Supabase anon key
//
// In your Stripe dashboard, add a webhook endpoint pointing to:
//   https://cool-sorbet-b1d599.netlify.app/.netlify/functions/stripe-accom-webhook
// Events to listen for: checkout.session.completed

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const SUPABASE_URL = process.env.SUPABASE_URL || "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const ACCOM_KEY    = "hbf_accom_v1";

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
    // Acknowledge events we don't handle
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  }

  const session = stripeEvent.data.object;

  // Only handle accommodation deposits (guard against other Stripe checkout sessions)
  if (!session.metadata || session.metadata.bookingType !== "accom_deposit") {
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  }

  try {
    const sessionId = session.id;
    const paidAt    = new Date().toISOString();
    const paidDate  = paidAt.slice(0,10);

    // Load all bookings and update the matching one
    const bookings = await sbGet(ACCOM_KEY) || [];
    let found = false;

    const updated = bookings.map(function(b) {
      if (b.stripeSessionId !== sessionId) return b;
      found = true;

      // Mark confirmed
      const updatedBooking = Object.assign({}, b, { status: "confirmed" });

      // Mark deposit schedule entry paid
      const updatedSchedule = (b.schedule || []).map(function(s) {
        if (s.stripeId === sessionId || s.label === "Deposit") {
          return Object.assign({}, s, { paid: true, paidDate: paidDate });
        }
        return s;
      });
      updatedBooking.schedule = updatedSchedule;

      // Record Stripe payment intent ID for audit trail
      if (session.payment_intent) {
        updatedBooking.depositStripeId = session.payment_intent;
      }

      return updatedBooking;
    });

    if (!found) {
      // Booking not found by stripeSessionId — try matching by session in notes
      console.warn("No booking found for Stripe session:", sessionId);
      return { statusCode: 200, body: JSON.stringify({ received: true, warning: "Booking not found" }) };
    }

    await sbSet(ACCOM_KEY, updated);
    console.log("Booking confirmed for Stripe session:", sessionId);

    return { statusCode: 200, body: JSON.stringify({ received: true }) };

  } catch (err) {
    console.error("stripe-accom-webhook error:", err);
    // Return 500 so Stripe retries
    return { statusCode: 500, body: "Internal error — Stripe will retry" };
  }
};
