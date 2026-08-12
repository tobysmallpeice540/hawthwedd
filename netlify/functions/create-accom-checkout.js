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

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJrcWJ5aXNmbXZ3dWxzeXh6d2p6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NTI0MzgsImV4cCI6MjA5NjUyODQzOH0._CsyhvFrtHFC0KrfiLzbrLUaKcvxtbWlHydaH20tvfo";
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

  // Support both new multi-stay format (body.stays[]) and legacy single-property format
  var stays = body.stays;
  if (!stays || !stays.length) {
    // Legacy single-property fallback
    if (!body.propertyId) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing stays or propertyId" }) };
    }
    stays = [{ propertyId: body.propertyId, propertyName: body.propertyName, checkIn: body.checkIn, checkOut: body.checkOut, nights: body.nights, value: body.totalAmount }];
  }

  const { totalAmount, depositAmount, guestName, email, phone, guestCount, notes } = body;

  if (!totalAmount || !depositAmount || !guestName || !email) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields" }) };
  }

  // Primary stay for metadata / URLs
  const primaryStay = stays[0];
  const propNamesJoined = stays.map(function(s) { return s.propertyName || s.propertyId; }).join(" + ");
  const checkIn  = primaryStay.checkIn;
  const checkOut = primaryStay.checkOut;

  // Determine origin for success/cancel URLs
  const origin = event.headers["origin"] || event.headers["referer"] || "https://hawthbushfarm.netlify.app";
  const baseUrl = origin.replace(/\/$/, "");

  try {
    // ── 1. Create Stripe Checkout session ────────────────────────────────────
    const depositPence = Math.round(depositAmount * 100);

    // Build one line item per property (or a single combined line item)
    var lineItems;
    if (stays.length === 1) {
      lineItems = [{
        price_data: {
          currency: "gbp",
          product_data: {
            name: "Deposit — " + (stays[0].propertyName || stays[0].propertyId),
            description: fmtDate(checkIn) + " to " + fmtDate(checkOut) + " (" + (stays[0].nights || "") + " nights)"
          },
          unit_amount: depositPence
        },
        quantity: 1
      }];
    } else {
      // Multi-property: one combined line item for the deposit
      lineItems = [{
        price_data: {
          currency: "gbp",
          product_data: {
            name: "Deposit — " + propNamesJoined,
            description: fmtDate(checkIn) + " to " + fmtDate(checkOut) + " (" + (primaryStay.nights || "") + " nights)"
          },
          unit_amount: depositPence
        },
        quantity: 1
      }];
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: email,
      line_items: lineItems,
      metadata: {
        bookingType:   "accom_deposit",
        propertyId:    stays.map(function(s) { return s.propertyId; }).join(","),
        propertyName:  propNamesJoined,
        checkIn:       checkIn,
        checkOut:      checkOut,
        guestName:     guestName,
        email:         email,
        totalAmount:   String(totalAmount),
        depositAmount: String(depositAmount)
      },
      // Both Stripe exits land on the website, not on the bare Netlify page.
      // The booking details ride along in the query string; the embed snippet
      // on that page forwards them into the iframe so the confirmation shows
      // the reference and dates rather than a bare "thank you".
      success_url: "https://www.hawthbushfarm.co.uk/book?booked=1&prop=" + encodeURIComponent(propNamesJoined) + "&ci=" + checkIn + "&co=" + checkOut,
      // Stripe's back arrow and the cancel path return the guest to the
      // booking page on the main website, not to the bare Netlify page.
      cancel_url:  "https://www.hawthbushfarm.co.uk/book"
    });

    // ── 2. Save pending booking to Supabase ──────────────────────────────────
    const bookingId    = "web-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
    const todayISO     = new Date().toISOString().slice(0,10);
    // Balance timing should follow the booking's earliest check-in (not
    // necessarily the first stay added), and respect whatever balanceWeeks
    // the booking page computed from the properties in the cart.
    const balanceWeeks  = Number(body.balanceWeeks) > 0 ? Number(body.balanceWeeks) : 6;
    const earliestCheckIn = stays.reduce(function(a, s) {
      return (!a || (s.checkIn && s.checkIn < a)) ? s.checkIn : a;
    }, null) || checkIn;

    const schedule = [
      {
        label:         "Deposit",
        amount:        depositAmount,
        dueDate:       todayISO,
        requested:     false,
        requestedDate: null,
        paid:          false,
        paidDate:      null,
        stripeId:      session.id
      },
      {
        label:         "Balance",
        amount:        Math.round((totalAmount - depositAmount) * 100) / 100,
        dueDate:       addWeeksISO(earliestCheckIn, -balanceWeeks),
        requested:     false,
        requestedDate: null,
        paid:          false,
        paidDate:      null,
        stripeId:      null
      }
    ];

    // Normalise stays — ensure propertyName is populated
    const normStays = stays.map(function(s) {
      return {
        propertyId:   s.propertyId   || "",
        propertyName: s.propertyName || s.propertyId || "",
        checkIn:      s.checkIn      || checkIn,
        checkOut:     s.checkOut     || checkOut,
        nights:       s.nights       || 0,
        value:        Number(s.value) || 0
      };
    });

    const booking = {
      id:              bookingId,
      guestName:       guestName,
      email:           email,
      phone:           phone || "",
      guestCount:      guestCount || 1,
      source:          "direct",
      status:          "pending",
      bookingType:     "",
      linkedEventId:   null,
      stays:           normStays,
      value:           totalAmount,
      estimated:       false,
      extras:          [],
      breakage:        0,
      breakageStripeId: null,
      discountCode:    "",
      discountAmount:  0,
      schedule:        schedule,
      notes:           (notes ? notes + "\n" : "") + "Online booking — Stripe session: " + session.id,
      createdAt:       new Date().toISOString(),
      // When the guest ticked the T&C box at checkout. Recorded so there is a
      // record of acceptance if it is ever queried.
      termsAcceptedAt: body.termsAcceptedAt || null,
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
