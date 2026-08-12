// netlify/functions/send-cleaning-summary.js
//
// Emails the next fortnight of housekeeping — check-outs, check-ins,
// changeovers and farm events — to whoever is set up in
// Settings → Weekly cleaning summary.
//
// Scheduled from netlify.toml at 02:00 and 03:00 UTC and sends only when it is
// 3am in London. Netlify cron is UTC-only, so a single "0 3 * * *" would
// arrive at 4am through British Summer Time. Firing on both hours and checking
// the London clock lands it at 3am local all year, and the guard below makes
// the second run a no-op.
//
// Can also be POSTed to with { force: true } from the app to send one on the
// spot, which is what the "Send one now" button does.
//
// Required env var: RESEND_API_KEY

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJrcWJ5aXNmbXZ3dWxzeXh6d2p6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NTI0MzgsImV4cCI6MjA5NjUyODQzOH0._CsyhvFrtHFC0KrfiLzbrLUaKcvxtbWlHydaH20tvfo";
const RESEND_KEY   = process.env.RESEND_API_KEY;
const FROM_EMAIL   = "hello@hawthbushfarm.co.uk";

const CONFIG_KEY   = "hbf_cleaning_email_v1";
const ACCOM_KEY    = "hbf_accom_v1";
const PROPS_KEY    = "hbf_properties_v1";
const EVENTS_KEY   = "hawthbush_bookings_v6";
const EMAIL_LOG_KEY = "hbf_email_log_v1";
const SITE_ORIGIN  = "https://hawthbushfarm.netlify.app";

const DAYS_AHEAD = 14;

function jsonResponse(statusCode, body) {
  return { statusCode: statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function sbGet(key) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data?key=eq." + key + "&select=value", {
    headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY }
  });
  if (!res.ok) throw new Error("sbGet " + key + " failed: " + await res.text());
  const rows = await res.json();
  return (rows && rows[0]) ? rows[0].value : null;
}

async function sbSet(key, value) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data", {
    method: "POST",
    headers: {
      "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates"
    },
    body: JSON.stringify({ key: key, value: value })
  });
  if (!res.ok) throw new Error("sbSet " + key + " failed: " + await res.text());
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── London clock ─────────────────────────────────────────────────────────────
// Intl is the only reliable way to get British local time on a UTC server —
// hard-coding a BST offset breaks twice a year.
function londonParts(now) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", weekday: "short", hour: "numeric", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit"
  });
  const parts = {};
  fmt.formatToParts(now).forEach(function(p) { parts[p.type] = p.value; });
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    hour: parseInt(parts.hour, 10),
    weekday: dayMap[parts.weekday],
    date: parts.year + "-" + parts.month + "-" + parts.day
  };
}

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmtLong(iso) {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

function eventTypeLabel(ev) {
  return String(ev.eventType || "Event").replace(/\s*\(.*\)\s*$/, "").trim() || "Event";
}

// ── The fortnight, grouped by day ────────────────────────────────────────────
// Mirrors CleanerHome in App.jsx — the emailed version and the on-screen
// version must agree, or one of them is wrong.
function buildDays(properties, accom, events, from) {
  const to = addDays(from, DAYS_AHEAD);
  const propOf = function(id) {
    return (properties || []).find(function(x) { return x.id === id; }) || null;
  };
  const propName = function(id) {
    const p = propOf(id);
    return p ? p.name : id;
  };
  // Rows sort by position in the configured property list — Hamlet, Amly,
  // Glamping — so every day reads the same way round. Events come after.
  const propRank = function(id) {
    const i = (properties || []).findIndex(function(x) { return x.id === id; });
    return i === -1 ? 900 : i;
  };

  const byDay = {};
  const add = function(date, item) {
    if (!date || date < from || date > to) return;
    if (!byDay[date]) byDay[date] = [];
    byDay[date].push(item);
  };

  (events || []).forEach(function(ev) {
    if (!ev || typeof ev.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) return;
    if (ev.status === "Cancelled") return;
    add(ev.date, {
      kind: "event", rank: 999, time: "",
      label: "Grain Store",
      detail: (ev.couple || "Event") + " · " + eventTypeLabel(ev)
    });
  });

  (accom || []).forEach(function(b) {
    if (!b || b.status === "cancelled" || b.bookingType === "Blocked") return;
    const stays = (b.stays && b.stays.length) ? b.stays : [b];
    const wedding = b.bookingType === "Wedding";
    stays.forEach(function(s) {
      if (!s) return;
      const p = propOf(s.propertyId);
      const who = b.guestName || "Guest";
      const guests = b.guestCount ? b.guestCount + " guest" + (Number(b.guestCount) === 1 ? "" : "s") : "";
      const detail = who + (guests ? " · " + guests : "");
      // Wedding parties get earlier access and a later checkout.
      const inTime  = p ? (wedding ? p.checkInFromWedding : p.checkInFrom) : "";
      const outTime = p ? (wedding ? p.checkOutByWedding  : p.checkOutBy)  : "";
      add(s.checkOut, { kind: "out", rank: propRank(s.propertyId), label: propName(s.propertyId), time: outTime || "", detail: detail });
      add(s.checkIn,  { kind: "in",  rank: propRank(s.propertyId), label: propName(s.propertyId), time: inTime  || "", detail: detail });
    });
  });

  return { byDay: byDay, from: from, to: to, days: Object.keys(byDay).sort() };
}

const KIND_STYLE = {
  out:   { text: "Check-out",  bg: "#fff7ed", fg: "#9a3412", bd: "#fdba74", order: 0 },
  in:    { text: "Check-in",   bg: "#f0fdf4", fg: "#166534", bd: "#bbf7d0", order: 1 },
  event: { text: "Farm event", bg: "#eef4fd", fg: "#1e4d8c", bd: "#bfdbfe", order: 2 }
};

function buildHtml(model) {
  const B = { bg: "#f9f6f1", panel: "#fff", text: "#2d2a25", muted: "#7a7060", border: "#e8e2d9" };
  const logo = "https://images.squarespace-cdn.com/content/v1/6897aa6fe61ae2143f465ab1/1754770036281-I54E64T6O6J1YLVL9KYF/logo.png?format=400w";

  let inner = '<p style="margin:0 0 6px;font-family:Georgia,serif;font-size:20px;color:' + B.text + '">Housekeeping &mdash; the next ' + DAYS_AHEAD + ' days</p>';
  inner += '<p style="margin:0 0 20px;font-size:13px;color:' + B.muted + '">' + escapeHtml(fmtLong(model.from)) + ' to ' + escapeHtml(fmtLong(model.to)) + '</p>';

  if (!model.days.length) {
    inner += '<p style="margin:0;font-size:15px;color:' + B.muted + '">Nothing booked in this period.</p>';
  }

  model.days.forEach(function(d) {
    const items = model.byDay[d].slice().sort(function(a, z) {
      if (a.rank !== z.rank) return a.rank - z.rank;
      return KIND_STYLE[a.kind].order - KIND_STYLE[z.kind].order;
    });
    const outs = items.filter(function(i) { return i.kind === "out"; }).map(function(i) { return i.label; });
    const changeovers = items.filter(function(i) { return i.kind === "in" && outs.indexOf(i.label) !== -1; })
                             .map(function(i) { return i.label; });

    inner += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
      'style="border:1px solid ' + B.border + ';border-radius:9px;margin-bottom:10px"><tr><td style="padding:12px 15px">';
    inner += '<div style="font-size:14px;font-weight:bold;color:' + B.text + ';margin-bottom:2px">' + escapeHtml(fmtLong(d)) + '</div>';
    if (changeovers.length) {
      inner += '<div style="font-size:11px;font-weight:bold;color:#dc2626;margin-bottom:6px">Changeover: ' +
        escapeHtml(changeovers.join(", ")) + '</div>';
    }
    items.forEach(function(it) {
      const k = KIND_STYLE[it.kind];
      inner += '<div style="padding:3px 0;font-size:13px;color:' + B.text + '">' +
        '<span style="display:inline-block;font-size:10px;font-weight:bold;padding:2px 8px;border-radius:9px;' +
        'background:' + k.bg + ';color:' + k.fg + ';border:1px solid ' + k.bd + '">' + k.text + '</span> ' +
        '<strong>' + escapeHtml(it.label) + '</strong> ' +
        (it.time ? '<strong style="color:#b8860b">' + escapeHtml(it.time) + '</strong> ' : '') +
        '<span style="color:' + B.muted + '">' + escapeHtml(it.detail) + '</span></div>';
    });
    inner += '</td></tr></table>';
  });

  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Housekeeping</title></head>' +
    '<body style="margin:0;padding:0;background:' + B.bg + '">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + B.bg + ';padding:26px 12px">' +
    '<tr><td align="center"><table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;width:100%">' +
    '<tr><td align="center" style="padding:0 0 20px"><img src="' + logo + '" alt="Hawthbush Farm" width="90" style="display:block;border:0;width:90px;height:auto"></td></tr>' +
    '<tr><td style="background:' + B.panel + ';border:1px solid ' + B.border + ';border-radius:14px;padding:26px 28px;font-family:Helvetica,Arial,sans-serif">' + inner + '</td></tr>' +
    '<tr><td align="center" style="padding:18px 16px 0;font-family:Helvetica,Arial,sans-serif;font-size:11px;color:' + B.muted + '">' +
    'Sent automatically by Hawthbush Farm Management &middot; <a href="mailto:' + FROM_EMAIL + '" style="color:' + B.muted + '">' + FROM_EMAIL + '</a>' +
    '</td></tr></table></td></tr></table></body></html>';
}

async function logEmail(subject, to, bodySummary) {
  try {
    const log = (await sbGet(EMAIL_LOG_KEY)) || [];
    log.push({
      id: "el" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      sentAt: new Date().toISOString(), subject: subject, to: to,
      template: "cleaning_summary", bookingId: null, body: String(bodySummary || "").slice(0, 8000)
    });
    await sbSet(EMAIL_LOG_KEY, log.slice(-500));
  } catch (e) { console.error("logEmail failed:", e.message); }
}

// Plain-text mirror, stored in the log so the sent summary can be read back.
function buildText(model) {
  let out = "Housekeeping — the next " + DAYS_AHEAD + " days\n" + fmtLong(model.from) + " to " + fmtLong(model.to) + "\n";
  if (!model.days.length) return out + "\nNothing booked in this period.";
  model.days.forEach(function(d) {
    out += "\n" + fmtLong(d) + "\n";
    model.byDay[d].slice().sort(function(a, z) {
      if (a.rank !== z.rank) return a.rank - z.rank;
      return KIND_STYLE[a.kind].order - KIND_STYLE[z.kind].order;
    }).forEach(function(it) {
      out += "  " + KIND_STYLE[it.kind].text + ": " + it.label +
             (it.time ? " " + it.time : "") + " — " + it.detail + "\n";
    });
  });
  return out;
}

exports.handler = async function(event) {
  let body = {};
  if (event && event.body) { try { body = JSON.parse(event.body); } catch (e) { body = {}; } }
  const force = !!body.force;

  try {
    const cfg = (await sbGet(CONFIG_KEY)) || {};
    const recipients = String(cfg.emails || "").split(",")
      .map(function(e) { return e.trim(); })
      .filter(function(e) { return e.indexOf("@") > 0; });

    const now = new Date();
    const london = londonParts(now);

    if (!force) {
      if (!cfg.enabled) return jsonResponse(200, { skipped: "not enabled" });
      // 3am London only. The function is scheduled at 02:00 and 03:00 UTC so
      // that one of them is always 3am local, whatever the clocks are doing.
      if (london.hour !== 3) return jsonResponse(200, { skipped: "not 3am in London (it is " + london.hour + ")" });
      if (Number(cfg.weekday) !== london.weekday) {
        return jsonResponse(200, { skipped: "not the chosen day" });
      }
      // Belt and braces against a double fire on the same morning.
      if (cfg.lastSentDate === london.date) return jsonResponse(200, { skipped: "already sent today" });
    }

    if (!recipients.length) return jsonResponse(400, { error: "No email addresses set." });
    if (!RESEND_KEY) return jsonResponse(500, { error: "RESEND_API_KEY not set" });

    const results = await Promise.all([sbGet(PROPS_KEY), sbGet(ACCOM_KEY), sbGet(EVENTS_KEY)]);
    const model = buildDays(results[0] || [], results[1] || [], results[2] || [], london.date);

    const subject = "Housekeeping — " + fmtLong(model.from) + " to " + fmtLong(model.to);
    const html = buildHtml(model);

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to: recipients, subject: subject, html: html })
    });
    if (!res.ok) return jsonResponse(502, { error: "Resend failed: " + await res.text() });

    await logEmail(subject, recipients.join(", "), buildText(model));

    // Only the scheduled path records the date — a test send must not stop the
    // real one going out later the same morning.
    if (!force) {
      await sbSet(CONFIG_KEY, Object.assign({}, cfg, { lastSentDate: london.date }));
    }

    return jsonResponse(200, {
      ok: true, sentTo: recipients, days: model.days.length,
      from: model.from, to: model.to, forced: force
    });

  } catch (err) {
    console.error("send-cleaning-summary error:", err);
    return jsonResponse(500, { error: String(err.message || err) });
  }
};
