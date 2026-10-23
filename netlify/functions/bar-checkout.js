// netlify/functions/bar-checkout.js
//
// Money behind the bar, paid by card from the client portal's Evening bar tab.
//
// The same shape as tickets: we name the amount, hold a checkout session for
// it, and Stripe tells us when it is paid. Nothing is recorded by hand.
//
//   1. The client's own JWT asks wp_bar_payment_start(amount). That resolves
//      THEIR event (no event id is ever taken from the browser) and writes a
//      pending row.
//   2. A Checkout session is made on the TICKETING Stripe account for exactly
//      that amount, carrying metadata.bookingType = "bar_tab" and the row id,
//      and attached to the row with the service key.
//   3. stripe-ticket-webhook.js receives checkout.session.completed, checks the
//      session and amount against the row (wp_bar_payment_paid), marks it paid
//      and emails the client and the office.
//
// POST { amount }  with  Authorization: Bearer <the client's access token>
// → { url }  — the browser goes there.
//
// Required env vars: STRIPE_TICKET_SECRET_KEY, SUPABASE_SERVICE_KEY
// Optional: PORTAL_ORIGIN (where the portal is served; defaults to the site)

// Pinned for the same reason as create-ticket-checkout.js: the ticketing
// account's default API version predates expires_at and price_data.
const stripe = require("stripe")(process.env.STRIPE_TICKET_SECRET_KEY, {
  apiVersion: "2024-06-20"
});

const SUPABASE_URL  = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const SITE_ORIGIN   = "https://hawthbushfarm.netlify.app";
const PORTAL_ORIGIN = (process.env.PORTAL_ORIGIN || SITE_ORIGIN).replace(/\/+$/, "");
const SESSION_MINUTES = 30;   // Stripe's minimum

function reply(code, data) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
}

// A database function as the person (their JWT) or as the service. Anything
// but a 2xx throws — an unchecked response is never a yes.
async function rpc(fn, args, bearer) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + fn, {
    method: "POST",
    headers: { "apikey": SERVICE_KEY, "Authorization": "Bearer " + bearer, "Content-Type": "application/json" },
    body: JSON.stringify(args || {})
  });
  const text = await res.text();
  if (!res.ok) { const e = new Error(fn + " " + res.status + " " + text.slice(0, 200)); e.status = res.status; throw e; }
  return text ? JSON.parse(text) : null;
}

const CLIENT_ERRORS = {
  no_access: "We can't find your booking — please sign in again.",
  bad_amount: "Please choose an amount between £10 and £5,000, in pounds and pence.",
  too_many_pending: "You have a payment already open. Finish or close it first, then try again in half an hour."
};

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" });
  if (!SERVICE_KEY || !process.env.STRIPE_TICKET_SECRET_KEY) return reply(500, { error: "Payments are not set up yet." });

  const auth = event.headers["authorization"] || event.headers["Authorization"] || "";
  const jwt = auth.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return reply(401, { error: "Please sign in." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "Invalid request" }); }
  const amount = Math.round(Number(body.amount) * 100) / 100;
  if (!Number.isFinite(amount)) return reply(400, { error: CLIENT_ERRORS.bad_amount });

  // 1. As the client.
  let start;
  try { start = await rpc("wp_bar_payment_start", { p_amount: amount }, jwt); }
  catch (e) { console.error("wp_bar_payment_start:", e.message); return reply(e.status === 401 ? 401 : 500, { error: "Could not start the payment." }); }
  if (!start || start.ok === false) {
    return reply(400, { error: CLIENT_ERRORS[start && start.error] || "Could not start the payment.", code: start && start.error });
  }

  // 2. The session, for exactly the amount the database accepted.
  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "gbp",
          unit_amount: Math.round(Number(start.amount) * 100),
          product_data: {
            name: "Money behind the bar",
            description: (start.couple ? start.couple + " — " : "") + "Hawthbush Farm. Anything unused is refunded to this card after the event."
          }
        }
      }],
      customer_email: start.email || undefined,
      client_reference_id: "event-" + start.event_id,
      metadata: { bookingType: "bar_tab", barPaymentId: start.id, eventId: String(start.event_id) },
      payment_intent_data: {
        description: "Money behind the bar — event " + start.event_id + (start.couple ? " (" + start.couple + ")" : ""),
        metadata: { bookingType: "bar_tab", barPaymentId: start.id, eventId: String(start.event_id) }
      },
      expires_at: Math.floor(Date.now() / 1000) + SESSION_MINUTES * 60,
      success_url: PORTAL_ORIGIN + "/portal?bar=thanks",
      cancel_url: PORTAL_ORIGIN + "/portal?bar=cancelled"
    });
  } catch (e) {
    console.error("Stripe session for bar payment " + start.id + " failed:", e.message);
    return reply(502, { error: "The card payment page could not be opened. Please try again in a moment." });
  }

  // 3. Tie the session to the row, so the webhook can match it.
  try {
    const att = await rpc("wp_bar_payment_attach", { p_id: start.id, p_session: session.id }, SERVICE_KEY);
    if (!att || att.ok === false) throw new Error((att && att.error) || "attach refused");
  } catch (e) {
    // Without the link the webhook could not confirm this payment, so do not
    // send anyone to pay it. Expire the session we just made.
    console.error("Attaching session " + session.id + " to bar payment " + start.id + " failed:", e.message);
    try { await stripe.checkout.sessions.expire(session.id); } catch (x) { /* it will lapse in 30 minutes anyway */ }
    return reply(500, { error: "Could not start the payment. Please try again." });
  }

  return reply(200, { url: session.url });
};
