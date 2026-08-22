// netlify/functions/calendar-feed.js
// Hosted iCalendar (.ics) feed — events, viewings, and lettings bookings.
// Subscribe via: https://hawthbushfarm.netlify.app/calendar.ics

const SUPABASE_URL  = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
// The service key, not the anon key. Server-side code has no business
// holding the same credential the public pages carry — and once app_data
// has row level security this is what keeps the scheduled jobs working.
// No fallback to the anon key on purpose: a missing variable should fail
// loudly rather than quietly reopen what this change closes.
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;

// The box office lives in real tables with RLS on, so the anon key above can't
// see it. The service key can — and the internal calendar should show a
// ticketed night whether or not it's a public one.
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY;

const BOOKINGS_KEY  = "hawthbush_bookings_v6";
const ENQUIRIES_KEY = "hbf_enquiries_v1";
const ACCOM_KEY     = "hbf_accom_v1";

// ── helpers ────────────────────────────────────────────────────────────────
const sbGet = async (key) => {
  const res = await fetch(
    SUPABASE_URL + "/rest/v1/app_data?key=eq." + key + "&select=value",
    { headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY } }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return (Array.isArray(rows) && rows[0]) ? rows[0].value : null;
};

const esc = (s) => String(s == null ? "" : s)
  .replace(/\\/g, "\\\\")
  .replace(/;/g, "\\;")
  .replace(/,/g, "\\,")
  .replace(/\r?\n/g, "\\n");

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

const dateCompact = (ymd) => (ymd || "").replace(/-/g, "");

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
  const m = /^(\d{1,2}):(\d{2})/.exec(t || "");
  if (!m) return null;
  return pad(m[1]) + pad(m[2]) + "00";
};

const addHour = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || "");
  if (!m) return null;
  const h = (parseInt(m[1], 10) + 1) % 24;
  return pad(h) + m[2] + "00";
};

// Shorten property display names for calendar summaries
const shortProp = (name) => {
  if (!name) return name;
  if (/hamlet/i.test(name)) return "Hamlet";
  if (/amly/i.test(name))   return "Amly";
  if (/glamp/i.test(name) || /camping/i.test(name)) return "Glamp";
  return name;
};

// Minimal Europe/London VTIMEZONE
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

// Ticketed events, read with the service key. Names and times only — no buyer
// details go anywhere near this feed.
const boxEvents = async () => {
  if (!SERVICE_KEY) return [];
  try {
    const res = await fetch(
      SUPABASE_URL + "/rest/v1/box_events?status=neq.draft&select=id,name,slug,starts_at,ends_at,venue_name,status",
      { headers: { "apikey": SERVICE_KEY, "Authorization": "Bearer " + SERVICE_KEY } }
    );
    if (!res.ok) return [];
    return await res.json();
  } catch (e) { return []; }
};

// The wall-clock time in London, as iCalendar wants it with a TZID.
const londonParts = (iso) => {
  const dtf = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p = {};
  dtf.formatToParts(new Date(iso)).forEach((x) => { p[x.type] = x.value; });
  return p.year + p.month + p.day + "T" + (p.hour === "24" ? "00" : p.hour) + p.minute + "00";
};

exports.handler = async () => {
  let bookings  = [];
  let enquiries = [];
  let accom     = [];
  let ticketed  = [];

  try { bookings  = (await sbGet(BOOKINGS_KEY))  || []; } catch (e) { bookings = []; }
  try { enquiries = (await sbGet(ENQUIRIES_KEY)) || []; } catch (e) { enquiries = []; }
  try { accom     = (await sbGet(ACCOM_KEY))     || []; } catch (e) { accom = []; }
  try { ticketed  = (await boxEvents())          || []; } catch (e) { ticketed = []; }

  const stamp = dtStamp();
  const lines = [];

  // ── 1. Wedding/event bookings — all-day ──────────────────────────────────
  bookings.forEach((b) => {
    if (!b || !b.date || !b.couple) return;
    const start = dateCompact(b.date);
    if (start.length !== 8) return;
    const holding = (b.status === "Holding");
    const summary = (holding ? "[HOLD] " : "") + b.couple;
    const descParts = [];
    if (b.status)     descParts.push("Status: " + b.status);
    if (b.mealGuests) descParts.push("Day guests: " + b.mealGuests);
    if (b.eveGuests)  descParts.push("Eve guests: " + b.eveGuests);
    if (b.phone)      descParts.push("Phone: " + b.phone);
    if (b.email)      descParts.push("Email: " + b.email);
    // Multi-day: use endDate if present
    const endYmd = (b.endDate && b.endDate > b.date) ? b.endDate : b.date;
    lines.push("BEGIN:VEVENT");
    lines.push("UID:booking-" + (b.id != null ? b.id : start) + "@hawthbushfarm.co.uk");
    lines.push("DTSTAMP:" + stamp);
    lines.push("SEQUENCE:0");
    lines.push("STATUS:CONFIRMED");
    lines.push("DTSTART;VALUE=DATE:" + start);
    lines.push("DTEND;VALUE=DATE:" + addDay(endYmd));
    lines.push(fold("SUMMARY:" + esc(summary)));
    if (descParts.length) lines.push(fold("DESCRIPTION:" + esc(descParts.join("\n"))));
    lines.push("CATEGORIES:Event");
    lines.push("TRANSP:TRANSPARENT");
    lines.push("END:VEVENT");
  });

  // ── 2. Viewings from bookings and enquiries ───────────────────────────────
  const pushViewing = (v, name, kind, srcId, vi) => {
    if (!v || !v.date) return;
    const start = dateCompact(v.date);
    if (start.length !== 8) return;
    const uid = "viewing-" + kind + "-" + srcId + "-" + vi + "@hawthbushfarm.co.uk";
    lines.push("BEGIN:VEVENT");
    lines.push("UID:" + uid);
    lines.push("DTSTAMP:" + stamp);
    lines.push("SEQUENCE:0");
    lines.push("STATUS:CONFIRMED");
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

  // ── 3. Lettings bookings — one VEVENT per stay ────────────────────────────
  accom.forEach((ab) => {
    if (!ab || ab.status === "cancelled") return;
    // Normalise: use stays[] if present, else treat flat booking as single stay
    var stays = (ab.stays && ab.stays.length) ? ab.stays : [{
      propertyId:   ab.propertyId,
      propertyName: ab.propertyName,
      checkIn:      ab.checkIn,
      checkOut:     ab.checkOut,
    }];
    stays.forEach(function(s, si) {
      if (!s.checkIn) return;
      const startStr = dateCompact(s.checkIn);
      if (startStr.length !== 8) return;
      const endYmd   = s.checkOut || s.checkIn;
      const propName = shortProp(s.propertyName || s.propertyId || "Accommodation");
      const guest    = ab.guestName || "Guest";
      const summary  = propName + ": " + guest;
      const descParts = [];
      if (ab.guestName)   descParts.push("Guest: " + ab.guestName);
      if (ab.phone)       descParts.push("Phone: " + ab.phone);
      if (ab.email)       descParts.push("Email: " + ab.email);
      if (ab.guestCount)  descParts.push("Guests: " + ab.guestCount);
      if (ab.source && ab.source !== "manual") descParts.push("Source: " + ab.source);
      if (ab.bookingType) descParts.push("Type: " + ab.bookingType);
      const uid = "accom-" + (ab.id || "x") + "-" + si + "@hawthbushfarm.co.uk";
      lines.push("BEGIN:VEVENT");
      lines.push("UID:" + uid);
      lines.push("DTSTAMP:" + stamp);
      lines.push("SEQUENCE:0");
      lines.push("STATUS:CONFIRMED");
      lines.push("DTSTART;VALUE=DATE:" + startStr);
      lines.push("DTEND;VALUE=DATE:" + dateCompact(endYmd));
      lines.push(fold("SUMMARY:" + esc(summary)));
      if (descParts.length) lines.push(fold("DESCRIPTION:" + esc(descParts.join("\n"))));
      lines.push("CATEGORIES:Lettings");
      lines.push("TRANSP:OPAQUE");
      lines.push("END:VEVENT");
    });
  });

  // ── 4. Ticketed events (Box Office) ──────────────────────────────────────
  ticketed.forEach((e) => {
    if (!e || !e.starts_at) return;
    const start = londonParts(e.starts_at);
    // Three hours is the usual shape of an evening in the Grain Store, and a
    // guessed end beats an event with no duration at all.
    const end = londonParts(e.ends_at || new Date(new Date(e.starts_at).getTime() + 3 * 3600000).toISOString());
    lines.push("BEGIN:VEVENT");
    lines.push("UID:boxevent-" + e.id + "@hawthbushfarm.co.uk");
    lines.push("DTSTAMP:" + stamp);
    lines.push("SEQUENCE:0");
    lines.push("STATUS:CONFIRMED");
    lines.push("DTSTART;TZID=Europe/London:" + start);
    lines.push("DTEND;TZID=Europe/London:" + end);
    lines.push(fold("SUMMARY:" + esc((e.status === "published" ? "" : "[" + e.status.toUpperCase() + "] ") + e.name)));
    lines.push(fold("DESCRIPTION:" + esc("Ticketed event · " + (e.venue_name || "The Grain Store"))));
    lines.push(fold("LOCATION:" + esc(e.venue_name || "The Grain Store")));
    lines.push("CATEGORIES:Box Office");
    lines.push("TRANSP:OPAQUE");
    lines.push("END:VEVENT");
  });

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Hawthbush Farm//Venue Ops//EN",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:Hawthbush Farm",
    "X-WR-TIMEZONE:Europe/London",
    "X-WR-CALDESC:Events\\, viewings\\, lettings and ticketed nights at Hawthbush Farm",
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
      "Content-Disposition": "inline; filename=\"hawthbush-farm.ics\"",
      "Cache-Control": "public, max-age=600",
      "Access-Control-Allow-Origin": "*",
    },
    body: ics,
  };
};
