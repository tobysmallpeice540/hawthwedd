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
// Authenticated with HBF_ADMIN_TOKEN in an x-admin-token header. The app asks
// for that key once per device and keeps it in localStorage, deliberately NOT
// in the bundle: putting it in the source would hand it to every visitor and
// undo the point of the paragraph above.
//
// Required env vars: SUPABASE_SERVICE_KEY · HBF_ADMIN_TOKEN

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_TOKEN  = process.env.HBF_ADMIN_TOKEN;
const SITE_ORIGIN  = "https://hawthbushfarm.netlify.app";

// Columns the app is allowed to write. Anything else in the payload is
// ignored rather than trusted — including qr_token, admitted and paid_at,
// which are not the app's to set.
const EVENT_COLS = [
  "slug","name","status","starts_at","ends_at","venue_name","venue_postcode",
  "description","header_image","page_image","capacity","buy_button_label",
  "hide_map","access_code","listed","show_remaining","low_threshold",
  "min_per_order","payment_mode","deposit_pence","balance_days","waitlist_on",
  "waitlist_cta","waitlist_text","waitlist_confirmation"
];
const TYPE_COLS = [
  "event_id","name","description","quantity","price_pence",
  "min_per_order","max_per_order","sort_order","hidden"
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
exports.handler = async function(event) {
  if (event.httpMethod !== "POST") return bad("Method not allowed", 405);

  var token = event.headers["x-admin-token"];
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return bad("Unauthorised", 401);

  var body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return bad("Invalid JSON"); }

  var action = body.action;

  try {
    switch (action) {

      // Used by Box Office → Settings to check a pasted key before saving it.
      case "ping":
        return ok({ ok: true });

      // ── EVENTS ─────────────────────────────────────────────────────────────
      case "events.list": {
        var events = await sbRest("box_events?select=*&order=starts_at.desc.nullslast");
        var orders = await sbRest("box_orders?select=event_id,total_qty,total_pence,deposit_pence,status,created_at,admitted");
        var types  = await sbRest("box_ticket_types?select=event_id,quantity,hidden");

        var byEvent = {};
        (orders || []).forEach(function(o) {
          var s = byEvent[o.event_id] || (byEvent[o.event_id] = { sold: 0, revenue: 0, orders: 0, admitted: 0 });
          if (!countsAsSold(o)) return;
          s.sold    += o.total_qty || 0;
          s.orders  += 1;
          s.admitted += o.admitted || 0;
          // Deposit bookings have only taken the deposit so far.
          s.revenue += (o.status === "deposit_paid") ? (o.deposit_pence || 0) : (o.total_pence || 0);
        });
        var capByEvent = {};
        (types || []).forEach(function(t) {
          if (t.hidden) return;
          capByEvent[t.event_id] = (capByEvent[t.event_id] || 0) + (t.quantity || 0);
        });

        return ok({
          events: (events || []).map(function(e) {
            var s = byEvent[e.id] || { sold: 0, revenue: 0, orders: 0, admitted: 0 };
            var issued = capByEvent[e.id] || 0;
            var cap = (e.capacity != null) ? Math.min(e.capacity, issued || e.capacity) : issued;
            return Object.assign({}, e, {
              stat_sold: s.sold, stat_revenue: s.revenue, stat_orders: s.orders,
              stat_admitted: s.admitted, stat_capacity: cap, stat_issued: issued
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
        var lines = await sbRest("box_order_lines?select=order_id,ticket_type_id,qty,unit_price_pence," +
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
          "&select=qty,unit_price_pence,ticket_type_id,box_ticket_types(name)");
        var checkins = await sbRest("box_checkins?order_id=eq." + ord.id + "&select=*&order=checked_at.desc");
        return ok({ order: ord, lines: oLines || [], checkins: checkins || [] });
      }

      // Cash, transfer and comp tickets. They go through exactly the same
      // reserve function as a card sale, so they count against capacity and
      // can't oversell the room — the band's guest list is real tickets.
      case "orders.manual": {
        var mEv = await sbRest("box_events?id=eq." + body.eventId + "&select=slug,name");
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
        var patched = await sbRest("box_orders?id=eq." + reserved.order_id, {
          method: "PATCH",
          body: { status: "paid", paid_at: nowIso, tickets_issued_at: nowIso }
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
      case "door.list": {
        var dEv = await sbRest("box_events?id=eq." + body.eventId + "&select=id,name,starts_at,venue_name,capacity");
        if (!dEv || !dEv[0]) return bad("Event not found", 404);
        var dOrders = await sbRest("box_orders?event_id=eq." + body.eventId +
          "&status=in.(paid,deposit_paid)&select=id,order_ref,first_name,last_name,email,phone,qr_token," +
          "status,total_qty,admitted,tickets_issued_at,balance_pence,source,notes&order=last_name.asc");
        var dLines = await sbRest("box_order_lines?select=order_id,qty,ticket_type_id,box_ticket_types(name)," +
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
          body: { order_id: aOrd.id, count: count, checked_by: body.by || "" }
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
          body: { order_id: uOrd.id, count: -back, checked_by: body.by || "" }
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
