// netlify/functions/pay-balance.js
// Opens a Stripe Checkout session for an outstanding balance.
//
// Called two ways, both with the booking's own QR token as the credential —
// the token is the secret that /my-ticket is built on, so nothing further is
// needed:
//   · from public/my-ticket.html, when someone presses "Pay the balance"
//   · from box-billing.js, to mint the link that goes in the balance email
//
// Required env vars: STRIPE_SECRET_KEY · SUPABASE_SERVICE_KEY

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const SITE_ORIGIN  = "https://hawthbushfarm.netlify.app";

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

function money(pence) { return (Math.round(Number(pence) || 0) / 100).toFixed(2); }

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  var body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  var token = String(body.token || "").trim();
  if (!token) return { statusCode: 400, body: JSON.stringify({ error: "Missing token" }) };

  try {
    var rows = await sbRest("box_orders?qr_token=eq." + encodeURIComponent(token) + "&select=*");
    var order = rows && rows[0];
    if (!order) return { statusCode: 404, body: JSON.stringify({ error: "Booking not found" }) };

    if (order.status === "cancelled" || order.status === "refunded") {
      return { statusCode: 409, body: JSON.stringify({ error: "That booking has been cancelled." }) };
    }
    if (Number(order.balance_pence) <= 0 || order.balance_paid_at) {
      return { statusCode: 409, body: JSON.stringify({ error: "There's nothing outstanding on that booking." }) };
    }

    var evRows = await sbRest("box_events?id=eq." + order.event_id + "&select=name,slug,starts_at");
    var ev = (evRows && evRows[0]) || { name: "Tickets" };

    var session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: order.email || undefined,
      line_items: [{
        price_data: {
          currency: "gbp",
          product_data: {
            name: "Balance — " + ev.name,
            description: order.total_qty + " × ticket · reference " + order.order_ref
          },
          unit_amount: Number(order.balance_pence)
        },
        quantity: 1
      }],
      metadata: {
        bookingType: "box_balance",
        orderId:     order.id,
        orderRef:    order.order_ref
      },
      success_url: SITE_ORIGIN + "/my-ticket/" + token + "?paid=1",
      cancel_url:  SITE_ORIGIN + "/my-ticket/" + token
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: session.url, amount: money(order.balance_pence) })
    };

  } catch (err) {
    console.error("pay-balance error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: "Could not open the payment page. Please try again." }) };
  }
};
