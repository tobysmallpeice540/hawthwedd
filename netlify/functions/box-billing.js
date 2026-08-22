// netlify/functions/box-billing.js
// Scheduled daily (see netlify.toml). The same shape as
// send-accom-reminders.js — wake up, find what's fallen due, mint a Stripe
// link, send a templated email, and mark what was sent so a retry can't
// double-send — pointed at the box office instead of the cottages.
//
// Three jobs, in this order:
//   1. Balance due      — on the due date, with a payment link
//   2. Balance overdue  — ONE chase, Y days after the due date
//   3. Event reminder   — Z days before the event, tickets attached again
//
// What it deliberately does NOT do is cancel anything. A booking still unpaid
// after the chase turns up in a red "Balance overdue" list in the app for a
// human to deal with. Software shouldn't cancel someone's Christmas because
// they were on holiday when the chase went out.
//
// Required env vars: SUPABASE_SERVICE_KEY · HBF_ADMIN_TOKEN

const SUPABASE_URL  = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_TOKEN   = process.env.HBF_ADMIN_TOKEN;
const SITE_ORIGIN   = "https://hawthbushfarm.netlify.app";
const TEMPLATES_KEY = "hbf_box_templates_v1";

// House defaults, used until Box Office → Settings has been saved once.
const DEFAULT_CHASE_DAYS    = 3;   // after the due date
const DEFAULT_REMINDER_DAYS = 2;   // before the event

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

async function sbGet(key) {
  var rows = await sbRest("app_data?key=eq." + key + "&select=value");
  return (rows && rows[0]) ? rows[0].value : null;
}

// Today in London, which is the only calendar this business runs on.
function todayLondon() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" }); // YYYY-MM-DD
}

function daysBetween(aIso, bIso) {
  return Math.round((new Date(bIso + "T00:00:00Z") - new Date(aIso + "T00:00:00Z")) / 86400000);
}

function eventDateLondon(ts) {
  if (!ts) return null;
  var d = new Date(ts);
  if (isNaN(d)) return null;
  return d.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

async function payLinkFor(order) {
  try {
    var res = await fetch(SITE_ORIGIN + "/.netlify/functions/pay-balance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: order.qr_token })
    });
    if (!res.ok) { console.error("pay-balance failed for " + order.order_ref + ":", await res.text()); return ""; }
    var out = await res.json();
    return out.url || "";
  } catch (e) {
    console.error("pay-balance threw for " + order.order_ref + ":", e.message);
    return "";
  }
}

async function sendEmail(kind, orderId, payLink) {
  try {
    var res = await fetch(SITE_ORIGIN + "/.netlify/functions/send-ticket-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: ADMIN_TOKEN, kind: kind, orderId: orderId, payLink: payLink || "" })
    });
    if (!res.ok) { console.error("send-ticket-email " + kind + " failed:", await res.text()); return false; }
    var out = await res.json();
    return !!out.ok;
  } catch (e) {
    console.error("send-ticket-email " + kind + " threw:", e.message);
    return false;
  }
}

function triggerDaysFor(templates, id, fallback) {
  var t = (templates || []).find(function(x) { return x.id === id; });
  var v = t && t.triggerDays;
  return (v === 0 || v) ? Number(v) : fallback;
}

exports.handler = async function() {
  var today = todayLondon();
  console.log("[box-billing] Running for " + today);

  var sent = { balance_due: 0, balance_overdue: 0, event_reminder: 0 };
  var errors = [];

  try {
    var templates    = (await sbGet(TEMPLATES_KEY)) || [];
    var chaseDays    = triggerDaysFor(templates, "balance_overdue", DEFAULT_CHASE_DAYS);
    var reminderDays = triggerDaysFor(templates, "event_reminder", DEFAULT_REMINDER_DAYS);

    var events = await sbRest("box_events?select=id,name,slug,starts_at,status");
    var eventById = {};
    (events || []).forEach(function(e) { eventById[e.id] = e; });

    // ── 1 & 2. Balances ─────────────────────────────────────────────────────
    var owing = await sbRest("box_orders?status=eq.deposit_paid&balance_pence=gt.0&select=*");

    for (var i = 0; i < (owing || []).length; i++) {
      var o = owing[i];
      var ev = eventById[o.event_id];
      if (!ev || !o.email || !o.balance_due_on) continue;

      // Nothing chased for an event that has already happened — at that point
      // it's a conversation, not an email.
      var evDate = eventDateLondon(ev.starts_at);
      if (evDate && evDate < today) continue;

      var flags = o.email_flags || {};
      var dueIn = daysBetween(today, String(o.balance_due_on).slice(0, 10)); // +ve = still to come

      try {
        if (!flags.balanceDueSent && dueIn <= 0) {
          var link = await payLinkFor(o);
          if (await sendEmail("balance_due", o.id, link)) sent.balance_due++;
        } else if (flags.balanceDueSent && !o.chased_at && !flags.balanceOverdueSent && dueIn <= -chaseDays) {
          var chaseLink = await payLinkFor(o);
          if (await sendEmail("balance_overdue", o.id, chaseLink)) {
            sent.balance_overdue++;
            // chased_at is what makes this the single chase it's meant to be.
            await sbRest("box_orders?id=eq." + o.id, {
              method: "PATCH", prefer: "return=minimal",
              body: { chased_at: new Date().toISOString() }
            });
          }
        }
      } catch (e) {
        errors.push(o.order_ref + ": " + e.message);
      }
    }

    // ── 3. Event reminders ──────────────────────────────────────────────────
    var upcoming = (events || []).filter(function(e) {
      if (e.status !== "published") return false;
      var d = eventDateLondon(e.starts_at);
      return d && daysBetween(today, d) === reminderDays;
    });

    for (var j = 0; j < upcoming.length; j++) {
      var ue = upcoming[j];
      var holders = await sbRest("box_orders?event_id=eq." + ue.id +
        "&status=eq.paid&tickets_issued_at=not.is.null&select=*");
      for (var k = 0; k < (holders || []).length; k++) {
        var h = holders[k];
        if (!h.email) continue;
        var hFlags = h.email_flags || {};
        if (hFlags.eventReminderSent) continue;
        try {
          if (await sendEmail("event_reminder", h.id)) sent.event_reminder++;
        } catch (e) {
          errors.push(h.order_ref + ": " + e.message);
        }
      }
    }

    console.log("[box-billing] sent", JSON.stringify(sent), errors.length ? "errors: " + errors.join(" | ") : "");
    return { statusCode: 200, body: JSON.stringify({ ok: true, today: today, sent: sent, errors: errors }) };

  } catch (err) {
    console.error("box-billing error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
