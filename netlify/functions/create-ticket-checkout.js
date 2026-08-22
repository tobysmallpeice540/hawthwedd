// netlify/functions/create-ticket-checkout.js
// Reserves an order and opens a Stripe Checkout session for it. Called by
// public/ticket-event.html.
//
// Copied in shape from create-accom-checkout.js, with one important difference:
// the booking is not assembled here and written back over a JSON blob. It is
// created by box_reserve_order() in Postgres, which locks the ticket types and
// counts what is genuinely sold inside a single transaction. That function is
// the only thing standing between a rush of simultaneous buyers and an
// oversold barn, so nothing in this file may route around it.
//
// The browser sends what it thinks the tickets cost. This file ignores that
// entirely: the prices, the discount and the deposit all come back from the
// reserve function, and those are the numbers Stripe is asked for.
//
// Required env vars:
//   STRIPE_TICKET_SECRET_KEY · SUPABASE_SERVICE_KEY

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

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const SITE_ORIGIN  = "https://hawthbushfarm.netlify.app";

// The hold inside box_reserve_order() is 15 minutes. Stripe won't let a session
// expire sooner than 30 minutes, so 30 it is — a payment landing after the hold
// has lapsed is handled in the webhook rather than pretended away.
const SESSION_MINUTES = 30;

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

async function sbRpc(fn, args) {
  return sbRest("rpc/" + fn, { method: "POST", body: args });
}

function money(pence) { return (Math.round(Number(pence) || 0) / 100).toFixed(2); }

function fmtDateLondon(ts) {
  if (!ts) return "";
  var d = new Date(ts);
  if (isNaN(d)) return "";
  return d.toLocaleDateString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "long", year: "numeric" }) +
    ", " + d.toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
}

function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "")); }

// ── Handler ──────────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  var body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  var slug  = String(body.slug || "").trim();
  var lines = Array.isArray(body.lines) ? body.lines : [];

  if (!slug || !lines.length) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing event or tickets" }) };
  }
  if (!body.firstName || !body.lastName || !isEmail(body.email)) {
    return { statusCode: 400, body: JSON.stringify({ error: "Please check your name and email address." }) };
  }

  // Whatever the browser sent, only the ids and counts are carried forward.
  var cleanLines = lines
    .map(function(l) { return { ticket_type_id: String(l.ticket_type_id || ""), qty: Math.max(0, parseInt(l.qty, 10) || 0) }; })
    .filter(function(l) { return l.ticket_type_id && l.qty > 0; });

  if (!cleanLines.length) {
    return { statusCode: 400, body: JSON.stringify({ error: "No tickets were selected." }) };
  }

  try {
    // ── 1. Reserve. This either succeeds completely or changes nothing. ──────
    var reserved = await sbRpc("box_reserve_order", {
      p_slug: slug,
      p_access_code: body.accessCode || "",
      p_first_name: body.firstName,
      p_last_name: body.lastName,
      p_email: body.email,
      p_phone: body.phone || "",
      p_lines: cleanLines,
      p_discount_code: body.discountCode || "",
      p_source: "stripe",
      p_notes: body.termsAcceptedAt ? "Terms accepted " + body.termsAcceptedAt : ""
    });

    if (!reserved || !reserved.ok) {
      // A refusal here is normal — it is what "sold out" looks like — so it
      // comes back as a readable sentence, not an error page.
      return {
        statusCode: 409,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: (reserved && reserved.message) || "Those tickets are no longer available.",
          code: reserved && reserved.error,
          remaining: reserved && reserved.remaining
        })
      };
    }

    // ── 2. What Stripe is actually asked to take ────────────────────────────
    var evRows = await sbRest("box_events?slug=eq." + encodeURIComponent(slug) + "&select=name,starts_at,venue_name,payment_mode,balance_days");
    var ev = (evRows && evRows[0]) || { name: "Tickets" };
    var typeRows = await sbRest("box_order_lines?order_id=eq." + reserved.order_id +
      "&select=qty,unit_price_pence,ticket_type_id,box_ticket_types(name)");

    var lineItems;
    var discounts = [];

    if (reserved.deposit_pence > 0) {
      // Deposit event: one honest line, and the balance stated in its
      // description so the receipt says what was actually agreed.
      lineItems = [{
        price_data: {
          currency: "gbp",
          product_data: {
            name: "Deposit — " + ev.name,
            description: reserved.qty + " × ticket · balance of £" + money(reserved.balance_pence) +
              " due by " + (reserved.balance_due_on || "the date confirmed by email")
          },
          unit_amount: reserved.deposit_pence
        },
        quantity: 1
      }];
    } else {
      lineItems = (typeRows || []).map(function(l) {
        var name = (l.box_ticket_types && l.box_ticket_types.name) || "Ticket";
        return {
          price_data: {
            currency: "gbp",
            product_data: { name: name + " — " + ev.name, description: fmtDateLondon(ev.starts_at) },
            unit_amount: l.unit_price_pence
          },
          quantity: l.qty
        };
      });

      // The discount goes on as its own line rather than being quietly baked
      // into the ticket price, so the receipt tells the truth about what was
      // charged and why.
      if (reserved.discount_pence > 0) {
        var coupon = await stripe.coupons.create({
          amount_off: reserved.discount_pence,
          currency: "gbp",
          duration: "once",
          name: "Discount " + (body.discountCode || "").toUpperCase()
        });
        discounts = [{ coupon: coupon.id }];
      }
    }

    var origin = (event.headers["origin"] || SITE_ORIGIN).replace(/\/$/, "");
    var backTo = origin + "/tickets/" + encodeURIComponent(slug);

    var session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: body.email,
      line_items: lineItems,
      discounts: discounts.length ? discounts : undefined,
      expires_at: Math.floor(Date.now() / 1000) + SESSION_MINUTES * 60,
      metadata: {
        // Its own booking type, on its own webhook endpoint, so nothing from
        // the cottage flow can ever be mistaken for a ticket order.
        bookingType: "box_ticket",
        orderId:     reserved.order_id,
        orderRef:    reserved.order_ref,
        eventSlug:   slug
      },
      success_url: backTo + "?ref=" + encodeURIComponent(reserved.order_ref) + "&t=" + encodeURIComponent(reserved.qr_token),
      cancel_url:  backTo
    });

    await sbRest("box_orders?id=eq." + reserved.order_id, {
      method: "PATCH", prefer: "return=minimal",
      body: { stripe_session_id: session.id }
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: session.url, orderRef: reserved.order_ref })
    };

  } catch (err) {
    console.error("create-ticket-checkout error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Something went wrong opening the payment page. Please try again." })
    };
  }
};
