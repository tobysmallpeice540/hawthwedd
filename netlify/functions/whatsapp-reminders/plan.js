// netlify/functions/whatsapp-reminders/plan.js
//
// Who gets a WhatsApp checklist reminder, and when. Pure: no fetch, no clock
// (the caller passes `now`). Pinned by tests/whatsapp-reminders-test.cjs.
//
// The rules (Toby, 30 Oct 2026):
//   - Only items set to a NAMED person ("person:<uuid>"). Office, Bar,
//     Housekeeping and Anyone never trigger a reminder.
//   - ONE WhatsApp per person per list, however many of their items it holds.
//   - It goes `leadMin` minutes before that person's FIRST open item in the
//     list is due — never after. Most items are due at check-in, and a reminder
//     after check-in is no use. If the moment has passed (the job was not
//     running, or reminders were switched on late), it is not sent at all.
//   - It lists every one of that person's open items in that list.
//   - Nobody without a mobile, and no switched-off login, is sent anything;
//     they are reported so Settings can say who is missing a number.

"use strict";

const TZ = "Europe/London";

// WhatsApp refuses template values with a line break, a tab or more than four
// spaces in a row. Values are also kept short so the whole body stays well
// inside Meta's 1,024 characters.
function cleanParam(s, max) {
  let t = String(s == null ? "" : s).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  if (max && t.length > max) t = t.slice(0, max - 1).trimEnd() + "…";
  return t || "—";
}

function londonParts(d) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "numeric", minute: "2-digit", hour12: true, weekday: "short" });
  const p = {};
  f.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
  return p;
}

// "3:00pm today", "9:30am tomorrow", "3:00pm Sat 31 Oct".
function dueWords(due, now) {
  const d = londonParts(due), n = londonParts(now);
  const tomorrow = londonParts(new Date(now.getTime() + 864e5));
  const time = d.hour + ":" + d.minute + String(d.dayPeriod || "").toLowerCase().replace(/\s/g, "");
  const ymd = function (p) { return p.year + p.month + p.day; };
  if (ymd(d) === ymd(n)) return time + " today";
  if (ymd(d) === ymd(tomorrow)) return time + " tomorrow";
  const month = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, month: "short" }).format(due);
  return time + " " + d.weekday + " " + Number(d.day) + " " + month;
}

function itemsList(titles, max) {
  const out = [];
  let len = 0;
  for (let i = 0; i < titles.length; i++) {
    const t = cleanParam(titles[i], 80);
    if (len + t.length + 3 > max && out.length) {
      out.push("and " + (titles.length - i) + " more");
      break;
    }
    out.push(t); len += t.length + 3;
  }
  return out.join(" · ");
}

// runs:     [{ id, title, context, status }]           (open lists only)
// items:    [{ run_id, title, who, due_at, position, state }]
// people:   { <uuid>: { name, mobile, active } }
// sent:     Set of "<run_id>|<person>" already sent
// settings: { leadMin }
// now:      Date
function planReminders(input) {
  const now = input.now;
  const lead = Math.max(15, Number(input.settings && input.settings.leadMin) || 60) * 60000;
  const people = input.people || {};
  const sent = input.sent || new Set();
  const byRun = {};
  (input.runs || []).forEach(function (r) { if (r && r.status === "open") byRun[r.id] = r; });

  // Group each list's open, person-assigned items by person.
  const groups = {};
  (input.items || []).forEach(function (it) {
    if (!it || it.state !== "open" || !byRun[it.run_id]) return;
    const m = /^person:([0-9a-f-]{36})$/i.exec(String(it.who || ""));
    if (!m) return;
    const k = it.run_id + "|" + m[1].toLowerCase();
    (groups[k] = groups[k] || { run: byRun[it.run_id], person: m[1].toLowerCase(), items: [] }).items.push(it);
  });

  const send = [], noMobile = [], skipped = [];
  Object.keys(groups).sort().forEach(function (k) {
    const g = groups[k];
    const dues = g.items.map(function (it) { return it.due_at ? new Date(it.due_at).getTime() : NaN; })
      .filter(function (t) { return !isNaN(t); });
    if (!dues.length) return;                         // nothing has a due time
    const first = Math.min.apply(null, dues);
    if (now.getTime() < first - lead) return;          // not yet
    if (now.getTime() >= first) return;               // too late: never after it is due
    if (sent.has(k)) return;                          // already reminded for this list
    const p = people[g.person];
    if (!p || p.active === false) { skipped.push({ key: k, why: "login switched off or gone" }); return; }
    if (!p.mobile) { noMobile.push({ key: k, person: g.person, name: p.name || "" }); return; }

    const items = g.items.slice().sort(function (a, b) {
      const da = a.due_at ? new Date(a.due_at).getTime() : Infinity, db = b.due_at ? new Date(b.due_at).getTime() : Infinity;
      return da - db || (a.position || 0) - (b.position || 0);
    });
    const listName = g.run.context ? g.run.title + " – " + g.run.context : g.run.title;
    send.push({
      key: k, run_id: g.run.id, person: g.person, to: p.mobile,
      params: [
        cleanParam(String(p.name || "").split(/\s+/)[0] || "there", 40),
        items.length === 1 ? "1 item" : items.length + " items",
        cleanParam(listName, 120),
        dueWords(new Date(first), now),
        itemsList(items.map(function (it) { return it.title; }), 500)
      ]
    });
  });
  return { send: send, noMobile: noMobile, skipped: skipped };
}

module.exports = { planReminders: planReminders, cleanParam: cleanParam, dueWords: dueWords, itemsList: itemsList };
