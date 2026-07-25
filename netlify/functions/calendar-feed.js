// netlify/functions/calendar-feed.js
// Hosted iCalendar (.ics) feed exposing Hawthbush Farm events (bookings) and viewings.
// Subscribe in Google Calendar / Apple Calendar / Outlook using the URL:
//   https://cool-sorbet-b1d599.netlify.app/calendar.ics
// (also served directly at /.netlify/functions/calendar-feed)

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJrcWJ5aXNmbXZ3dWxzeXh6d2p6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NTI0MzgsImV4cCI6MjA5NjUyODQzOH0._CsyhvFrtHFC0KrfiLzbrLUaKcvxtbWlHydaH20tvfo";

const BOOKINGS_KEY  = "hawthbush_bookings_v6";
const ENQUIRIES_KEY = "hbf_enquiries_v1";

// ── helpers ────────────────────────────────────────────────────────────────
const sbGet = async (key) => {
  const res = await fetch(
    SUPABASE_URL + "/rest/v1/app_data?key=eq." + key + "&select=value",
    { headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY } }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return (Array.isArray(rows) && rows[0]) ? rows[0].value : null;
};

// Escape text for an ICS property value
const esc = (s) => String(s == null ? "" : s)
  .replace(/\\/g, "\\\\")
  .replace(/;/g, "\\;")
  .replace(/,/g, "\\,")
  .replace(/\r?\n/g, "\\n");

// Fold long lines to 75 octets per RFC 5545 (continuation lines start with a space)
const fold = (line) => {
  if (line.length <= 75) return line;
  let out = "";
  let idx = 0;
  while (idx < line.length) {
    const chunk = idx === 0 ? line.slice(0, 75) : line.slice(idx, idx + 74);
    out += (idx === 0 ? "" : "\r\n ") + chunk;
    idx += (idx === 0 ? 75 : 74);
  }
  return out;
};

const pad = (n) => String(n).padStart(2, "0");
const dateCompact = (ymd) => (ymd || "").replace(/-/g, ""); // 2026-05-23 -> 20260523
const addDay = (ymd) => {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate());
};
const dtStamp = () => {
  const d = new Date();
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
    "T" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + "Z";
};
const timeCompact = (t) => {
  // "14:00" -> "140000"
  const m = /^(\d{1,2}):(\d{2})/.exec(t || "");
  if (!m) return null;
  return pad(m[1]) + pad(m[2]) + "00";
};
// add one hour to an HH:MM for a default viewing end time
const addHour = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || "");
  if (!m) return null;
  let h = (parseInt(m[1], 10) + 1) % 24;
  return pad(h) + m[2] + "00";
};

// Minimal Europe/London VTIMEZONE so timed viewings map to UK local time everywhere
const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/London",
  "X-LIC-LOCATION:Europe/London",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0000",
  "TZOFFSETTO:+0100",
  "TZNAME:BST",
  "DTSTART:19700329T010000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0000",
  "TZNAME:GMT",
  "DTSTART:19701025T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

exports.handler = async () => {
  let bookings = [];
  let enquiries = [];
  try { bookings = (await sbGet(BOOKINGS_KEY)) || []; } catch (e) { bookings = []; }
  try { enquiries = (await sbGet(ENQUIRIES_KEY)) || []; } catch (e) { enquiries = []; }

  const stamp = dtStamp();
  const lines = [];

  // Booking (event) VEVENTs — all-day on the event date
  bookings.forEach((b) => {
    if (!b || !b.date || !b.couple) return;
    const start = dateCompact(b.date);
    if (start.length !== 8) return;
    const holding = (b.status === "Holding");
    const summary = (holding ? "[HOLD] " : "") + b.couple;
    const descParts = [];
    if (b.status) descParts.push("Status: " + b.status);
    if (b.mealGuests) descParts.push("Day guests: " + b.mealGuests);
    if (b.eveGuests) descParts.push("Eve guests: " + b.eveGuests);
    if (b.phone) descParts.push("Phone: " + b.phone);
    if (b.email) descParts.push("Email: " + b.email);
    lines.push("BEGIN:VEVENT");
    lines.push("UID:booking-" + (b.id != null ? b.id : start) + "@hawthbushfarm.co.uk");
    lines.push("DTSTAMP:" + stamp);
    lines.push("DTSTART;VALUE=DATE:" + start);
    lines.push("DTEND;VALUE=DATE:" + addDay(b.date));
    lines.push(fold("SUMMARY:" + esc(summary)));
    if (descParts.length) lines.push(fold("DESCRIPTION:" + esc(descParts.join("\n"))));
    lines.push("CATEGORIES:Event");
    lines.push("TRANSP:TRANSPARENT");
    lines.push("END:VEVENT");
  });

  // Viewing VEVENTs from both bookings and enquiries
  const pushViewing = (v, name, kind, srcId, vi) => {
    if (!v || !v.date) return;
    const start = dateCompact(v.date);
    if (start.length !== 8) return;
    const uid = "viewing-" + kind + "-" + srcId + "-" + vi + "@hawthbushfarm.co.uk";
    lines.push("BEGIN:VEVENT");
    lines.push("UID:" + uid);
    lines.push("DTSTAMP:" + stamp);
    const startT = timeCompact(v.time);
    if (startT) {
      lines.push("DTSTART;TZID=Europe/London:" + start + "T" + startT);
      const endT = addHour(v.time) || startT;
      lines.push("DTEND;TZID=Europe/London:" + start + "T" + endT);
    } else {
      lines.push("DTSTART;VALUE=DATE:" + start);
      lines.push("DTEND;VALUE=DATE:" + addDay(v.date));
    }
    lines.push(fold("SUMMARY:" + esc("Viewing: " + (name || (kind === "booking" ? "Booking" : "Enquiry")))));
    if (v.notes) lines.push(fold("DESCRIPTION:" + esc(v.notes)));
    lines.push("CATEGORIES:Viewing");
    lines.push("TRANSP:TRANSPARENT");
    lines.push("END:VEVENT");
  };

  bookings.forEach((b) => {
    (b && Array.isArray(b.viewings) ? b.viewings : []).forEach((v, vi) => {
      pushViewing(v, b.couple, "booking", (b.id != null ? b.id : "x"), vi);
    });
  });
  enquiries.forEach((e) => {
    (e && Array.isArray(e.viewings) ? e.viewings : []).forEach((v, vi) => {
      pushViewing(v, e.name, "enquiry", (e.id != null ? e.id : "x"), vi);
    });
  });

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Hawthbush Farm//Venue Ops//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Hawthbush Farm",
    "X-WR-TIMEZONE:Europe/London",
    "X-WR-CALDESC:Events and viewings at Hawthbush Farm",
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  ]
    .concat(VTIMEZONE)
    .concat(lines)
    .concat(["END:VCALENDAR"])
    .join("\r\n") + "\r\n";

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="hawthbush-farm.ics"',
      "Cache-Control": "public, max-age=600",
      "Access-Control-Allow-Origin": "*",
    },
    body: ics,
  };
};
