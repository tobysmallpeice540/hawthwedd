// netlify/functions/ha-link/feed.js
//
// What Home Assistant is told about the day (ha-link.js action "today"), and
// the alert's once-an-hour key. Pure — no fetch. Pinned by tests/ha-link-test.cjs.
//
// Home Assistant only needs to know WHETHER a place is in use, not by whom:
// no guest names, numbers, emails or money leave here (Toby, 3 Nov). The
// rules for which lettings and events count are the changeover summary's
// (plan.summaryItems): lettings — anything not cancelled or Blocked;
// diary events — not Cancelled or Holding, date to endDate; box office —
// not draft, on the day it starts.

"use strict";

const crypto = require("crypto");
const plan = require("../whatsapp-reminders/plan.js");

const AHEAD_DAYS = 60;   // how far "next arrival" / "next event" look

function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")); }
const addDays = plan.addDays;
function bareTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  return m ? String(m[1]).padStart(2, "0") + ":" + m[2] : null;
}
function stayList(b) { return (b.stays && b.stays.length ? b.stays : [b]).filter(function (s) { return s && s.propertyId && validDate(s.checkIn) && validDate(s.checkOut); }); }
function counts(b) { return b && b.status !== "cancelled" && b.bookingType !== "Blocked"; }

// input: { now: Date, accom, properties, events, boxEvents }
function feed(input) {
  const today = plan.londonDate(input.now);
  const tomorrow = addDays(today, 1);
  const until = addDays(today, AHEAD_DAYS);
  const properties = {};
  (input.properties || []).filter(function (p) { return p && p.id && !p.archived; }).forEach(function (p) {
    const out = { name: p.name || p.id, occupiedTonight: false, arrivingToday: false, arrivalTime: null,
      departingToday: false, departureTime: null, arrivingTomorrow: false, nextArrival: null };
    (input.accom || []).forEach(function (b) {
      if (!counts(b)) return;
      stayList(b).forEach(function (s) {
        if (s.propertyId !== p.id) return;
        if (s.checkIn <= today && today < s.checkOut) out.occupiedTonight = true;
        if (s.checkIn === today) {
          out.arrivingToday = true;
          const t = bareTime(plan.stayTimes(b, s, p).inTime);
          if (t && (!out.arrivalTime || t < out.arrivalTime)) out.arrivalTime = t;
        }
        if (s.checkOut === today) {
          out.departingToday = true;
          const t = bareTime(plan.stayTimes(b, s, p).outTime);
          if (t && (!out.departureTime || t > out.departureTime)) out.departureTime = t;
        }
        if (s.checkIn === tomorrow) out.arrivingTomorrow = true;
        if (s.checkIn >= today && s.checkIn <= until && (!out.nextArrival || s.checkIn < out.nextArrival)) out.nextArrival = s.checkIn;
      });
    });
    properties[p.id] = out;
  });

  // The Grain Store: diary events and published ticketed events.
  const days = {};   // day → [{ start, type }]
  (input.events || []).forEach(function (ev) {
    if (!ev || !validDate(ev.date) || ev.status === "Cancelled" || ev.status === "Holding") return;
    const end = validDate(ev.endDate) && ev.endDate > ev.date ? ev.endDate : ev.date;
    const type = String(ev.eventType || "event").replace(/\s*\(.*?\)\s*$/, "").trim().toLowerCase() || "event";
    for (let d = ev.date; d <= end && d <= until; d = addDays(d, 1)) {
      if (d < today) continue;
      (days[d] = days[d] || []).push({ start: d === ev.date ? bareTime(ev.guestArrivalTime) : null, type: type });
    }
  });
  (input.boxEvents || []).forEach(function (bx) {
    if (!bx || bx.status === "draft" || !bx.starts_at) return;
    const at = new Date(bx.starts_at);
    if (isNaN(at)) return;
    const d = plan.londonDate(at);
    if (d < today || d > until) return;
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
    (days[d] = days[d] || []).push({ start: p, type: "ticketed event" });
  });
  const first = function (list) {
    const starts = list.map(function (x) { return x.start; }).filter(Boolean).sort();
    return { start: starts[0] || null, type: list[0].type };
  };
  const upcoming = Object.keys(days).sort();
  const t = days[today] ? first(days[today]) : null;
  const grainStore = {
    eventToday: !!days[today], todayStart: t ? t.start : null, todayType: t ? t.type : null,
    eventTomorrow: !!days[tomorrow], nextEvent: upcoming[0] || null
  };
  return { date: today, generatedAt: input.now.toISOString(), properties: properties, grainStore: grainStore };
}

// The same alert goes at most once an hour: (title, London date and hour).
function alertRef(title, now) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(now).reduce(function (o, x) { o[x.type] = x.value; return o; }, {});
  const h = crypto.createHash("sha256").update(String(title || "").trim().toLowerCase()).digest("hex").slice(0, 16);
  return h + "|" + p.year + "-" + p.month + "-" + p.day + "T" + p.hour;
}

module.exports = { feed, alertRef, AHEAD_DAYS };
