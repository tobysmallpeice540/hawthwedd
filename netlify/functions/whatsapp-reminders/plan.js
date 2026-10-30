// netlify/functions/whatsapp-reminders/plan.js
//
// Which WhatsApps are due right now. Pure: no fetch, no clock (the caller
// passes `now`). Pinned by tests/whatsapp-reminders-test.cjs.
//
// Rules (Toby, 30 Oct 2026):
//   - Nothing between 10pm and 8am (isQuiet). Something that falls due in the
//     night goes at 8am instead — every rule below allows a catch-up window
//     long enough to cover the night (CATCH_UP_H), and no longer, so switching
//     a message on never sends a backlog.
//   - Checklists: only items set to a NAMED person ("person:<uuid>"), never
//     Office, Bar, Housekeeping or Anyone. "Live": one WhatsApp per person per
//     list when the list opens, listing their open items. "Overdue": one per
//     person per list once their first item passes its due time, listing the
//     overdue ones. Each list can suppress either (its two ticks).
//   - Pre-arrival: on the morning of arrival from the set hour (9am), to
//     lettings guests who agreed to WhatsApp. One per booking per arrival day.
//   - Changeover summary: weekly, on the set day from the set hour, to each
//     housekeeper's number: the next 10 days of check-outs, check-ins and
//     events with housekeeping notes.
//
// Every planned message carries `key` — the mark that makes it once only.

"use strict";

const { cleanParam } = require("./templates.js");

const TZ = "Europe/London";
const CATCH_UP_H = 14;          // 10pm–8am is ten hours; fourteen leaves room
const QUIET_FROM = 22, QUIET_TO = 8;

function londonParts(d) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" });
  const p = {};
  f.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
  if (p.hour === "24") p.hour = "00";
  return p;
}
function londonDate(d) { const p = londonParts(d); return p.year + "-" + p.month + "-" + p.day; }
function londonHour(d) { return Number(londonParts(d).hour); }
function londonWeekday(d) { return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(londonParts(d).weekday); }
function isQuiet(now) { const h = londonHour(now); return h >= QUIET_FROM || h < QUIET_TO; }

function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WD_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MO_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function dayShort(iso) { const d = new Date(iso + "T12:00:00Z"); return WD[d.getUTCDay()] + " " + d.getUTCDate() + " " + MO[d.getUTCMonth()]; }
function dayLong(iso) { const d = new Date(iso + "T12:00:00Z"); return WD_LONG[d.getUTCDay()] + " " + d.getUTCDate() + " " + MO_LONG[d.getUTCMonth()]; }
function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")); }

// "16:00" → "4:00pm"
function clock12(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ""));
  if (!m) return "";
  const h = Number(m[1]);
  return ((h % 12) || 12) + ":" + m[2] + (h < 12 ? "am" : "pm");
}

// "3:00pm today", "9:30am tomorrow", "3:00pm Sat 31 Oct".
function dueWords(due, now) {
  const p = londonParts(due);
  const time = clock12(p.hour + ":" + p.minute);
  const d = londonDate(due), today = londonDate(now);
  if (d === today) return time + " today";
  if (d === addDays(today, 1)) return time + " tomorrow";
  return time + " " + dayShort(d);
}

function itemsList(titles, max) {
  const out = [];
  let len = 0;
  for (let i = 0; i < titles.length; i++) {
    const t = cleanParam(titles[i], 80);
    if (len + t.length + 3 > max && out.length) { out.push("and " + (titles.length - i) + " more"); break; }
    out.push(t); len += t.length + 3;
  }
  return out.join(" · ");
}
function countWords(n) { return n === 1 ? "1 item" : n + " items"; }
function firstName(s) { return cleanParam(String(s || "").trim().split(/\s+/)[0] || "there", 40); }

// ── Checklists ───────────────────────────────────────────────────────────────
// runs:  [{ id, template_id, title, context, status, opens_at }]
// items: [{ run_id, title, who, due_at, position, state }]
// people: { <uuid>: { name, mobile, active } }
// ticks: { <template id>: { live, overdue } } — absent = both allowed
// on:    { live: bool, overdue: bool } — the two templates' switches
function planChecklists(input) {
  const now = input.now, catchUp = CATCH_UP_H * 3600000;
  const on = input.on || {};
  const ticks = input.ticks || {};
  const people = input.people || {};
  const runs = {};
  (input.runs || []).forEach(function (r) { if (r && r.status === "open") runs[r.id] = r; });
  const groups = {};
  (input.items || []).forEach(function (it) {
    if (!it || it.state !== "open" || !runs[it.run_id]) return;
    const m = /^person:([0-9a-f-]{36})$/i.exec(String(it.who || ""));
    if (!m) return;
    const k = it.run_id + "|" + m[1].toLowerCase();
    (groups[k] = groups[k] || { run: runs[it.run_id], person: m[1].toLowerCase(), items: [] }).items.push(it);
  });
  const byDue = function (a, b) {
    const da = a.due_at ? new Date(a.due_at).getTime() : Infinity, db = b.due_at ? new Date(b.due_at).getTime() : Infinity;
    return da - db || (a.position || 0) - (b.position || 0);
  };
  const send = [], noMobile = [];
  Object.keys(groups).sort().forEach(function (k) {
    const g = groups[k], run = g.run;
    const t = ticks[run.template_id] || {};
    const p = people[g.person];
    const listName = cleanParam(run.context ? run.title + " – " + run.context : run.title, 120);
    const who = p && p.active !== false ? p : null;
    const items = g.items.slice().sort(byDue);
    const want = [];
    // Live: the list has opened, not longer ago than the catch-up window.
    const opened = run.opens_at ? new Date(run.opens_at).getTime() : NaN;
    if (on.live && t.live !== false && !isNaN(opened) && opened <= now.getTime() && now.getTime() - opened < catchUp) {
      const firstDue = items.filter(function (i) { return i.due_at; })[0];
      want.push({ template: "checklist_live", key: "live|" + k, values: {
        list: listName, count: countWords(items.length),
        due: firstDue ? dueWords(new Date(firstDue.due_at), now) : "no set time",
        items: itemsList(items.map(function (i) { return i.title; }), 500) } });
    }
    // Overdue: their first item went past due, not longer ago than the window.
    const late = items.filter(function (i) { return i.due_at && new Date(i.due_at).getTime() <= now.getTime(); });
    if (on.overdue && t.overdue !== false && late.length && now.getTime() - new Date(late[0].due_at).getTime() < catchUp) {
      want.push({ template: "checklist_overdue", key: "overdue|" + k, values: {
        list: listName, count: countWords(late.length),
        items: itemsList(late.map(function (i) { return i.title; }), 500) } });
    }
    want.forEach(function (w) {
      if (input.sent && input.sent.has(w.key)) return;
      if (!who) return;
      if (!who.mobile) { noMobile.push({ key: w.key, name: (p && p.name) || "" }); return; }
      w.values.name = firstName(who.name);
      send.push({ template: w.template, key: w.key, to: who.mobile, toName: who.name || "",
        record: { kind: "checklist", id: run.id, name: listName }, values: w.values });
    });
  });
  return { send: send, noMobile: noMobile };
}

// ── Pre-arrival ──────────────────────────────────────────────────────────────
// A guest has agreed if the booking says so; a booking from before the tick
// existed counts as agreed (Toby: ticked by default) — except an Airbnb one,
// whose guest was never asked.
function guestAgreed(b) {
  if (b.waConsent === true) return true;
  if (b.waConsent === false) return false;
  return b.source !== "airbnb";
}

function normaliseNumber(s) {
  let d = String(s || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = "44" + d.slice(1);
  else if (d.length === 10 && d.startsWith("7")) d = "44" + d;
  return d.length >= 10 && d.length <= 15 ? d : "";
}

function stayTimes(b, s, prop) {
  const wedding = b.bookingType === "Wedding" || !!b.linkedEventId;
  return {
    inTime: s.checkInTime || (prop && (wedding ? prop.checkInFromWedding : prop.checkInFrom)) || (wedding ? "15:00" : "16:00"),
    outTime: s.checkOutTime || (prop && (wedding ? prop.checkOutByWedding : prop.checkOutBy)) || (wedding ? "11:00" : "10:00")
  };
}

// arrival (from hbf_whatsapp_settings_v1.arrival):
//   daysBefore 0 (the arrival day, standard) or 1 (the day before)
//   gateCode   the estate gate code, for {{gateCode}}
//   packs      { <property id>: arrival pack link }, for {{arrivalPack}}
// The caller decides the hour; this decides who and what.
function arrivalPackFor(arrival, stays) {
  const packs = (arrival && arrival.packs) || {};
  for (let i = 0; i < stays.length; i++) {
    const u = String(packs[stays[i].propertyId] || "").trim();
    if (u) return u;
  }
  return "";
}

function planArrivals(input) {
  const arrival = input.arrival || {};
  const ahead = Number(arrival.daysBefore) === 1 ? 1 : 0;
  const day = addDays(londonDate(input.now), ahead);       // the check-in day being announced
  const props = {};
  (input.properties || []).forEach(function (p) { if (p) props[p.id] = p; });
  const send = [], skipped = [];
  (input.accom || []).forEach(function (b) {
    if (!b || b.bookingType === "Blocked") return;
    if (b.status !== "confirmed" && b.status !== "completed") return;
    const stays = (b.stays && b.stays.length ? b.stays : [b]).filter(function (s) { return s && s.propertyId && validDate(s.checkIn); });
    const arriving = stays.filter(function (s) { return s.checkIn === day; });
    if (!arriving.length) return;
    const key = "arrival|" + b.id + "|" + day;
    if (input.sent && input.sent.has(key)) return;
    const to = normaliseNumber(b.phone);
    if (!guestAgreed(b)) { skipped.push({ key: key, why: "not agreed" }); return; }
    if (!to) { skipped.push({ key: key, why: "no mobile" }); return; }
    const first = arriving[0];
    const prop = props[first.propertyId];
    const t = stayTimes(b, first, prop);
    const out = arriving.map(function (s) { return s.checkOut; }).filter(validDate).sort().pop() || first.checkOut;
    const nights = validDate(out) ? Math.round((new Date(out + "T12:00:00Z") - new Date(day + "T12:00:00Z")) / 864e5) : 0;
    const names = arriving.map(function (s) { const p = props[s.propertyId]; return (p && p.name) || s.propertyName || s.propertyId; });
    send.push({ template: "pre_arrival", key: key, to: to, toName: b.guestName || "",
      record: { kind: "accom", id: String(b.id), name: (b.guestName || "Guest") + " letting" },
      // What each tap-to-answer button sends back: the booking, the arrival
      // day and which button (whatsapp-webhook saves it on the booking).
      payloads: [0, 1, 2].map(function (i) { return "eta|" + b.id + "@" + day + "|" + i; }),
      values: {
        guestName: firstName(b.guestName || "there"),
        property: cleanParam(names.filter(function (n, i) { return names.indexOf(n) === i; }).join(" and "), 80),
        gateCode: cleanParam(arrival.gateCode, 40),
        arrivalPack: cleanParam(arrivalPackFor(arrival, arriving) || "https://www.hawthbushfarm.co.uk", 300),
        checkInTime: clock12(t.inTime) || "—",
        checkOutDate: validDate(out) ? dayLong(out) : "—",
        checkOutTime: clock12(t.outTime) || "—",
        nights: nights === 1 ? "1 night" : nights + " nights",
        bookingRef: String(b.id || "").toUpperCase() || "—"
      } });
  });
  return { send: send, skipped: skipped };
}

// ── Changeover summary ───────────────────────────────────────────────────────
// The next 10 days, one line each: per property its check-outs and check-ins
// (with the housekeeping note for the guests arriving, an extra clean, or no
// exit clean), then the Grain Store's events (with their notes). Mirrors what
// the housekeeping pages show, from the same records: hbf_accom_v1,
// hawthbush_bookings_v6, box_events (published) and hbf_setup_cleans_v1.
function hk(setups, type, kind, refId) {
  const id = type + ":" + kind + ":" + refId;
  return (setups || []).filter(function (x) { return x && x.id === id; })[0] || null;
}
function hkNote(setups, kind, refId) {
  const n = hk(setups, "note", kind, refId);
  return n && typeof n.text === "string" ? n.text.trim() : "";
}
function shortName(p) {
  const n = String((p && p.name) || "").replace(/^The\s+/i, "");
  return n.split(/\s+/)[0] || (p && p.id) || "";
}
// "Emma Juner" → "Juner"; "Jones (Wed)" → "Jones" (wedding-cottage names).
function surname(s) {
  const w = String(s || "").replace(/\([^)]*\)/g, " ").trim().split(/\s+/).filter(Boolean);
  return w.length ? w[w.length - 1] : "";
}

// How long each day's line may be, so the whole message fits WhatsApp's 1,024
// characters with the wording actually in use (fixedLen: that wording without
// its merge fields) and a first name of up to 40.
function dayCap(fixedLen) {
  return Math.max(40, Math.min(120, Math.floor((1024 - (fixedLen || 0) - 40) / 10)));
}

function summaryDays(input, from, days, cap) {
  const props = (input.properties || []).filter(function (p) { return p && !p.archived; });
  const setups = input.setups || [];
  const out = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(from, i);
    const parts = [];
    props.forEach(function (p) {
      const bits = [];
      (input.accom || []).forEach(function (b) {
        if (!b || b.status === "cancelled" || b.bookingType === "Blocked") return;
        (b.stays && b.stays.length ? b.stays : [b]).forEach(function (s) {
          if (!s || s.propertyId !== p.id) return;
          if (s.checkOut === day) bits.push(hk(setups, "noexit", "accom", b.id) ? "out (no clean)" : "out");
          if (s.checkIn === day) {
            let t = "in " + surname(b.guestName || (b.source === "airbnb" ? "Airbnb" : "guest"));
            const extra = hk(setups, "setup", "accom", b.id) ? "extra clean" : "";
            const note = hkNote(setups, "accom", b.id);
            const paren = [extra, note].filter(Boolean).join(": ");
            if (paren) t += " (" + paren + ")";
            bits.push(t);
          }
        });
      });
      if (bits.length) parts.push(shortName(p) + " " + bits.join(", "));
    });
    const gs = [];
    (input.events || []).forEach(function (ev) {
      if (!ev || !validDate(ev.date) || ev.status === "Cancelled" || ev.status === "Holding") return;
      const end = validDate(ev.endDate) && ev.endDate > ev.date ? ev.endDate : ev.date;
      if (day < ev.date || day > end) return;
      const type = String(ev.eventType || "event").replace(/\s*\(.*?\)\s*$/, "").trim().toLowerCase();
      let t = (ev.couple || "Event") + " " + type;
      if (day === ev.date) {
        const note = hkNote(setups, "event", ev.id);
        const extra = hk(setups, "setup", "event", ev.id) ? "extra clean" : "";
        const paren = [extra, note].filter(Boolean).join(": ");
        if (paren) t += " (" + paren + ")";
      }
      gs.push(t);
    });
    (input.boxEvents || []).forEach(function (bx) {
      if (!bx || bx.status === "draft" || !bx.starts_at) return;
      if (londonDate(new Date(bx.starts_at)) !== day) return;
      let t = (bx.name || "Ticketed event") + " " + clock12(londonParts(new Date(bx.starts_at)).hour + ":" + londonParts(new Date(bx.starts_at)).minute);
      const note = hkNote(setups, "box", bx.id);
      if (note) t += " (" + note + ")";
      gs.push(t);
    });
    if (gs.length) parts.push("Grain St " + gs.join(", "));
    out.push(cleanParam(dayShort(day) + ": " + (parts.length ? parts.join(" · ") : "nothing booked"), cap || 88));
  }
  return out;
}

function planSummary(input) {
  const s = input.settings || {};
  const day = s.day == null ? 0 : Number(s.day);
  const hour = s.hour == null ? 8 : Number(s.hour);
  if (londonWeekday(input.now) !== day || londonHour(input.now) < hour) return { send: [], skipped: [] };
  const today = londonDate(input.now);
  let lines = null;
  const send = [], skipped = [];
  (s.recipients || []).forEach(function (r) {
    const to = normaliseNumber(r && r.mobile);
    if (!to) { skipped.push({ name: (r && r.name) || "", why: "no mobile" }); return; }
    const key = "summary|" + today + "|" + to;
    if (input.sent && input.sent.has(key)) return;
    lines = lines || summaryDays(input, today, 10, dayCap(input.fixedLen));
    const values = { name: firstName(r.name) };
    lines.forEach(function (l, i) { values["day" + (i + 1)] = l; });
    send.push({ template: "changeover_summary", key: key, to: to, toName: r.name || "",
      record: { kind: "summary", id: today, name: "Changeover summary" }, values: values });
  });
  return { send: send, skipped: skipped };
}

module.exports = { planChecklists, planArrivals, planSummary, summaryDays, dayCap, isQuiet, dueWords, itemsList,
  normaliseNumber, guestAgreed, arrivalPackFor, londonDate, londonHour, londonWeekday, clock12, CATCH_UP_H };
