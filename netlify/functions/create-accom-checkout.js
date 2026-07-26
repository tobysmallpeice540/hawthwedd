// netlify/functions/create-accom-checkout.js
// Creates a Stripe Checkout session for a holiday-let deposit and saves a
// pending booking to Supabase. Called by book-accom.html.
//
// Required Netlify env vars:
//   STRIPE_SECRET_KEY       — Stripe secret key (sk_live_...)
//   SUPABASE_URL            — https://rkqbyisfmvwulsyxzwjz.supabase.co
//   SUPABASE_ANON_KEY       — Supabase anon key (or hardcode below)
//
// Also add to netlify.toml [build.environment]:
//   SECRETS_SCAN_OMIT_KEYS = "SUPABASE_ANON_KEY,STRIPE_SECRET_KEY"

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
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { propertyId, propertyName, checkIn, checkOut, nights, totalAmount, depositAmount, guestName, email, phone, guestCount } = body;

  // Basic validation
  if (!propertyId || !checkIn || !checkOut || !totalAmount || !depositAmount || !guestName || !email) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields" }) };
  }

  // Determine origin for success/cancel URLs
  const origin = event.headers["origin"] || event.headers["referer"] || "https://cool-sorbet-b1d599.netlify.app";
  const baseUrl = origin.replace(/\/$/, "");

  try {
    // ── 1. Create Stripe Checkout session ────────────────────────────────────
    const depositPence = Math.round(depositAmount * 100);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: {
              name: "Deposit — " + propertyName,
              description: fmtDate(checkIn) + " to " + fmtDate(checkOut) + " (" + nights + " nights)"
            },
            unit_amount: depositPence
          },
          quantity: 1
        }
      ],
      metadata: {
        bookingType: "accom_deposit",
        propertyId: propertyId,
        propertyName: propertyName,
        checkIn: checkIn,
        checkOut: checkOut,
        guestName: guestName,
        email: email,
        totalAmount: String(totalAmount),
        depositAmount: String(depositAmount)
      },
      success_url: baseUrl + "/book-accom.html?booked=1&prop=" + encodeURIComponent(propertyName) + "&ci=" + checkIn + "&co=" + checkOut,
      cancel_url:  baseUrl + "/book-accom.html?cancelled=1"
    });

    // ── 2. Save pending booking to Supabase ──────────────────────────────────
    const bookingId = "web-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
    const today = new Date().toISOString().slice(0,10);
    const balanceWeeks = 6; // fallback; ideally read from property settings

    const stay = {
      propertyId:   propertyId,
      propertyName: propertyName,
      checkIn:      checkIn,
      checkOut:     checkOut,
      nights:       nights,
      value:        totalAmount
    };

    const schedule = [
      {
        label:         "Deposit",
        amount:        depositAmount,
        dueDate:       today,
        requested:     false,
        requestedDate: null,
        paid:          false,
        paidDate:      null,
        stripeId:      session.id
      },
      {
        label:         "Balance",
        amount:        Math.round((totalAmount - depositAmount) * 100) / 100,
        dueDate:       addWeeksISO(checkIn, -balanceWeeks),
        requested:     false,
        requestedDate: null,
        paid:          false,
        paidDate:      null,
        stripeId:      null
      }
    ];

    const booking = {
      id:          bookingId,
      guestName:   guestName,
      email:       email,
      phone:       phone || "",
      guestCount:  guestCount || 1,
      source:      "direct",
      status:      "pending",
      bookingType: "",
      linkedEventId: null,
      stays:       [stay],
      value:       totalAmount,
      estimated:   false,
      extras:      [],
      breakage:    0,
      breakageStripeId: null,
      discountCode: "",
      discountAmount: 0,
      schedule:    schedule,
      notes:       "Online booking via book-accom.html — Stripe session: " + session.id,
      createdAt:   new Date().toISOString(),
      stripeSessionId: session.id
    };

    // Load existing bookings and append (no spread)
    const existing = await sbGet(ACCOM_KEY) || [];
    await sbSet(ACCOM_KEY, existing.concat([booking]));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: session.url, bookingId: bookingId })
    };

  } catch (err) {
    console.error("create-accom-checkout error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to create checkout session. Please try again." })
    };
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return "";
  var d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function addWeeksISO(iso, weeks) {
  if (!iso) return null;
  var d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + weeks * 7);
  return d.toISOString().slice(0,10);
}
