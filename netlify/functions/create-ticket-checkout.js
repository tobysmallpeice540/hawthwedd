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
const ADMIN_TOKEN  = process.env.HBF_ADMIN_TOKEN;

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

// True only for "that column doesn't exist" — what Postgres/PostgREST say before
// the chef migration has been run. Any OTHER failure (a timeout, a 5xx) must not
// be mistaken for "no chef columns, so this is a Hawthbush sale": that mistake
// would charge a chef's ticket to Hawthbush's own Stripe account.
function isMissingColumn(err) {
  var m = String(err && err.message || "");
  return /42703|PGRST204|column .* does not exist/i.test(m);
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

  // Whatever the browser sent, only the ids, the counts and the answer to the
  // checkout question are carried forward. The note goes in with the line
  // rather than being written afterwards, so it lands in the same transaction
  // as the order; box_reserve_order() reads it only at the point of inserting
  // the line, and it takes no part in any decision the function makes.
  //
  // Capped at 500 characters here as well as in the browser, because the
  // browser's maxlength is a courtesy to the buyer, not a control.
  var cleanLines = lines
    .map(function(l) {
      return {
        ticket_type_id: String(l.ticket_type_id || ""),
        qty: Math.max(0, parseInt(l.qty, 10) || 0),
        note: String(l.note == null ? "" : l.note).trim().slice(0, 500)
      };
    })
    .filter(function(l) { return l.ticket_type_id && l.qty > 0; });

  if (!cleanLines.length) {
    return { statusCode: 400, body: JSON.stringify({ error: "No tickets were selected." }) };
  }

  // A missing environment variable and a genuine fault produce the same
  // shrug for the customer, which makes setup problems needlessly hard to
  // find. Name them explicitly in the log instead.
  var missing = [];
  if (!process.env.STRIPE_TICKET_SECRET_KEY) missing.push("STRIPE_TICKET_SECRET_KEY");
  if (!SERVICE_KEY) missing.push("SUPABASE_SERVICE_KEY");
  if (missing.length) {
    console.error("create-ticket-checkout NOT CONFIGURED — missing env vars: " + missing.join(", ") +
      " (set them in Netlify, then redeploy — function env is read at deploy time)");
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Ticket sales aren't switched on yet. Please get in touch and we'll sort it out." })
    };
  }

  try {
    // ── 0. Who is selling these tickets? ─────────────────────────────────────
    // Most events are Hawthbush's own and go exactly as they always have. A
    // chef-run event is different: the chef is the legal seller, so the charge
    // is made ON THE CHEF'S Stripe account (a "direct charge") and Hawthbush's
    // commission comes off it as an application fee. Getting this wrong in the
    // one direction that matters — a chef's ticket money landing in Hawthbush's
    // own account — is what every check below exists to prevent, so each one
    // refuses the sale rather than falling back to the ordinary path.
    var chef = null;   // { payeeId, account, legalName, bps } for a chef event
    var notOnSale = {
      statusCode: 503,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Tickets for this event aren't on sale just yet. Please check back soon." })
    };

    var sellerRows = null;
    try {
      sellerRows = await sbRest("box_events?slug=eq." + encodeURIComponent(slug) + "&select=payee_id,commission_bps");
    } catch (colErr) {
      // Only "the chef columns don't exist yet" means no event can be a chef
      // event. Anything else fails the sale (caught below as a 500).
      if (!isMissingColumn(colErr)) throw colErr;
      sellerRows = null;
    }
    var sellerEv = sellerRows && sellerRows[0];

    if (sellerEv && sellerEv.payee_id) {
      // A paid chef order is confirmed ONLY by the Connect webhook. Without it
      // the order would sit pending and be swept away after two hours by
      // box_expire_holds() — with the customer's money already taken. So no
      // chef ticket is sold until that webhook's secret is configured.
      if (!process.env.STRIPE_TICKET_CONNECT_WEBHOOK_SECRET) {
        console.error("create-ticket-checkout REFUSED " + slug +
          ": chef event, but STRIPE_TICKET_CONNECT_WEBHOOK_SECRET is not set — add the Connect webhook endpoint in Stripe first");
        return notOnSale;
      }
      var payeeRows = await sbRest("box_payees?id=eq." + sellerEv.payee_id +
        "&select=id,legal_name,stripe_account_id,charges_enabled,default_commission_bps");
      var payee = payeeRows && payeeRows[0];
      if (!payee || !payee.stripe_account_id || !payee.charges_enabled) {
        console.error("create-ticket-checkout REFUSED " + slug + ": chef's Stripe account is missing or not able to take charges");
        return notOnSale;
      }
      var bps = sellerEv.commission_bps != null ? sellerEv.commission_bps : payee.default_commission_bps;
      bps = Number(bps);
      if (!Number.isInteger(bps) || bps < 0 || bps >= 10000) {
        console.error("create-ticket-checkout REFUSED " + slug + ": commission " + bps + " bps is not usable");
        return notOnSale;
      }
      chef = { payeeId: payee.id, account: payee.stripe_account_id, legalName: payee.legal_name, bps: bps };

      // The buyer must be told who the seller is before paying. The public page
      // can only do that once the 2026-10-22b database change (seller_name on
      // box_public_event) has been run — until then it would show Hawthbush's
      // own terms. So no chef ticket is sold until it has.
      var pub = await sbRpc("box_public_event", { p_slug: slug, p_code: body.accessCode || null });
      if (!pub || !pub.ok || pub.gated || !pub.seller_name) {
        console.error("create-ticket-checkout REFUSED " + slug +
          ": public page cannot name the seller yet — run supabase/2026-10-22b-chef-seller-name.sql");
        return notOnSale;
      }
    }

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

    // ── 1b. Record who sold it, the fee, and the marketing answer ───────────
    // Snapshotted onto the order so that a later edit to the event can never
    // send a refund to the wrong account, and so reporting reads what actually
    // happened rather than what the settings say today.
    var payNowPence = Number(reserved.pay_now_pence) || 0;
    var feePence = 0;
    if (chef) {
      // Chef events are full payment only (the database refuses anything
      // else). If a deposit has somehow appeared, stop before any money moves.
      if (Number(reserved.deposit_pence) > 0) {
        await sbRest("box_orders?id=eq." + reserved.order_id + "&status=eq.pending", { method: "DELETE", prefer: "return=minimal" });
        console.error("create-ticket-checkout REFUSED " + slug + ": a chef event produced a deposit order");
        return notOnSale;
      }
      // VAT-inclusive commission on what is actually charged, after any
      // discount. Stripe insists the fee is above zero and below the charge.
      feePence = Math.round(payNowPence * chef.bps / 10000);
      if (feePence >= payNowPence) feePence = 0;
    }

    var optIn = body.marketingOptIn === true;
    var snapshot = { marketing_opt_in: optIn, marketing_opt_in_at: optIn ? new Date().toISOString() : null };
    if (chef) {
      snapshot.payee_id = chef.payeeId;
      snapshot.stripe_account_id = chef.account;
      snapshot.commission_bps = chef.bps;
      snapshot.application_fee_pence = feePence;
    }
    try {
      await sbRest("box_orders?id=eq." + reserved.order_id, { method: "PATCH", prefer: "return=minimal", body: snapshot });
    } catch (snapErr) {
      // For a chef order this snapshot is what routes refunds and fees, so it
      // is not optional: abandon the order rather than take money without it.
      if (chef) {
        await sbRest("box_orders?id=eq." + reserved.order_id + "&status=eq.pending", { method: "DELETE", prefer: "return=minimal" });
        throw snapErr;
      }
      // Before the migration the columns don't exist; a Hawthbush sale carries on.
      console.warn("order snapshot skipped:", snapErr.message);
    }

    // ── 2. Nothing to pay? Then don't send anyone to Stripe ─────────────────
    // A free ticket, or a discount that takes the total to nothing. Sending
    // someone to a card page that asks for no card is a pointless step, and
    // worse than pointless: the order stays `pending` until a webhook comes
    // back, and a pending order is invisible in the app and on the door, and
    // is swept away after two hours. So it is settled here and now.
    if (Number(reserved.pay_now_pence) === 0) {
      var freeNow = new Date().toISOString();
      await sbRest("box_orders?id=eq." + reserved.order_id, {
        method: "PATCH", prefer: "return=minimal",
        body: { status: "paid", paid_at: freeNow, tickets_issued_at: freeNow }
      });

      // Same confirmation email as any other paid order, QR and all.
      try {
        await fetch(SITE_ORIGIN + "/.netlify/functions/send-ticket-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: ADMIN_TOKEN, kind: "booking_confirmed", orderId: reserved.order_id })
        });
      } catch (e) {
        console.error("free ticket confirmation email failed:", e.message);
      }

      var freeOrigin = (event.headers["origin"] || SITE_ORIGIN).replace(/\/$/, "");
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: freeOrigin + "/tickets/" + encodeURIComponent(slug) +
               "?ref=" + encodeURIComponent(reserved.order_ref) +
               "&t=" + encodeURIComponent(reserved.qr_token),
          orderRef: reserved.order_ref,
          free: true
        })
      };
    }

    // ── 3. What Stripe is actually asked to take ────────────────────────────
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
            product_data: {
              name: name + " — " + ev.name,
              // For a chef event the receipt itself says who sold the ticket.
              description: fmtDateLondon(ev.starts_at) +
                (chef ? " · sold by " + chef.legalName + " · at Hawthbush Farm" : "")
            },
            unit_amount: l.unit_price_pence
          },
          quantity: l.qty
        };
      });

      // The discount goes on as its own line rather than being quietly baked
      // into the ticket price, so the receipt tells the truth about what was
      // charged and why.
      if (reserved.discount_pence > 0) {
        // On a chef event the charge lives on the chef's account, so the
        // coupon has to live there too or Stripe won't find it.
        var coupon = await stripe.coupons.create({
          amount_off: reserved.discount_pence,
          currency: "gbp",
          duration: "once",
          name: "Discount " + (body.discountCode || "").toUpperCase()
        }, chef ? { stripeAccount: chef.account } : undefined);
        discounts = [{ coupon: coupon.id }];
      }
    }

    var origin = (event.headers["origin"] || SITE_ORIGIN).replace(/\/$/, "");
    var backTo = origin + "/tickets/" + encodeURIComponent(slug);

    var sessionMeta = {
      // Its own booking type, on its own webhook endpoint, so nothing from
      // the cottage flow can ever be mistaken for a ticket order.
      bookingType: "box_ticket",
      orderId:     reserved.order_id,
      orderRef:    reserved.order_ref,
      eventSlug:   slug
    };
    var sessionParams = {
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: body.email,
      line_items: lineItems,
      discounts: discounts.length ? discounts : undefined,
      expires_at: Math.floor(Date.now() / 1000) + SESSION_MINUTES * 60,
      metadata: sessionMeta,
      success_url: backTo + "?ref=" + encodeURIComponent(reserved.order_ref) + "&t=" + encodeURIComponent(reserved.qr_token),
      cancel_url:  backTo
    };

    var session;
    if (chef) {
      // A direct charge: made on the chef's account (the Stripe-Account header
      // that `stripeAccount` sets), so the chef is the merchant of record, pays
      // Stripe's processing fee and carries any dispute. Hawthbush's commission
      // is the application fee, which Stripe moves to Hawthbush's ticketing
      // balance when the payment succeeds.
      sessionMeta.payeeId = chef.payeeId;
      sessionParams.payment_intent_data = {
        description: ev.name + " · " + reserved.order_ref + " · sold by " + chef.legalName,
        metadata: { bookingType: "box_ticket", orderId: reserved.order_id, orderRef: reserved.order_ref }
      };
      // Stripe refuses a fee of zero, so a 0% commission sends none at all.
      if (feePence > 0) sessionParams.payment_intent_data.application_fee_amount = feePence;
      session = await stripe.checkout.sessions.create(sessionParams, { stripeAccount: chef.account });
    } else {
      session = await stripe.checkout.sessions.create(sessionParams);
    }

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
    // err.type distinguishes a Stripe rejection (bad key, wrong account, API
    // version) from a Supabase or logic fault — the two need different fixes.
    console.error("create-ticket-checkout error:", err && err.type ? "[" + err.type + "] " : "",
      err && err.message ? err.message : err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Something went wrong opening the payment page. Please try again." })
    };
  }
};
