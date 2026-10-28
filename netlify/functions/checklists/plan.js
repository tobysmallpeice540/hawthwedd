// netlify/functions/checklists/plan.js
//
// Which checklists should exist right now. Pure: no network, no clock of its
// own — everything comes in as arguments — so tests/checklists-plan-test.cjs
// can pin it.
//
//   planChecklists({ now, state, data }) -> { fire, retime, cancel, notes }
//
// state is chk_worker_state(): the active templates and the open lists. data
// is what the worker read, each source null if its read failed:
//   accom, properties, events, enquiries, changeovers  (app_data arrays)
//   drinks       [{event_id, pay_bar, staff_pay_bar}]  (wp_drinks)
//   boxEvents    [{id, name, starts_at, pay_bar}]       (published / hidden)
//   settings     hbf_checklist_settings_v1 ({ startTimes: { wedding, ... } })
//
// Every time is Europe/London wall-clock, turned into an instant here.
//
// An ANCHOR is the thing a list hangs off: a check-in, an event's start, a
// Monday at 09:00. Its key never contains a date that can move (a booking id,
// not its dates), so a list follows its booking when the dates change.
//
//   fire    anchors that have opened (anchor + the trigger's offset <= now),
//           are no earlier than the template's fire_from, and are under three
//           days old. The database ignores keys already used, so sending the
//           same anchor every run is harmless.
//   retime  open lists that follow a booking whose time or wording changed.
//   cancel  open lists whose booking / event / viewing / sign-off has gone —
//           only when every source that kind needs was read successfully AND
//           came back non-empty, so a failed read never cancels anything.
// Retime and cancel are only for lists that follow something (check-in,
// check-out, event, viewing, cleaned). The database refuses both for a list
// anyone has ticked.

"use strict";

const SOURCE_KINDS = { checkin: true, checkout: true, event: true, viewing: true, cleaned: true };
const FIRE_WINDOW_MS = 3 * 86400000;

const DEFAULT_START_TIMES = { wedding: "12:00", party: "19:00", celebration: "12:00", other: "12:00" };
const DEFAULT_CHECK_IN = "16:00", DEFAULT_CHECK_OUT = "10:00";
const WEDDING_CHECK_IN = "15:00", WEDDING_CHECK_OUT = "11:00";
const GRAIN_STORE = { id: "grainstore", name: "Grain Store" };

// ── London time ─────────────────────────────────────────────────────────────

const LONDON = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short"
});
function londonParts(d) {
  const p = {};
  LONDON.formatToParts(d).forEach(function(x) { p[x.type] = x.value; });
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday];
  return { date: p.year + "-" + p.month + "-" + p.day, time: p.hour + ":" + p.minute, weekday: wd,
           y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}
function offsetMin(d) {
  const p = londonParts(d);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
  return Math.round((asUtc - Math.floor(d.getTime() / 60000) * 60000) / 60000);
}
// "2026-10-30" + "16:00" in London -> the instant.
function londonToDate(dateIso, hhmm) {
  if (!isDate(dateIso) || !isTime(hhmm)) return null;
  const a = dateIso.split("-").map(Number), b = hhmm.split(":").map(Number);
  const guess = Date.UTC(a[0], a[1] - 1, a[2], b[0], b[1]);
  const first = guess - offsetMin(new Date(guess)) * 60000;
  return new Date(guess - offsetMin(new Date(first)) * 60000);
}
function isDate(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z")); }
function isTime(s) { return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }
function addDays(iso, n) {
  const d = new Date(Date.parse(iso + "T12:00:00Z") + n * 86400000);
  return d.toISOString().slice(0, 10);
}
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function pad(n) { return (n < 10 ? "0" : "") + n; }

const DAY_FMT = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short" });
function fmtDay(d) { return DAY_FMT.format(d).replace(",", ""); }
function fmtWhen(d) { return fmtDay(d) + " " + londonParts(d).time; }

// A typed time like "13:00" or "1.30pm"? Only a bare HH:MM counts: free text
// such as "12:30/12:45 (meeting first at the tap rooms)" is never read.
function bareTime(s) {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(String(s || ""));
  if (!m) return null;
  const t = pad(+m[1]) + ":" + m[2];
  return isTime(t) ? t : null;
}

// ── Event types ─────────────────────────────────────────────────────────────

function eventTypeKey(ev) {
  const t = String((ev && ev.eventType) || "");
  if (/wedding/i.test(t)) return "wedding";
  if (/party/i.test(t)) return "party";
  if (/wake|celebration|funeral|memorial/i.test(t)) return "celebration";
  return "other";
}
function eventTypeLabel(ev) {
  let raw = String((ev && ev.eventType) || "").replace(/\s*\(.*?\)\s*$/, "").trim();
  if (!raw) raw = "Event";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}
function eventStartTime(ev, settings) {
  const own = bareTime(ev && ev.guestArrivalTime);
  if (own) return own;
  const st = Object.assign({}, DEFAULT_START_TIMES, (settings && settings.startTimes) || {});
  const t = st[eventTypeKey(ev)];
  return isTime(t) ? t : DEFAULT_START_TIMES.other;
}
// The office's tick wins either way; without one, the client's.
function payBarFor(drinksRow) {
  if (!drinksRow) return false;
  if (drinksRow.staff_pay_bar === true || drinksRow.staff_pay_bar === false) return drinksRow.staff_pay_bar;
  return drinksRow.pay_bar === true;
}

// ── Lettings ────────────────────────────────────────────────────────────────

function stayTimes(b, stay, prop) {
  const wedding = !!(b && (b.bookingType === "Wedding" || b.linkedEventId));
  const dIn  = wedding ? ((prop && prop.checkInFromWedding) || WEDDING_CHECK_IN)  : ((prop && prop.checkInFrom) || DEFAULT_CHECK_IN);
  const dOut = wedding ? ((prop && prop.checkOutByWedding) || WEDDING_CHECK_OUT) : ((prop && prop.checkOutBy) || DEFAULT_CHECK_OUT);
  const tin = (stay && stay.checkInTime) || dIn, tout = (stay && stay.checkOutTime) || dOut;
  return { inTime: isTime(tin) ? tin : DEFAULT_CHECK_IN, outTime: isTime(tout) ? tout : DEFAULT_CHECK_OUT };
}
function guestLabel(b) {
  return b.guestName || (b.source === "airbnb" ? "Airbnb guest" : "(no name)");
}

// ── Anchors per trigger ─────────────────────────────────────────────────────
// Returns { list: [{ key, at, context, link }], sure } — sure is false when a
// source this trigger needs could not be read (or came back empty), so its
// open lists must not be cancelled on the strength of it.

function nonEmpty(a) { return Array.isArray(a) && a.length > 0; }

function anchorsFor(trig, data, now) {
  const kind = trig && trig.kind;
  const out = [];
  if (kind === "manual") return { list: out, sure: true };

  if (kind === "once") {
    const p = String(trig.at || "").split("T");
    const at = londonToDate(p[0], p[1]);
    if (at) out.push({ key: "once", at: at, context: fmtWhen(at), link: null });
    return { list: out, sure: true };
  }

  if (kind === "weekly") {
    const want = Number(trig.weekday), today = londonParts(now);
    let date = addDays(today.date, -((today.weekday - want + 7) % 7));
    let at = londonToDate(date, trig.time);
    if (at && at > now) { date = addDays(date, -7); at = londonToDate(date, trig.time); }
    if (at) out.push({ key: "weekly:" + date, at: at, context: fmtWhen(at), link: null });
    return { list: out, sure: true };
  }

  if (kind === "monthly") {
    const today = londonParts(now);
    const pick = function(y, m) {
      const day = Math.min(Number(trig.day) || 1, daysInMonth(y, m));
      return { key: "monthly:" + y + "-" + pad(m), at: londonToDate(y + "-" + pad(m) + "-" + pad(day), trig.time) };
    };
    let c = pick(today.y, today.m);
    if (c.at && c.at > now) c = today.m === 1 ? pick(today.y - 1, 12) : pick(today.y, today.m - 1);
    if (c.at) out.push({ key: c.key, at: c.at, context: fmtWhen(c.at), link: null });
    return { list: out, sure: true };
  }

  if (kind === "checkin" || kind === "checkout") {
    if (!Array.isArray(data.accom)) return { list: out, sure: false };
    const props = Array.isArray(data.properties) ? data.properties : [];
    const propOf = function(id) { return props.find(function(p) { return p && p.id === id; }) || null; };
    const want = trig.property || null;
    data.accom.forEach(function(b) {
      if (!b || b.status === "cancelled" || b.bookingType === "Blocked") return;
      const stays = (b.stays && b.stays.length) ? b.stays : [b];
      const seen = {};
      stays.forEach(function(s) {
        if (!s || !s.propertyId) return;
        seen[s.propertyId] = (seen[s.propertyId] || 0) + 1;
        if (want && s.propertyId !== want) return;
        const prop = propOf(s.propertyId);
        const t = stayTimes(b, s, prop);
        const date = kind === "checkin" ? s.checkIn : s.checkOut;
        const at = londonToDate(date, kind === "checkin" ? t.inTime : t.outTime);
        if (!at) return;
        const n = seen[s.propertyId];
        out.push({
          key: (kind === "checkin" ? "in:" : "out:") + b.id + ":" + s.propertyId + (n > 1 ? ":" + n : ""),
          at: at,
          context: ((prop && prop.name) || s.propertyName || s.propertyId) + " · " + guestLabel(b) + " · " +
                   (kind === "checkin" ? "in " : "out ") + fmtWhen(at),
          link: { kind: "accom", id: String(b.id) }
        });
      });
    });
    return { list: out, sure: nonEmpty(data.accom) };
  }

  if (kind === "event") {
    const type = trig.event_type || "any";
    let sure = Array.isArray(data.events) && data.events.length > 0;
    if (Array.isArray(data.events)) {
      const drinks = {};
      if (type === "paybar") {
        if (!Array.isArray(data.drinks)) sure = false;
        (data.drinks || []).forEach(function(r) { if (r) drinks[String(r.event_id)] = r; });
      }
      data.events.forEach(function(ev) {
        if (!ev || !isDate(ev.date) || ev.status === "Cancelled" || ev.status === "Holding") return;
        if (type === "paybar") { if (!payBarFor(drinks[String(ev.id)])) return; }
        else if (type !== "any" && eventTypeKey(ev) !== type) return;
        const at = londonToDate(ev.date, eventStartTime(ev, data.settings));
        if (!at) return;
        out.push({ key: "event:" + ev.id, at: at,
                   context: (ev.couple || "Event") + " · " + eventTypeLabel(ev) + " · " + fmtWhen(at),
                   link: { kind: "event", id: String(ev.id) } });
      });
    }
    // Ticketed Grain Store events: any event, or the ones with a pay bar.
    if (type === "any" || type === "paybar") {
      if (!Array.isArray(data.boxEvents)) sure = false;
      (data.boxEvents || []).forEach(function(bx) {
        if (!bx || !bx.starts_at || bx.status === "draft") return;
        if (type === "paybar" && bx.pay_bar !== true) return;
        const at = new Date(bx.starts_at);
        if (isNaN(at.getTime())) return;
        out.push({ key: "box:" + bx.id, at: at,
                   context: (bx.name || "Ticketed event") + " · Grain Store · " + fmtWhen(at),
                   link: { kind: "box", id: String(bx.id) } });
      });
    }
    return { list: out, sure: sure };
  }

  if (kind === "viewing") {
    const add = function(src, rec, name, linkKind) {
      const seen = {};
      (rec.viewings || []).forEach(function(v) {
        if (!v || !isDate(v.date)) return;
        seen[v.date] = (seen[v.date] || 0) + 1;
        const time = bareTime(v.time) || "10:00";
        const at = londonToDate(v.date, time);
        if (!at) return;
        out.push({ key: "viewing:" + src + ":" + rec.id + ":" + v.date + (seen[v.date] > 1 ? ":" + seen[v.date] : ""),
                   at: at, context: "Viewing · " + (name || "(no name)") + " · " + fmtWhen(at),
                   link: { kind: linkKind, id: String(rec.id) } });
      });
    };
    // An enquiry that became a booking keeps its viewings, and the booking has
    // them too: the same viewing twice. The booking's copy wins — matched by
    // email and day.
    const onEvent = {};
    (data.events || []).forEach(function(ev) {
      const em = String((ev && ev.email) || "").trim().toLowerCase();
      if (!em) return;
      ((ev && ev.viewings) || []).forEach(function(v) { if (v && v.date) onEvent[em + "|" + v.date] = true; });
    });
    (data.enquiries || []).forEach(function(e) {
      if (!e) return;
      const em = String(e.email || "").trim().toLowerCase();
      const own = Object.assign({}, e, { viewings: (e.viewings || []).filter(function(v) { return !(em && v && onEvent[em + "|" + v.date]); }) });
      add("enq", own, e.name, "enquiry");
    });
    (data.events || []).forEach(function(ev) { if (ev && ev.status !== "Cancelled") add("evt", ev, ev.couple, "event"); });
    return { list: out, sure: nonEmpty(data.enquiries) && nonEmpty(data.events) };
  }

  if (kind === "cleaned") {
    if (!Array.isArray(data.changeovers)) return { list: out, sure: false };
    const want = trig.property || null;
    data.changeovers.forEach(function(r) {
      if (!r || typeof r.doneAt !== "string" || !r.id) return;
      if (want && r.unitId !== want) return;
      const p = r.doneAt.split("T");
      const at = londonToDate(p[0], (p[1] || "").slice(0, 5));
      if (!at) return;
      const k = r.kind === "setup" ? r.setupOf : r.kind;
      const link = (k === "accom" || k === "event" || k === "box") && r.refId != null ? { kind: k, id: String(r.refId) } : null;
      out.push({ key: "clean:" + r.id, at: at,
                 context: (r.unitName || r.unitId || "Clean") + " · cleaned " + fmtWhen(at), link: link });
    });
    return { list: out, sure: nonEmpty(data.changeovers) };
  }

  return { list: out, sure: false };
}

// ── The plan ────────────────────────────────────────────────────────────────

function planChecklists(o) {
  const now = o.now instanceof Date ? o.now : new Date(o.now);
  const state = o.state || {};
  const data = o.data || {};
  const fire = [], retime = [], cancel = [], notes = [];
  const runsByTpl = {};
  (state.open_runs || []).forEach(function(r) {
    (runsByTpl[r.template_id] = runsByTpl[r.template_id] || []).push(r);
  });

  (state.templates || []).forEach(function(t) {
    const trig = t.trig || {};
    const res = anchorsFor(trig, data, now);
    const off = SOURCE_KINDS[trig.kind] ? (Number(trig.offset_min) || 0) : 0;
    const fireFrom = new Date(t.fire_from || 0);
    const byKey = {};
    res.list.forEach(function(a) {
      byKey[a.key] = a;
      const opens = new Date(a.at.getTime() + off * 60000);
      if (opens > now) return;
      if (a.at < fireFrom) return;
      if (a.at.getTime() < now.getTime() - FIRE_WINDOW_MS && opens.getTime() < now.getTime() - FIRE_WINDOW_MS) return;
      fire.push({ template_id: t.id, anchor_key: a.key, anchor_at: a.at.toISOString(), opens_at: opens.toISOString(),
                  context: a.context, link: a.link });
    });
    if (!SOURCE_KINDS[trig.kind]) return;
    if (!res.sure) notes.push("not sure of " + trig.kind + " for " + t.id + " — nothing cancelled");
    (runsByTpl[t.id] || []).forEach(function(r) {
      const a = byKey[r.anchor_key];
      if (!a) {
        if (res.sure && !r.touched) cancel.push(r.id);
        return;
      }
      const was = new Date(r.anchor_at).getTime();
      if (Math.abs(was - a.at.getTime()) > 60000 || (r.context || "") !== (a.context || "")) {
        if (r.touched) return;
        retime.push({ run_id: r.id, anchor_at: a.at.toISOString(),
                      opens_at: new Date(a.at.getTime() + off * 60000).toISOString(),
                      context: a.context, link: a.link });
      }
    });
  });
  return { fire: fire, retime: retime, cancel: cancel, notes: notes };
}

module.exports = {
  planChecklists, anchorsFor, londonToDate, londonParts, eventStartTime, payBarFor, bareTime,
  DEFAULT_START_TIMES, GRAIN_STORE
};
