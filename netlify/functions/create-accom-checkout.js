// netlify/functions/create-accom-checkout.js
// Creates a Stripe Checkout session for a holiday-let deposit and saves a
// pending booking to Supabase. Called by book-accom.html.
//
// Required Netlify env vars:
//   STRIPE_SECRET_KEY       — Stripe secret key (sk_live_...)
//   SUPABASE_URL            — https://rkqbyisfmvwulsyxzwjz.supabase.co
//   SUPABASE_SERVICE_KEY    — Supabase service key (server-side only)
//
// Also add to netlify.toml [build.environment]:
//   SECRETS_SCAN_OMIT_KEYS = "SUPABASE_SERVICE_KEY,STRIPE_SECRET_KEY,…"

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
// The service key, not the anon key. Server-side code has no business
// holding the same credential the public pages carry — and once app_data
// has row level security this is what keeps the scheduled jobs working.
// No fallback to the anon key on purpose: a missing variable should fail
// loudly rather than quietly reopen what this change closes.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ACCOM_KEY    = "hbf_accom_v1";
const PROPS_KEY    = "hbf_properties_v1";
const MAX_PROPERTIES_PER_BOOKING = 3;   // as on the booking page
// How far the browser's figure may drift from the server's before the booking
// is refused. Both run the same arithmetic, so in practice they agree to the
// penny; the pound is headroom for float rounding, not for a discount.
const PRICE_TOLERANCE = 1;

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

  const { guestName, email, phone, guestCount, notes } = body;

  if (!body.totalAmount || !body.depositAmount || !guestName || !email) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields" }) };
  }

  // The success and cancel addresses below are fixed (the website's /book
  // page), so nothing here is built from the request's Origin or Referer.

  try {
    // ── 0. Price on the server ───────────────────────────────────────────────
    // The browser's figures are a claim, not a price. The stays are re-priced
    // here from the stored property settings with the booking page's own
    // rules, and it is the server's deposit that Stripe is asked to take.
    const properties = (await sbGet(PROPS_KEY)) || [];
    const quote = priceBooking(properties, stays, londonToday());
    if (quote.error) {
      return { statusCode: 400, headers: { "Content-Type": "application/json" },
               body: JSON.stringify({ error: quote.error }) };
    }
    if (Math.abs(Number(body.totalAmount) - quote.total) > PRICE_TOLERANCE ||
        Math.abs(Number(body.depositAmount) - quote.deposit) > PRICE_TOLERANCE) {
      console.warn("create-accom-checkout: price mismatch — browser", body.totalAmount, body.depositAmount,
                   "server", quote.total, quote.deposit);
      return { statusCode: 400, headers: { "Content-Type": "application/json" },
               body: JSON.stringify({ error: "The price for these dates has changed since the page was loaded. " +
                                            "Please refresh the page to see the current price, then try again." }) };
    }
    stays = quote.stays;
    const totalAmount   = quote.total;
    const depositAmount = quote.deposit;

    // Primary stay for metadata / URLs
    const primaryStay = stays[0];
    const propNamesJoined = stays.map(function(s) { return s.propertyName || s.propertyId; }).join(" + ");
    const checkIn  = primaryStay.checkIn;
    const checkOut = primaryStay.checkOut;

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

    // Last line of defence against a double booking: re-check against current
    // data immediately before taking any money.
    const bookedAlready = await sbGet(ACCOM_KEY) || [];
    const clashes = findClashes(bookedAlready, stays);
    if (clashes.length) {
      var names = clashes.map(function(c) { return c.propertyName; })
        .filter(function(v, i, a) { return a.indexOf(v) === i; }).join(" and ");
      return {
        statusCode: 409,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Sorry — " + names + " has just been booked for those dates. Please choose different dates.",
          clashes: clashes
        })
      };
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      // An abandoned checkout tab used to stay payable for Stripe's 24 hours,
      // so finishing it after the office had sent (and the guest had paid) a
      // deposit link took the deposit twice. An hour is ample to pay.
      expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
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
    // Short reference the guest can read out over the phone: a letter and five
    // digits, e.g. W10432. The existing list is loaded first so the number is
    // checked for collisions rather than assumed unique — it is the primary
    // key for this booking everywhere, including the Stripe webhook.
    let bookingId      = newBookingRef(bookedAlready, "W");
    const todayISO     = new Date().toISOString().slice(0,10);
    // Balance timing should follow the booking's earliest check-in (not
    // necessarily the first stay added), and respect whatever balanceWeeks
    // the booking page computed from the properties in the cart.
    // From the stored settings, by the page's rule — not from the browser.
    const balanceWeeks  = quote.balanceWeeks > 0 ? quote.balanceWeeks : 6;
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
    // House rules for a standard let. Wedding parties get different times, but
    // nobody books one of those through the public page — those are created in
    // the app and linked to an event there.
    const DEFAULT_CHECK_IN  = "16:00";
    const DEFAULT_CHECK_OUT = "10:00";

    const normStays = stays.map(function(s) {
      return {
        propertyId:   s.propertyId   || "",
        propertyName: s.propertyName || s.propertyId || "",
        checkIn:      s.checkIn      || checkIn,
        checkOut:     s.checkOut     || checkOut,
        checkInTime:  DEFAULT_CHECK_IN,
        checkOutTime: DEFAULT_CHECK_OUT,
        maybe:        false,
        nights:       s.nights       || 0,
        value:        Number(s.value) || 0
      };
    });

    const booking = {
      id:              bookingId,
      // The flat fields the office app writes for every booking (see
      // handleSave in App.jsx). send-accom-reminders and older readers look
      // at these, not at stays[].
      propertyId:      normStays[0].propertyId,
      propertyName:    normStays[0].propertyName,
      propertyIds:     normStays.map(function(s) { return s.propertyId; }),
      checkIn:         normStays[0].checkIn,
      checkOut:        normStays[0].checkOut,
      nights:          normStays[0].nights || null,
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

    // Written straight into the bookings list as "pending". It holds the dates
    // — including on the Airbnb feed — until it is either paid, which flips it
    // to confirmed, or deleted by hand. An unpaid pending booking is listed on
    // the home page so it doesn't sit there unnoticed.
    //
    // Re-read immediately before writing: another booking may have landed
    // while this guest was filling in the form, and appending to the stale
    // copy would erase it.
    //
    // And re-check the dates against that same fresh copy: the first check
    // ran before the Stripe round-trip, and a booking, an Airbnb import or a
    // block may have landed in between.
    const latest = await sbGet(ACCOM_KEY) || [];
    const lateClashes = findClashes(latest, stays);
    if (lateClashes.length) {
      try { await stripe.checkout.sessions.expire(session.id); }
      catch (e) { console.error("Could not expire checkout session " + session.id + ":", e.message); }
      var lateNames = lateClashes.map(function(c) { return c.propertyName; })
        .filter(function(v, i, a) { return a.indexOf(v) === i; }).join(" and ");
      return {
        statusCode: 409,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Sorry — " + lateNames + " has just been booked for those dates. Please choose different dates.",
          clashes: lateClashes
        })
      };
    }
    if (latest.some(function(b) { return b && String(b.id).toUpperCase() === String(booking.id).toUpperCase(); })) {
      booking.id = bookingId = newBookingRef(latest, "W");
    }
    await sbSet(ACCOM_KEY, latest.concat([booking]));

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

// ── Pricing ───────────────────────────────────────────────────────────────────
// Ported verbatim from public/book-accom.html (which mirrors App.jsx). The
// three must agree, or the price a guest is shown, the price they are charged
// and the price the office sees drift apart. UTC-anchored date arithmetic, as
// on the page.
function parseISO(iso) {
  var parts = iso.split("-");
  return new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)));
}
function toISO(d) {
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
}
function seasonForDate(prop, ds) {
  if (!prop.seasons) return null;
  for (var i = 0; i < prop.seasons.length; i++) {
    var s = prop.seasons[i];
    if (s.startDate && s.endDate && ds >= s.startDate && ds < s.endDate) return s;
  }
  return null;
}
function getPriceForNight(prop, dateStr) {
  if (!prop) return 0;
  var s = seasonForDate(prop, dateStr);
  if (s) return Number(s.ratePerNight) || 0;
  return Number(prop.baseRate) || 0;
}
function longStayDiscountAmount(prop, nights, subtotal) {
  if (!prop || !(prop.longStayThreshold > 0) || !(nights >= prop.longStayThreshold)) return 0;
  var r2 = function(n) { return Math.round(n * 100) / 100; };
  var pct = Number(prop.longStayDiscountPct) || 0;
  if (pct > 0) return Math.min(r2(subtotal), r2(subtotal * pct / 100));
  var legacyPerNight = Number(prop.longStayDiscount) || 0;
  return legacyPerNight > 0 ? Math.min(r2(subtotal), r2(legacyPerNight * nights)) : 0;
}
function quoteStay(prop, ci, co) {
  if (!prop || !ci || !co) return null;
  var nights = Math.round((parseISO(co) - parseISO(ci)) / 86400000);
  if (nights <= 0) return null;
  var sub = 0;
  var d = parseISO(ci);
  for (var i = 0; i < nights; i++) {
    sub += getPriceForNight(prop, toISO(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  var disc = longStayDiscountAmount(prop, nights, sub);
  return { nights: nights, subtotal: sub, discount: disc, total: Math.max(0, Math.round((sub - disc) * 100) / 100) };
}
function maxNightsForProp(prop, ds) {
  var s = ds ? seasonForDate(prop, ds) : null;
  var v = s && Number(s.maxNights);
  return (v && v > 0) ? v : (Number(prop && prop.maxNights) || 28);
}

// The page's stay rules, mirrored from book-accom.html (minNightsForProp,
// checkInAllowedForProp, checkOutAllowedForProp, withinHorizonForProp), so a
// request the page could not have made is refused here too.
function minNightsForProp(prop, ds) {
  var s = ds ? seasonForDate(prop, ds) : null;
  var v = s && Number(s.minNights);
  return (v && v > 0) ? v : (Number(prop && prop.minNights) || 2);
}
function isoWeekday(ds) { return (parseISO(ds).getUTCDay() + 6) % 7; }   // 0=Mon..6=Sun
function allowedDays(prop, ds, field) {
  var season = seasonForDate(prop, ds);
  if (season && season[field] && season[field].length) return season[field];
  if (prop[field] && prop[field].length) return prop[field];
  return null;
}
function dayAllowed(prop, ds, field) {
  var allowed = allowedDays(prop, ds, field);
  return !allowed || allowed.indexOf(isoWeekday(ds)) !== -1;
}
// The page works the window out from the guest's own clock; a day's slack
// keeps a guest near midnight from being refused for the page's answer.
function withinHorizon(prop, ds, todayIso) {
  var months = Number(prop.bookingHorizonMonths);
  if (!months || !todayIso) return true;
  var t = parseISO(todayIso);
  var limit = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + months, t.getUTCDate() + 1));
  return ds <= toISO(limit);
}

// Today's date in London, as YYYY-MM-DD.
function londonToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());
}

// The whole basket, priced as the booking page prices it:
//   each stay = quoteStay(...).total; total = their sum, in cart order;
//   deposit % = the highest depositPct in the basket, never below 50
//     (the page's reduce starts at 50 — see the report: glamping's 20% is
//     therefore never applied online);
//   balance weeks = the smallest balanceWeeks in the basket, at most 6;
//   deposit = Math.round(total * pct) / 100.
// Returns { error } for anything the page could not have produced.
function priceBooking(properties, stays, todayIso) {
  if (!Array.isArray(stays) || !stays.length) return { error: "Please choose at least one property." };
  if (stays.length > MAX_PROPERTIES_PER_BOOKING) return { error: "Please book at most " + MAX_PROPERTIES_PER_BOOKING + " properties at once." };
  var ISO = /^\d{4}-\d{2}-\d{2}$/;
  var seen = {};
  var out = [];
  var props = [];
  for (var i = 0; i < stays.length; i++) {
    var st = stays[i] || {};
    var prop = (properties || []).filter(function(p) { return p && p.id === st.propertyId; })[0];
    if (!prop || prop.publicBookable === false) return { error: "That property can't be booked online. Please call us and we'll help." };
    if (seen[prop.id]) return { error: "Each property can only appear once in a booking." };
    seen[prop.id] = true;
    if (!ISO.test(String(st.checkIn || "")) || !ISO.test(String(st.checkOut || ""))) return { error: "Those dates aren't valid. Please choose them again." };
    if (todayIso && st.checkIn < todayIso) return { error: "Check-in can't be in the past. Please choose new dates." };
    var q = quoteStay(prop, st.checkIn, st.checkOut);
    if (!q) return { error: "Check-out must be after check-in." };
    if (q.nights > maxNightsForProp(prop, st.checkIn)) return { error: "That stay is longer than " + prop.name + " can be booked for online." };
    if (q.nights < minNightsForProp(prop, st.checkIn)) return { error: prop.name + " needs a stay of at least " + minNightsForProp(prop, st.checkIn) + " nights from that date." };
    if (!dayAllowed(prop, st.checkIn, "checkInDays")) return { error: prop.name + " can't be booked to arrive on that day of the week." };
    if (!dayAllowed(prop, st.checkOut, "checkOutDays")) return { error: prop.name + " can't be booked to leave on that day of the week." };
    var lastNight = toISO(new Date(parseISO(st.checkOut).getTime() - 86400000));
    if (!withinHorizon(prop, lastNight, todayIso)) return { error: "Those dates are further ahead than " + prop.name + " can be booked online yet." };
    if (!(q.total > 0)) return { error: "We can't price those dates online. Please call us and we'll help." };
    props.push(prop);
    out.push({ propertyId: prop.id, propertyName: prop.name || prop.id, checkIn: st.checkIn, checkOut: st.checkOut,
               nights: q.nights, value: q.total });
  }
  var total = out.reduce(function(a, s) { return a + s.value; }, 0);
  var depPct = props.reduce(function(a, p) { return Math.max(a, p.depositPct || 50); }, 50);
  var balWks = props.reduce(function(a, p) { return Math.min(a, p.balanceWeeks != null ? p.balanceWeeks : 6); }, 6);
  var deposit = Math.round(total * depPct) / 100;
  return { stays: out, total: total, deposit: deposit, depositPct: depPct, balanceWeeks: Number(balWks) };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// A short booking reference: one letter and five digits, e.g. "W10432".
// Random rather than sequential so two bookings started at the same moment
// can't be handed the same number, and checked against the bookings already
// stored so a clash is impossible rather than merely unlikely. Falls back to
// a longer number in the vanishingly unlikely event the space is exhausted.
// Mirrored in App.jsx — both must agree or the two could collide.
// Whether any stay in this request collides with something already booked.
// The booking page checks availability from a snapshot loaded when the guest
// arrived, which can be minutes old — two people can reach checkout for the
// same nights. This is the check that actually prevents a double booking,
// because it runs against the current data at the moment of payment.
// Half-open dates: a stay ending as another begins is a changeover.
function findClashes(existing, stays) {
  var out = [];
  (stays || []).forEach(function(s) {
    if (!s || !s.propertyId || !s.checkIn || !s.checkOut) return;
    (existing || []).forEach(function(b) {
      if (!b || b.status === "cancelled") return;
      var theirs = (b.stays && b.stays.length) ? b.stays : [b];
      theirs.forEach(function(o) {
        if (!o || o.propertyId !== s.propertyId || !o.checkIn || !o.checkOut) return;
        if (s.checkIn < o.checkOut && s.checkOut > o.checkIn) {
          out.push({ propertyId: s.propertyId, propertyName: s.propertyName || s.propertyId,
                     checkIn: s.checkIn, checkOut: s.checkOut });
        }
      });
    });
  });
  return out;
}

function newBookingRef(existing, prefix) {
  var taken = {};
  (existing || []).forEach(function(b) { if (b && b.id) taken[String(b.id).toUpperCase()] = true; });
  var letter = prefix || "A";
  for (var i = 0; i < 200; i++) {
    var id = letter + String(Math.floor(10000 + Math.random() * 90000));
    if (!taken[id]) return id;
  }
  return letter + String(Date.now()).slice(-8);
}

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

exports._internals = { priceBooking, quoteStay, findClashes, londonToday };
