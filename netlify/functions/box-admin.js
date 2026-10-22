// netlify/functions/box-admin.js
// Everything the office does with the box office: events, ticket types,
// discount codes, orders, the door, the waitlist.
//
// It exists because the box-office tables have RLS on and no policies at all,
// so the anon key in the browser bundle can't read a single row of them. The
// buyer list — hundreds of members of the public who never signed anything —
// is therefore not one URL away from anyone who reads the JavaScript. This
// function holds the service key and is the only way in.
//
// Two ways in, and they are not equivalent:
//
//   x-admin-token: HBF_ADMIN_TOKEN     full access. The office key, entered
//                                      once per device and kept in
//                                      localStorage — deliberately not in the
//                                      bundle, which every visitor can read.
//
//   Authorization: Bearer <jwt>        a real Supabase session. The token is
//                                      verified with Supabase and the role is
//                                      read from the profiles table, so it
//                                      cannot be forged from the browser.
//
// Role decides what the action may be. Bar staff can work the door — scan a
// code, admit a head count — and reach nothing else: not the order list, not
// buyer emails, not an event's takings. That is the whole point of letting
// them in at all.
//
// Required env vars: SUPABASE_SERVICE_KEY · HBF_ADMIN_TOKEN

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_TOKEN  = process.env.HBF_ADMIN_TOKEN;
const SITE_ORIGIN  = "https://hawthbushfarm.netlify.app";

// Stripe is needed only for the chef actions (payees.invite / payees.refresh),
// and this function also runs the door, so it must never fail to LOAD because a
// key is missing. The client is built on first use instead.
//
// Ticketing's own Stripe account, never the lettings one — the same key and the
// same pinned API version as create-ticket-checkout.js, for the same reasons
// (see the long note there). Do not fall back to STRIPE_SECRET_KEY.
// The chef's onboarding link. Signed with HBF_ADMIN_TOKEN so it cannot be
// forged or pointed at a different chef, and it expires. chef-onboard.js holds
// the matching check — keep the two in step.
const crypto = require("crypto");
const ONBOARD_LINK_DAYS = 14;
function chefOnboardUrl(payeeId, expiresAt) {
  var sig = crypto.createHmac("sha256", ADMIN_TOKEN).update("chef-onboard:" + payeeId + ":" + expiresAt).digest("hex");
  return SITE_ORIGIN + "/.netlify/functions/chef-onboard?p=" + encodeURIComponent(payeeId) + "&x=" + expiresAt + "&s=" + sig;
}

var stripeClient = null;
function getStripe() {
  if (!process.env.STRIPE_TICKET_SECRET_KEY) return null;
  if (!stripeClient) {
    stripeClient = require("stripe")(process.env.STRIPE_TICKET_SECRET_KEY, { apiVersion: "2024-06-20" });
  }
  return stripeClient;
}

// Columns the app is allowed to write. Anything else in the payload is
// ignored rather than trusted — including qr_token, admitted and paid_at,
// which are not the app's to set.
const EVENT_COLS = [
  "slug","name","status","starts_at","ends_at","venue_name","venue_postcode",
  "description","header_image","page_image","capacity","buy_button_label",
  "hide_map","access_code","listed","show_remaining","low_threshold",
  "min_per_order","payment_mode","deposit_pence","balance_days","waitlist_on",
  "waitlist_cta","waitlist_text","waitlist_confirmation",
  // Who sells the tickets: null payee = Hawthbush, otherwise a chef (box_payees)
  // and an optional per-event commission override in basis points.
  "payee_id","commission_bps"
];
// What the office may edit about a chef. Deliberately NOT stripe_account_id or
// charges_enabled — those come from Stripe, never from the browser.
const PAYEE_COLS = [
  "legal_name","trading_name","entity_type","email","default_commission_bps"
];
const ENTITY_TYPES = ["sole_trader","company","other"];
const TYPE_COLS = [
  "event_id","name","description","quantity","price_pence",
  "min_per_order","max_per_order","sort_order","hidden",
  // The optional checkout question: whether to ask it, the wording, and
  // whether an answer is compulsory.
  "notes_enabled","notes_label","notes_required"
];
const CODE_COLS = ["event_id","code","kind","value"];

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

async function sendEmail(kind, payload) {
  try {
    var res = await fetch(SITE_ORIGIN + "/.netlify/functions/send-ticket-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ token: ADMIN_TOKEN, kind: kind }, payload || {}))
    });
    var out = await res.json().catch(function() { return {}; });
    return res.ok && out.ok !== false;
  } catch (e) {
    console.error("sendEmail " + kind + " failed:", e.message);
    return false;
  }
}

function pick(obj, cols) {
  var out = {};
  cols.forEach(function(c) { if (obj[c] !== undefined) out[c] = obj[c]; });
  return out;
}

function slugify(s) {
  return String(s || "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "event";
}

function ok(data)   { return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }; }
function bad(msg, code) { return { statusCode: code || 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: msg }) }; }

// Orders that count against stock: paid, deposit-paid, and pending checkouts
// started in the last 15 minutes. Cancelled orders return their stock simply
// by no longer being counted — which is the whole of "cancel and restock".
function countsAsSold(o) {
  if (o.status === "paid" || o.status === "deposit_paid") return true;
  if (o.status === "pending") return (Date.now() - new Date(o.created_at).getTime()) < 15 * 60 * 1000;
  return false;
}

// ── Handler ──────────────────────────────────────────────────────────────────
// Everything a bar login may do. Deliberately short, and deliberately not
// events.list — that carries takings per event, which is none of their
// business. door.events returns just enough to choose which door they are on.
var DOOR_ACTIONS = {
  "ping": true, "door.events": true, "door.list": true,
  "door.admit": true, "door.unadmit": true
};

function allowedFor(role, action) {
  if (role === "admin") return true;
  if (role === "bar") return DOOR_ACTIONS[action] === true;
  return false;   // cleaner has no business in the box office at all
}

// Verified sessions, held briefly in memory.
//
// Without this, every single call pays two Supabase round-trips before any
// work begins — verify the token, then read the profile. On the door that is
// per scan, with a queue of people waiting, which is the worst possible place
// to spend it. A warm function instance now answers repeat scans immediately.
//
// Keyed on the token itself, so an expired or forged one can never hit a warm
// entry belonging to somebody else. The trade is that switching an account off
// takes up to a minute to bite — short enough not to matter, and the cache is
// dropped whenever the instance is recycled anyway.
var CALLER_TTL_MS = 60 * 1000;
var callerCache = new Map();

function cacheGet(jwt) {
  var hit = callerCache.get(jwt);
  if (!hit) return null;
  if (Date.now() - hit.at > CALLER_TTL_MS) { callerCache.delete(jwt); return null; }
  return hit.caller;
}

function cachePut(jwt, caller) {
  // A long-lived instance shouldn't accumulate tokens without limit.
  if (callerCache.size > 200) callerCache.clear();
  callerCache.set(jwt, { caller: caller, at: Date.now() });
}

// Who is asking. The office key means admin. A session is verified with
// Supabase — a JWT the browser invented gets rejected here, not trusted — and
// the role comes from the profiles table rather than from anything the client
// sent.
async function resolveCaller(event) {
  var headerToken = event.headers["x-admin-token"];
  if (ADMIN_TOKEN && headerToken === ADMIN_TOKEN) {
    return { role: "admin", who: "office key" };
  }

  var auth = event.headers["authorization"] || event.headers["Authorization"] || "";
  var jwt = auth.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return null;

  var cached = cacheGet(jwt);
  if (cached) return cached;

  var res = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: { "apikey": SERVICE_KEY, "Authorization": "Bearer " + jwt }
  });
  if (!res.ok) return null;
  var user = await res.json();
  if (!user || !user.id) return null;

  var rows = await sbRest("profiles?id=eq." + user.id + "&select=role,active,name,email");
  var p = rows && rows[0];
  // A revoked account keeps its password working at Supabase but stops here.
  if (!p || p.active === false) return null;

  var caller = { role: p.role, userId: user.id, who: p.name || p.email || "signed in" };
  cachePut(jwt, caller);
  return caller;
}

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") return bad("Method not allowed", 405);

  var body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return bad("Invalid JSON"); }

  var action = body.action;

  var caller = await resolveCaller(event);
  if (!caller) return bad("Unauthorised", 401);
  if (!allowedFor(caller.role, action)) {
    return bad("Your login doesn't have access to that.", 403);
  }

  try {
    switch (action) {

      // Used by Box Office → Settings to check a pasted key before saving it.
      case "ping":
        return ok({ ok: true, role: caller.role, who: caller.who });

      // ── CHEFS (who can be the legal seller of an event) ───────────────────
      // Admin only: none of these are in DOOR_ACTIONS, so a bar login cannot
      // reach a chef's name, email or Stripe account.
      case "payees.list": {
        var payees = await sbRest("box_payees?select=*&order=legal_name.asc");
        var usedBy = await sbRest("box_events?payee_id=not.is.null&select=payee_id");
        var counts = {};
        (usedBy || []).forEach(function(r) { counts[r.payee_id] = (counts[r.payee_id] || 0) + 1; });
        return ok({
          payees: (payees || []).map(function(p) {
            return Object.assign({}, p, { event_count: counts[p.id] || 0 });
          })
        });
      }

      case "payees.save": {
        var pPayload = pick(body.payee || {}, PAYEE_COLS);
        pPayload.legal_name = String(pPayload.legal_name == null ? "" : pPayload.legal_name).trim();
        if (!pPayload.legal_name) return bad("A chef needs a legal name — it is the name tickets are sold under.");
        if (pPayload.entity_type !== undefined && ENTITY_TYPES.indexOf(pPayload.entity_type) < 0) {
          return bad("Choose sole trader, company or other.");
        }
        if (pPayload.email != null) {
          pPayload.email = String(pPayload.email).trim();
          if (pPayload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pPayload.email)) {
            return bad("That email address doesn't look right.");
          }
        }
        if (pPayload.default_commission_bps !== undefined) {
          var dBps = Number(pPayload.default_commission_bps);
          if (!Number.isInteger(dBps) || dBps < 0 || dBps > 10000) {
            return bad("The commission must be a percentage between 0 and 100.");
          }
          pPayload.default_commission_bps = dBps;
        }
        var pSaved;
        if (body.payee && body.payee.id) {
          pSaved = await sbRest("box_payees?id=eq." + body.payee.id, { method: "PATCH", body: pPayload });
        } else {
          pSaved = await sbRest("box_payees", { method: "POST", body: pPayload });
        }
        return ok({ payee: pSaved && pSaved[0] });
      }

      case "payees.delete": {
        var inUse = await sbRest("box_events?payee_id=eq." + body.id + "&select=id&limit=1");
        if (inUse && inUse.length) {
          return bad("That chef is attached to an event, so they can't be removed. Change the event's seller first.", 409);
        }
        await sbRest("box_payees?id=eq." + body.id, { method: "DELETE", prefer: "return=minimal" });
        return ok({ ok: true });
      }

      // Create the chef's connected Stripe account (once) and mint an onboarding
      // link for it. Links are single-use and short-lived, so a fresh one is
      // made every time this is called; the account itself is created only once.
      //
      // The account is created with the controller settings that match a
      // Standard account: the chef gets their own full Stripe dashboard, Stripe
      // collects whatever it needs from them, the chef pays Stripe's fees and
      // carries payment losses and disputes. That is what makes them, and not
      // Hawthbush, the seller. Do not change these to Express-style values
      // without reading claude/scope-chef-ticketing.md first — losses.payments
      // = application would put the refund and dispute risk on Hawthbush.
      case "payees.invite": {
        if (!ADMIN_TOKEN) return bad("HBF_ADMIN_TOKEN isn't set in Netlify, so a setup link can't be signed.", 500);
        // Stripe's own onboarding links work once and expire within minutes —
        // useless in an email the chef might open tomorrow. So what the office
        // sends is OUR link (chef-onboard.js), signed and good for two weeks,
        // which mints a fresh Stripe link every time it is opened. This action
        // only makes sure the chef has a Stripe account and hands that link back.
        var stripeI = getStripe();
        if (!stripeI) return bad("Ticketing's Stripe key isn't set in Netlify yet (STRIPE_TICKET_SECRET_KEY), so no link can be made.", 500);
        var iRows = await sbRest("box_payees?id=eq." + body.id + "&select=*");
        var iPayee = iRows && iRows[0];
        if (!iPayee) return bad("Chef not found", 404);

        try {
          var acctId = iPayee.stripe_account_id;
          if (!acctId) {
            var acctParams = {
              country: "GB",
              controller: {
                stripe_dashboard: { type: "full" },
                fees: { payer: "account" },
                losses: { payments: "stripe" },
                requirement_collection: "stripe"
              },
              metadata: { hbf_payee_id: iPayee.id, hbf_legal_name: iPayee.legal_name }
            };
            if (iPayee.email) acctParams.email = iPayee.email;
            if (iPayee.entity_type === "sole_trader") acctParams.business_type = "individual";
            if (iPayee.entity_type === "company") acctParams.business_type = "company";

            var newAcct = await stripeI.accounts.create(acctParams);

            // Only claim it if nobody else has in the meantime (a double click).
            // Losing that race just means using the account that won.
            var claimed = await sbRest("box_payees?id=eq." + iPayee.id + "&stripe_account_id=is.null", {
              method: "PATCH", body: { stripe_account_id: newAcct.id }
            });
            if (claimed && claimed.length) {
              acctId = newAcct.id;
            } else {
              var reread = await sbRest("box_payees?id=eq." + iPayee.id + "&select=stripe_account_id");
              acctId = reread && reread[0] && reread[0].stripe_account_id;
            }
          }

          if (!acctId) return bad("The chef's Stripe account could not be recorded. Please try again.", 500);
          var expiresAt = Math.floor(Date.now() / 1000) + ONBOARD_LINK_DAYS * 86400;
          return ok({ url: chefOnboardUrl(iPayee.id, expiresAt), expires_at: expiresAt, account: acctId });
        } catch (se) {
          console.error("payees.invite stripe error:", se && se.type ? "[" + se.type + "] " : "", se && se.message);
          return bad("Stripe said: " + (se && se.message ? se.message : "something went wrong") +
            " — if this mentions Connect, check it is switched on for the ticketing account.", 502);
        }
      }

      // Ask Stripe where the chef's setup has got to. The Connect webhook will
      // do this automatically once it is wired; until then this is the button.
      case "payees.refresh": {
        var stripeR = getStripe();
        if (!stripeR) return bad("Ticketing's Stripe key isn't set in Netlify yet (STRIPE_TICKET_SECRET_KEY).", 500);
        var rRows = await sbRest("box_payees?id=eq." + body.id + "&select=*");
        var rPayee = rRows && rRows[0];
        if (!rPayee) return bad("Chef not found", 404);
        if (!rPayee.stripe_account_id) return bad("No Stripe account has been created for this chef yet — send them an onboarding link first.", 409);
        try {
          var acctNow = await stripeR.accounts.retrieve(rPayee.stripe_account_id);
          var rSaved = await sbRest("box_payees?id=eq." + rPayee.id, {
            method: "PATCH",
            body: { charges_enabled: !!acctNow.charges_enabled, details_submitted: !!acctNow.details_submitted }
          });
          return ok({ payee: rSaved && rSaved[0] });
        } catch (se2) {
          console.error("payees.refresh stripe error:", se2 && se2.message);
          return bad("Stripe said: " + (se2 && se2.message ? se2.message : "something went wrong"), 502);
        }
      }

      // ── EVENTS ─────────────────────────────────────────────────────────────
      case "events.list": {
        var events = await sbRest("box_events?select=*&order=starts_at.desc.nullslast");
        var orders;
        try {
          orders = await sbRest("box_orders?select=event_id,total_qty,total_pence,deposit_pence,status,created_at,admitted,application_fee_pence");
        } catch (colErr) {
          // Before the chef migration there is no fee column; nothing else changes.
          orders = await sbRest("box_orders?select=event_id,total_qty,total_pence,deposit_pence,status,created_at,admitted");
        }
        var types  = await sbRest("box_ticket_types?select=event_id,quantity,hidden");

        var byEvent = {};
        (orders || []).forEach(function(o) {
          var s = byEvent[o.event_id] || (byEvent[o.event_id] = { sold: 0, revenue: 0, orders: 0, admitted: 0, commission: 0 });
          if (!countsAsSold(o)) return;
          s.sold    += o.total_qty || 0;
          s.orders  += 1;
          s.admitted += o.admitted || 0;
          // Deposit bookings have only taken the deposit so far.
          s.revenue += (o.status === "deposit_paid") ? (o.deposit_pence || 0) : (o.total_pence || 0);
          // On a chef event the takings are the CHEF's money. Hawthbush's
          // income is only the commission, which is what this adds up.
          s.commission += o.application_fee_pence || 0;
        });
        var capByEvent = {};
        (types || []).forEach(function(t) {
          if (t.hidden) return;
          capByEvent[t.event_id] = (capByEvent[t.event_id] || 0) + (t.quantity || 0);
        });

        return ok({
          events: (events || []).map(function(e) {
            var s = byEvent[e.id] || { sold: 0, revenue: 0, orders: 0, admitted: 0, commission: 0 };
            var issued = capByEvent[e.id] || 0;
            var cap = (e.capacity != null) ? Math.min(e.capacity, issued || e.capacity) : issued;
            return Object.assign({}, e, {
              stat_sold: s.sold, stat_revenue: s.revenue, stat_orders: s.orders,
              stat_admitted: s.admitted, stat_capacity: cap, stat_issued: issued,
              stat_commission: s.commission
            });
          })
        });
      }

      case "events.get": {
        var evs = await sbRest("box_events?id=eq." + body.id + "&select=*");
        var ev = evs && evs[0];
        if (!ev) return bad("Event not found", 404);
        var tts = await sbRest("box_ticket_types?event_id=eq." + ev.id + "&select=*&order=sort_order.asc,name.asc");
        var dcs = await sbRest("box_discount_codes?event_id=eq." + ev.id + "&select=*&order=code.asc");
        var wls = await sbRest("box_waitlist?event_id=eq." + ev.id + "&select=*&order=created_at.asc");
        var ords = await sbRest("box_orders?event_id=eq." + ev.id + "&select=*&order=created_at.desc");
        // Filtered through the join rather than by listing every order id in
        // the query string — a long-running event would otherwise build a URL
        // longer than anything in the chain is willing to accept.
        var lines = await sbRest("box_order_lines?select=order_id,ticket_type_id,qty,unit_price_pence,customer_note," +
          "box_orders!inner(event_id)&box_orders.event_id=eq." + ev.id);

        var sold = {};
        (ords || []).forEach(function(o) {
          if (!countsAsSold(o)) return;
          (lines || []).forEach(function(l) {
            if (l.order_id !== o.id) return;
            sold[l.ticket_type_id] = (sold[l.ticket_type_id] || 0) + (l.qty || 0);
          });
        });

        return ok({
          event: ev,
          ticket_types: (tts || []).map(function(t) {
            return Object.assign({}, t, { sold: sold[t.id] || 0, remaining: Math.max((t.quantity || 0) - (sold[t.id] || 0), 0) });
          }),
          discount_codes: dcs || [],
          waitlist: wls || [],
          orders: ords || [],
          order_lines: lines || []
        });
      }

      case "events.save": {
        var payload = pick(body.event || {}, EVENT_COLS);
        if (!payload.name) return bad("An event needs a name.");
        if (!payload.slug) payload.slug = slugify(payload.name);
        payload.slug = slugify(payload.slug);

        // ── Who sells the tickets ─────────────────────────────────────────────
        // An empty selection means Hawthbush sells, so normalise "" to null.
        if (payload.payee_id === "") payload.payee_id = null;
        if (payload.commission_bps === "") payload.commission_bps = null;
        if (payload.commission_bps != null) {
          var bps = Number(payload.commission_bps);
          if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
            return bad("The commission must be a percentage between 0 and 100.");
          }
          payload.commission_bps = bps;
        }
        // A commission on an event Hawthbush sells itself means nothing.
        if (payload.payee_id === null) payload.commission_bps = null;

        // Work out what the event WILL look like once saved, because a partial
        // payload may omit fields the rules below depend on.
        var current = null;
        if (body.event && body.event.id) {
          var curRows;
          try {
            curRows = await sbRest("box_events?id=eq." + body.event.id +
              "&select=payee_id,payment_mode,deposit_pence,status");
          } catch (colErr) {
            // The chef columns arrive with supabase/2026-10-22-chef-payees.sql.
            // Until that has been run, saving an ordinary event must keep
            // working exactly as it did, so fall back to what always existed.
            curRows = await sbRest("box_events?id=eq." + body.event.id +
              "&select=payment_mode,deposit_pence,status");
          }
          current = curRows && curRows[0];
        }
        var effPayee   = payload.payee_id !== undefined ? payload.payee_id : (current && current.payee_id) || null;
        var effMode    = payload.payment_mode !== undefined ? payload.payment_mode : (current && current.payment_mode) || "full";
        var effDeposit = payload.deposit_pence !== undefined ? Number(payload.deposit_pence) : Number(current && current.deposit_pence) || 0;

        // Once anyone has paid, who the seller is must not change under them —
        // their tickets, receipt and refund all name the original seller.
        if (current && payload.payee_id !== undefined && (payload.payee_id || null) !== (current.payee_id || null)) {
          // Includes checkouts in progress: someone on the Stripe page right now
          // would otherwise pay the old seller while their ticket names the new one.
          var paidRows = await sbRest("box_orders?event_id=eq." + body.event.id +
            "&status=in.(paid,deposit_paid,pending)&select=id&limit=1");
          if (paidRows && paidRows.length) {
            return bad("Tickets have already been sold (or someone is part-way through buying), so who sells them can't be changed. Cancel and refund those bookings first, or create a new event.");
          }
        }

        if (effPayee) {
          var payeeRows = await sbRest("box_payees?id=eq." + effPayee + "&select=id,legal_name,charges_enabled");
          var payeeRow = payeeRows && payeeRows[0];
          if (!payeeRow) return bad("That chef could not be found.", 404);

          // Chef events are full payment only. The database refuses it too.
          if (effMode === "deposit" || effDeposit > 0) {
            return bad("Events sold by a chef are full payment only — switch the payment option back to full, or choose Hawthbush Farm as the seller.");
          }
          // A chef event MAY be published before the chef's Stripe account is
          // ready (Toby's call: the page can go up early). Tickets simply can't
          // be bought until then — create-ticket-checkout.js refuses the sale
          // and the public page shows "on sale soon" in place of the button.
        }

        // Note: "setting an access code takes the event out of /whats-on" is
        // applied in the app, where the tickbox visibly moves and can be put
        // back deliberately. Doing it here would change a setting invisibly.
        var saved;
        if (body.event && body.event.id) {
          saved = await sbRest("box_events?id=eq." + body.event.id, { method: "PATCH", body: payload });
        } else {
          // A slug clash is a name clash — make it unique rather than failing.
          var existing = await sbRest("box_events?slug=eq." + encodeURIComponent(payload.slug) + "&select=id");
          if (existing && existing.length) payload.slug = payload.slug + "-" + Math.random().toString(36).slice(2, 5);
          saved = await sbRest("box_events", { method: "POST", body: payload });
        }
        return ok({ event: saved && saved[0] });
      }

      case "events.delete": {
        // Refuse if anyone has actually bought a ticket. Deleting the event
        // would take their booking with it (the foreign keys cascade), and
        // "hidden" is what's wanted here in almost every case.
        var live = await sbRest("box_orders?event_id=eq." + body.id +
          "&status=in.(paid,deposit_paid)&select=id&limit=1");
        if (live && live.length) {
          return bad("This event has tickets sold against it. Set it to hidden instead of deleting it.", 409);
        }
        await sbRest("box_events?id=eq." + body.id, { method: "DELETE", prefer: "return=minimal" });
        return ok({ ok: true });
      }

      // ── TICKET TYPES ───────────────────────────────────────────────────────
      case "types.save": {
        var tPayload = pick(body.type || {}, TYPE_COLS);
        if (!tPayload.name) return bad("A ticket type needs a name.");
        var savedType;
        if (body.type && body.type.id) {
          savedType = await sbRest("box_ticket_types?id=eq." + body.type.id, { method: "PATCH", body: tPayload });
        } else {
          savedType = await sbRest("box_ticket_types", { method: "POST", body: tPayload });
        }
        return ok({ type: savedType && savedType[0] });
      }

      case "types.delete": {
        var used = await sbRest("box_order_lines?ticket_type_id=eq." + body.id + "&select=id&limit=1");
        if (used && used.length) {
          return bad("Tickets of this type have been sold. Set the quantity to what's already gone, or hide it.", 409);
        }
        await sbRest("box_ticket_types?id=eq." + body.id, { method: "DELETE", prefer: "return=minimal" });
        return ok({ ok: true });
      }

      // ── DISCOUNT CODES ─────────────────────────────────────────────────────
      case "codes.save": {
        var cPayload = pick(body.code || {}, CODE_COLS);
        if (!cPayload.code) return bad("A discount code needs a code.");
        cPayload.code = String(cPayload.code).trim().toUpperCase();
        var savedCode;
        if (body.code && body.code.id) {
          savedCode = await sbRest("box_discount_codes?id=eq." + body.code.id, { method: "PATCH", body: cPayload });
        } else {
          savedCode = await sbRest("box_discount_codes", { method: "POST", body: cPayload });
        }
        return ok({ code: savedCode && savedCode[0] });
      }

      case "codes.delete":
        await sbRest("box_discount_codes?id=eq." + body.id, { method: "DELETE", prefer: "return=minimal" });
        return ok({ ok: true });

      // ── ORDERS ─────────────────────────────────────────────────────────────
      case "orders.list": {
        // Newest first and capped: the Orders screen is a working list, not an
        // archive, and an unbounded select gets slower every season.
        var q = "box_orders?select=*&order=created_at.desc&limit=" + (Number(body.limit) || 1000);
        if (body.eventId) q += "&event_id=eq." + body.eventId;
        if (body.status)  q += "&status=eq." + body.status;
        var list = await sbRest(q);
        return ok({ orders: list || [] });
      }

      case "orders.get": {
        var oRows = await sbRest("box_orders?id=eq." + body.id + "&select=*");
        var ord = oRows && oRows[0];
        if (!ord) return bad("Order not found", 404);
        var oLines = await sbRest("box_order_lines?order_id=eq." + ord.id +
          "&select=qty,unit_price_pence,ticket_type_id,customer_note,box_ticket_types(name)");
        var checkins = await sbRest("box_checkins?order_id=eq." + ord.id + "&select=*&order=checked_at.desc");
        return ok({ order: ord, lines: oLines || [], checkins: checkins || [] });
      }

      // Cash, transfer and comp tickets. They go through exactly the same
      // reserve function as a card sale, so they count against capacity and
      // can't oversell the room — the band's guest list is real tickets.
      case "orders.manual": {
        var mEv = await sbRest("box_events?id=eq." + body.eventId + "&select=*");
        if (!mEv || !mEv[0]) return bad("Event not found", 404);

        var reserved = await sbRpc("box_reserve_order", {
          p_slug: mEv[0].slug,
          p_access_code: "",
          p_first_name: body.first_name || "",
          p_last_name: body.last_name || "",
          p_email: body.email || "",
          p_phone: body.phone || "",
          p_lines: (body.lines || []).map(function(l) { return { ticket_type_id: l.ticket_type_id, qty: Number(l.qty) || 0 }; }),
          p_discount_code: "",
          p_source: body.source || "cash",
          p_notes: body.notes || ""
        });
        if (!reserved || !reserved.ok) return bad((reserved && reserved.message) || "Could not issue those tickets.", 409);

        // Issued by hand means paid by hand: real tickets, straight away.
        var nowIso = new Date().toISOString();
        var manualPatch = { status: "paid", paid_at: nowIso, tickets_issued_at: nowIso };
        // A hand-issued ticket on a chef event belongs to the chef's event, but
        // no card money moved, so there is no Stripe account and no fee on it.
        if (mEv[0].payee_id) manualPatch.payee_id = mEv[0].payee_id;
        var patched = await sbRest("box_orders?id=eq." + reserved.order_id, {
          method: "PATCH",
          body: manualPatch
        });

        if (body.notify !== false && body.email) {
          await sendEmail("booking_confirmed", { orderId: reserved.order_id });
        }
        return ok({ order: patched && patched[0], order_ref: reserved.order_ref });
      }

      // Money taken by hand against an existing booking — a balance settled on
      // the door, or a bank transfer that has landed. Clearing it is what
      // issues the tickets, and the QR appears immediately.
      case "orders.markPaid": {
        var pRows = await sbRest("box_orders?id=eq." + body.id + "&select=*");
        var pOrd = pRows && pRows[0];
        if (!pOrd) return bad("Order not found", 404);
        var pNow = new Date().toISOString();
        var wasUnissued = !pOrd.tickets_issued_at;
        var updated = await sbRest("box_orders?id=eq." + pOrd.id, {
          method: "PATCH",
          body: {
            status: "paid",
            paid_at: pOrd.paid_at || pNow,
            balance_paid_at: Number(pOrd.balance_pence) > 0 ? pNow : pOrd.balance_paid_at,
            balance_pence: 0,
            tickets_issued_at: pOrd.tickets_issued_at || pNow,
            notes: (pOrd.notes ? pOrd.notes + "\n" : "") + "Marked paid in the app on " + pNow.slice(0, 10) +
              (body.method ? " (" + body.method + ")" : "")
          }
        });
        if (body.notify !== false && pOrd.email && wasUnissued) {
          await sendEmail("tickets_issued", { orderId: pOrd.id });
        }
        return ok({ order: updated && updated[0] });
      }

      // Cancelling voids the tickets and returns the stock — the stock comes
      // back on its own, because a cancelled order simply stops being counted.
      // The money goes back through the Stripe dashboard; the app deep-links
      // to the payment rather than moving real money from here.
      case "orders.cancel": {
        var cRows = await sbRest("box_orders?id=eq." + body.id + "&select=*");
        var cOrd = cRows && cRows[0];
        if (!cOrd) return bad("Order not found", 404);
        var cUpdated = await sbRest("box_orders?id=eq." + cOrd.id, {
          method: "PATCH",
          body: {
            status: "cancelled",
            tickets_issued_at: null,
            notes: (cOrd.notes ? cOrd.notes + "\n" : "") + "Cancelled in the app on " + new Date().toISOString().slice(0, 10) +
              (body.reason ? ": " + body.reason : "")
          }
        });
        if (body.notify !== false && cOrd.email) {
          await sendEmail("booking_cancelled", { orderId: cOrd.id });
        }
        return ok({ order: cUpdated && cUpdated[0] });
      }

      // Refund a chef order and cancel it, in one step.
      //
      // Hawthbush's own orders are still refunded in Hawthbush's Stripe
      // dashboard — the deliberate choice made when the box office was built.
      // A chef order cannot be: the payment sits on the chef's account, where
      // Hawthbush's dashboard link finds nothing. So for those the app does it,
      // with refund_application_fee so Hawthbush's commission goes back too
      // (Toby's rule: no commission on a refunded ticket).
      //
      // Order of work matters. The booking is marked refunded BEFORE Stripe is
      // asked, so that when Stripe's charge.refunded event reaches the webhook
      // it sees the app has already dealt with it and sends no second email. If
      // Stripe then refuses, the booking is put back exactly as it was.
      case "orders.refund": {
        var stripeF = getStripe();
        if (!stripeF) return bad("Ticketing's Stripe key isn't set in Netlify (STRIPE_TICKET_SECRET_KEY).", 500);
        var fRows = await sbRest("box_orders?id=eq." + body.id + "&select=*");
        var fOrd = fRows && fRows[0];
        if (!fOrd) return bad("Order not found", 404);
        if (!fOrd.stripe_account_id) {
          return bad(fOrd.payee_id
            ? "This ticket was issued by hand, so no card payment was taken through Stripe. Use Cancel instead."
            : "This booking was paid to Hawthbush Farm, so it is refunded in Stripe as before — use the Stripe link on the row, then Cancel.", 409);
        }
        if (fOrd.status !== "paid") return bad("Only a paid booking can be refunded.", 409);

        var prior = { status: fOrd.status, tickets_issued_at: fOrd.tickets_issued_at, notes: fOrd.notes };
        var fToday = new Date().toISOString().slice(0, 10);
        // Conditional on still being paid, so two presses (or two people) can't
        // both get past this point: the second finds nothing to update.
        var claimedRefund = await sbRest("box_orders?id=eq." + fOrd.id + "&status=eq.paid", {
          method: "PATCH",
          body: {
            status: "refunded",
            tickets_issued_at: null,
            notes: (fOrd.notes ? fOrd.notes + "\n" : "") + "Refunded in full in the app on " + fToday +
              " by " + caller.who + (body.reason ? ": " + body.reason : "") + " — commission returned."
          }
        });
        if (!claimedRefund || !claimedRefund.length) return bad("That booking is already being refunded.", 409);

        var piId = fOrd.stripe_payment_intent_id;
        try {
          if (!piId && fOrd.stripe_session_id) {
            var fSess = await stripeF.checkout.sessions.retrieve(fOrd.stripe_session_id, {}, { stripeAccount: fOrd.stripe_account_id });
            piId = typeof fSess.payment_intent === "string" ? fSess.payment_intent : (fSess.payment_intent && fSess.payment_intent.id);
          }
          if (piId) {
            // A fresh key per attempt: Stripe remembers a failed request
            // against its key for a day, and a remembered failure would block
            // every retry. Double-refunding is prevented above instead, by the
            // conditional update that only one request can win.
            await stripeF.refunds.create({
              payment_intent: piId,
              refund_application_fee: true,
              metadata: { orderRef: fOrd.order_ref, by: String(caller.who || "") }
            }, { stripeAccount: fOrd.stripe_account_id, idempotencyKey: "hbf-refund-" + fOrd.id + "-" + Date.now() });
          }
          // No payment intent means nothing was charged (a free ticket), so
          // cancelling is all there is to do.
        } catch (re) {
          // Before undoing anything, find out what is actually true in Stripe.
          // The chef may already have refunded it from their dashboard, or the
          // refund may have gone through and only the reply been lost. Either
          // way the money is back with the buyer, so the booking stays refunded
          // — and the commission is put right here rather than left to chance.
          var alreadyBack = false;
          try {
            if (piId) {
              var piNow = await stripeF.paymentIntents.retrieve(piId, { expand: ["latest_charge"] }, { stripeAccount: fOrd.stripe_account_id });
              var ch = piNow && piNow.latest_charge;
              alreadyBack = !!(ch && typeof ch === "object" && ch.refunded);
              if (alreadyBack && ch.application_fee) {
                var feeIdR = typeof ch.application_fee === "string" ? ch.application_fee : ch.application_fee.id;
                var feeR = await stripeF.applicationFees.retrieve(feeIdR);
                var owedR = feeR.amount - (feeR.amount_refunded || 0);
                if (owedR > 0) {
                  await stripeF.applicationFees.createRefund(feeIdR, { amount: owedR, metadata: { reason: "ticket refunded", charge: ch.id } },
                    { idempotencyKey: "hbf-fee-refund-" + ch.id + "-full" });
                }
              }
            }
          } catch (checkErr) {
            console.error("orders.refund could not confirm Stripe state:", checkErr && checkErr.message);
          }
          if (!alreadyBack) {
            await sbRest("box_orders?id=eq." + fOrd.id, { method: "PATCH", prefer: "return=minimal", body: prior });
            console.error("orders.refund stripe error:", re && re.type ? "[" + re.type + "] " : "", re && re.message);
            return bad("Stripe didn't make the refund, so nothing has changed: " + (re && re.message ? re.message : "unknown error"), 502);
          }
          console.warn("orders.refund: " + fOrd.order_ref + " was already refunded in Stripe — recorded as refunded");
        }

        var emailed = false;
        if (body.notify !== false && fOrd.email) emailed = await sendEmail("booking_cancelled", { orderId: fOrd.id });
        return ok({ ok: true, emailed: emailed });
      }

      // The balance email by hand. box-billing.js still sends it automatically
      // on the due date and chases once after — this is for the times a human
      // wants to prompt someone now, without waiting for the schedule.
      // force:true because the automatic one may already have gone.
      case "orders.sendBalance": {
        var bRows = await sbRest("box_orders?id=eq." + body.id + "&select=*");
        var bOrd = bRows && bRows[0];
        if (!bOrd) return bad("Order not found", 404);
        if (!bOrd.email) return bad("That booking has no email address.", 409);
        if (Number(bOrd.balance_pence) <= 0 || bOrd.balance_paid_at) {
          return bad("There's nothing outstanding on that booking.", 409);
        }

        // Mint a fresh payment link rather than reusing an old one — Stripe
        // sessions expire, and a dead link in a chase email is worse than none.
        var payLink = "";
        try {
          var plRes = await fetch(SITE_ORIGIN + "/.netlify/functions/pay-balance", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: bOrd.qr_token })
          });
          var plOut = await plRes.json();
          if (!plRes.ok || !plOut.url) return bad(plOut.error || "Could not create a payment link.", 502);
          payLink = plOut.url;
        } catch (e) {
          return bad("Could not create a payment link: " + e.message, 502);
        }

        var sentBal = await sendEmail(body.kind === "overdue" ? "balance_overdue" : "balance_due",
          { orderId: bOrd.id, payLink: payLink, force: true });
        if (!sentBal) return bad("The email could not be sent — check the Resend key.", 502);
        return ok({ ok: true, payLink: payLink });
      }

      case "orders.resend": {
        var sent = await sendEmail(body.kind || "booking_confirmed", { orderId: body.id, force: true });
        return sent ? ok({ ok: true }) : bad("The email could not be sent — check the Resend key.", 502);
      }

      // ── THE DOOR ───────────────────────────────────────────────────────────
      // The whole guest list in one response, on purpose: the scanner keeps
      // working when the barn wifi drops, which it does.
      // Just enough to choose a door: no takings, no order counts, no buyers.
      case "door.events": {
        var dEvents = await sbRest("box_events?status=neq.draft&select=id,name,starts_at,venue_name&order=starts_at.desc.nullslast&limit=50");
        return ok({ events: dEvents || [] });
      }

      case "door.list": {
        var dEv = await sbRest("box_events?id=eq." + body.eventId + "&select=id,name,starts_at,venue_name,capacity");
        if (!dEv || !dEv[0]) return bad("Event not found", 404);
        var dOrders = await sbRest("box_orders?event_id=eq." + body.eventId +
          "&status=in.(paid,deposit_paid)&select=id,order_ref,first_name,last_name,email,phone,qr_token," +
          "status,total_qty,admitted,tickets_issued_at,balance_pence,source,notes&order=last_name.asc");
        var dLines = await sbRest("box_order_lines?select=order_id,qty,ticket_type_id,customer_note,box_ticket_types(name)," +
          "box_orders!inner(event_id)&box_orders.event_id=eq." + body.eventId);
        var lastScan = await sbRest("box_checkins?select=order_id,checked_at,count," +
          "box_orders!inner(event_id)&box_orders.event_id=eq." + body.eventId + "&order=checked_at.desc");
        return ok({ event: dEv[0], orders: dOrders || [], lines: dLines || [], checkins: lastScan || [] });
      }

      // One scan admits a head count, not a ticket. A group arriving in three
      // cars scans the same code three times; every scan is logged with what
      // it let in, and box_orders.admitted is the running tally.
      case "door.admit": {
        var aRows = body.token
          ? await sbRest("box_orders?qr_token=eq." + encodeURIComponent(body.token) + "&select=*")
          : await sbRest("box_orders?id=eq." + body.orderId + "&select=*");
        var aOrd = aRows && aRows[0];
        if (!aOrd) return ok({ ok: false, reason: "not_found" });
        if (body.eventId && aOrd.event_id !== body.eventId) return ok({ ok: false, reason: "wrong_event", order: aOrd });
        if (aOrd.status === "cancelled" || aOrd.status === "refunded") return ok({ ok: false, reason: "cancelled", order: aOrd });
        if (!aOrd.tickets_issued_at) return ok({ ok: false, reason: "not_issued", order: aOrd });

        var count = Math.max(0, parseInt(body.count, 10) || 0);
        var room  = Math.max((aOrd.total_qty || 0) - (aOrd.admitted || 0), 0);
        if (count === 0) return ok({ ok: true, order: aOrd, admittedNow: 0, reason: "lookup" });
        if (count > room) return ok({ ok: false, reason: "no_room", order: aOrd, room: room });

        var newAdmitted = (aOrd.admitted || 0) + count;
        var aUpdated = await sbRest("box_orders?id=eq." + aOrd.id, {
          method: "PATCH", body: { admitted: newAdmitted }
        });
        await sbRest("box_checkins", {
          method: "POST", prefer: "return=minimal",
          body: { order_id: aOrd.id, count: count, checked_by: body.by || caller.who || "" }
        });
        return ok({ ok: true, order: (aUpdated && aUpdated[0]) || aOrd, admittedNow: count });
      }

      // Someone waved through by mistake. Logged as a negative check-in
      // rather than quietly edited, so the scan log stays true.
      case "door.unadmit": {
        var uRows = await sbRest("box_orders?id=eq." + body.orderId + "&select=*");
        var uOrd = uRows && uRows[0];
        if (!uOrd) return bad("Order not found", 404);
        var back = Math.min(Math.max(parseInt(body.count, 10) || 1, 1), uOrd.admitted || 0);
        if (!back) return ok({ order: uOrd });
        var uUpdated = await sbRest("box_orders?id=eq." + uOrd.id, {
          method: "PATCH", body: { admitted: (uOrd.admitted || 0) - back }
        });
        await sbRest("box_checkins", {
          method: "POST", prefer: "return=minimal",
          body: { order_id: uOrd.id, count: -back, checked_by: body.by || caller.who || "" }
        });
        return ok({ order: uUpdated && uUpdated[0] });
      }

      // ── WAITLIST ───────────────────────────────────────────────────────────
      case "waitlist.list": {
        var wl = await sbRest("box_waitlist?event_id=eq." + body.eventId + "&select=*&order=created_at.asc");
        return ok({ waitlist: wl || [] });
      }

      // Everyone gets the same email at the same time with the same link. Who
      // actually ends up with the tickets is then settled by the reserve
      // function, which is the only fair way to do it.
      case "waitlist.release": {
        var rEv = await sbRest("box_events?id=eq." + body.eventId + "&select=id,name,slug");
        if (!rEv || !rEv[0]) return bad("Event not found", 404);
        var waiting = await sbRest("box_waitlist?event_id=eq." + body.eventId +
          "&notified_at=is.null&converted=is.false&select=*&order=created_at.asc");
        var sentTo = 0;
        for (var i = 0; i < (waiting || []).length; i++) {
          var w = waiting[i];
          var okSent = await sendEmail("tickets_released", { eventId: rEv[0].id, to: w.email, name: w.name });
          if (okSent) {
            sentTo++;
            await sbRest("box_waitlist?id=eq." + w.id, {
              method: "PATCH", prefer: "return=minimal", body: { notified_at: new Date().toISOString() }
            });
          }
        }
        return ok({ sent: sentTo, total: (waiting || []).length });
      }

      case "waitlist.delete":
        await sbRest("box_waitlist?id=eq." + body.id, { method: "DELETE", prefer: "return=minimal" });
        return ok({ ok: true });

      // Runs the Brevo sync on demand. The hourly shim calls the same worker
      // with the same token, so the button and the clock do the same thing.
      case "brevo.sync": {
        var bres = await fetch(SITE_ORIGIN + "/.netlify/functions/brevo-sync", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN }
        });
        var bout = await bres.json().catch(function() { return {}; });
        if (!bres.ok) return bad(bout.error || "The Brevo sync failed.", 502);
        return ok(bout);
      }

      // ── SALES SUMMARY ──────────────────────────────────────────────────────
      case "summary": {
        var sOrders = await sbRest("box_orders?event_id=eq." + body.eventId + "&select=*");
        var sLines = await sbRest("box_order_lines?select=order_id,qty,unit_price_pence,ticket_type_id," +
          "box_ticket_types(name),box_orders!inner(event_id)&box_orders.event_id=eq." + body.eventId);
        var live = (sOrders || []).filter(countsAsSold);
        var liveIds = {};
        live.forEach(function(o) { liveIds[o.id] = o; });

        var byType = {};
        (sLines || []).forEach(function(l) {
          if (!liveIds[l.order_id]) return;
          var name = (l.box_ticket_types && l.box_ticket_types.name) || "Ticket";
          var row = byType[name] || (byType[name] = { name: name, qty: 0, gross_pence: 0 });
          row.qty += l.qty || 0;
          row.gross_pence += (l.qty || 0) * (l.unit_price_pence || 0);
        });

        return ok({
          orders:      live.length,
          tickets:     live.reduce(function(a, o) { return a + (o.total_qty || 0); }, 0),
          admitted:    live.reduce(function(a, o) { return a + (o.admitted || 0); }, 0),
          taken_pence: live.reduce(function(a, o) { return a + (o.status === "deposit_paid" ? (o.deposit_pence || 0) : (o.total_pence || 0)); }, 0),
          due_pence:   live.reduce(function(a, o) { return a + (o.status === "deposit_paid" ? (o.balance_pence || 0) : 0); }, 0),
          discount_pence: live.reduce(function(a, o) { return a + (o.discount_pence || 0); }, 0),
          // Chef events: what Hawthbush actually earned (VAT-inclusive), as
          // opposed to taken_pence, which is the chef's takings.
          commission_pence: live.reduce(function(a, o) { return a + (o.application_fee_pence || 0); }, 0),
          chef_event:  live.some(function(o) { return !!o.payee_id; }),
          by_type:     Object.keys(byType).map(function(k) { return byType[k]; }),
          by_source:   ["stripe", "cash", "transfer", "comp"].map(function(src) {
            var rows = live.filter(function(o) { return o.source === src; });
            return { source: src, orders: rows.length, tickets: rows.reduce(function(a, o) { return a + (o.total_qty || 0); }, 0) };
          })
        });
      }

      // Every booking with money still outstanding. Nothing here ever
      // auto-cancels: software shouldn't cancel someone's Christmas because
      // they were on holiday when the chase went out.
      case "balances.due": {
        var due = await sbRest("box_orders?status=eq.deposit_paid&balance_pence=gt.0&select=*&order=balance_due_on.asc");
        var dueEvents = await sbRest("box_events?select=id,name,slug,starts_at");
        return ok({ orders: due || [], events: dueEvents || [] });
      }

      default:
        return bad("Unknown action: " + action);
    }

  } catch (err) {
    console.error("box-admin error:", action, err);
    return bad(String(err.message || err), 500);
  }
};
