// netlify/functions/property-calendar.js
// Returns an iCal feed for a single property so Airbnb can subscribe to
// availability.
//
//   /ical/hamlet.ics   (or /.netlify/functions/property-calendar?id=hamlet)
//
// Airbnb needs only the dates and ignores SUMMARY, and this URL is public and
// guessable, so every booking reads "Booked" or "Not available" — no guest
// names leave the building through here. The full picture, names included, is
// the calendar.ics feed subscribed to from Settings.
// Add a redirect in netlify.toml if you want a cleaner URL:
//   from = "/property-calendar/:id.ics"
//   to   = "/.netlify/functions/property-calendar?id=:id"
//
// Required env vars: SUPABASE_ANON_KEY (or hardcoded fallback below)

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJrcWJ5aXNmbXZ3dWxzeXh6d2p6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NTI0MzgsImV4cCI6MjA5NjUyODQzOH0._CsyhvFrtHFC0KrfiLzbrLUaKcvxtbWlHydaH20tvfo";
const ACCOM_KEY    = "hbf_accom_v1";

// Must match PENDING_HOLD_MINUTES in book-accom.html, or the two disagree
// about whether an abandoned checkout still holds its dates.
const PENDING_HOLD_MINUTES = 60;

async function sbGet(key) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data?key=eq." + key + "&select=value", {
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": "Bearer " + SUPABASE_KEY
    }
  });
  if (!res.ok) throw new Error("sbGet failed: " + await res.text());
  const rows = await res.json();
  return (rows && rows[0]) ? rows[0].value : null;
}

// "2024-06-15" → "20240615". Returns "" for anything that isn't a plain date,
// so a malformed booking is dropped rather than poisoning the whole feed —
// Airbnb rejects an entire calendar over one bad line.
function toIcalDate(iso) {
  var m = String(iso || "").slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? m[1] + m[2] + m[3] : "";
}

// DTSTAMP must be a full UTC date-time — "20231024T000000Z", never a bare
// date. createdAt is stored as a full ISO string in some places and as a
// plain "YYYY-MM-DD" in others, and the old code turned the latter into
// "20231024Z", which is invalid and made Airbnb reject the feed outright.
function toIcalStamp(value) {
  var d = value ? new Date(value) : null;
  if (!d || isNaN(d.getTime())) d = new Date();
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function escapeIcal(s) {
  return String(s || "").replace(/[,;\\]/g, "\\$&").replace(/\n/g, "\\n");
}

function foldLine(line) {
  // iCal lines must be max 75 octets; fold longer lines
  var result = "";
  while (line.length > 75) {
    result += line.slice(0, 75) + "\r\n ";
    line = line.slice(75);
  }
  return result + line;
}

exports.handler = async function(event) {
  // The id can arrive two ways, and the function must not depend on which:
  //
  //   ?id=hamlet                    — the direct function URL
  //   /ical/hamlet.ics              — the tidy URL Airbnb requires
  //
  // The rewrite for the second is written as "?id=:splat", but Netlify does
  // not reliably substitute a splat inside the query string of the target, so
  // the id is also recovered from the request path. Belt and braces: whichever
  // route works, the feed is served.
  var qs = (event.queryStringParameters && event.queryStringParameters.id) || "";
  var propertyId = String(qs);

  if (!propertyId || propertyId.indexOf(":") !== -1) {
    // rawUrl is the original address, unaffected by the rewrite; event.path
    // is the fallback for older runtimes.
    var raw = event.rawUrl || event.path || "";
    try { raw = new URL(raw, "https://x").pathname; } catch (e) { raw = String(raw).split("?")[0]; }
    var last = String(raw).split("/").filter(Boolean).pop() || "";
    // Guard against picking up the function's own name when called directly
    // with no id at all.
    propertyId = (last === "property-calendar") ? "" : last;
  }

  // Airbnb insists on a URL ending in .ics, so the extension is stripped here
  // rather than being special-cased in the redirect.
  propertyId = propertyId.replace(/\.ics$/i, "");
  if (!propertyId || !/^[a-z0-9_-]{1,40}$/i.test(propertyId)) {
    return { statusCode: 400, body: "Missing or invalid ?id= parameter. Use ?id=hamlet, ?id=amly, or ?id=glamping." };
  }


  var bookings;
  try {
    bookings = await sbGet(ACCOM_KEY) || [];
  } catch (e) {
    console.error("property-calendar sbGet error:", e);
    return { statusCode: 500, body: "Could not load bookings" };
  }

  // Only recent and future stays are published. Anything that finished more
  // than 30 days ago can't affect availability, and a leaner feed is quicker
  // for the other side to accept.
  var cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 30);
  var cutoff = cutoffDate.toISOString().slice(0, 10).replace(/-/g, "");

  // Build VEVENT list for this property
  var lines = [];
  var eventSeq = 0;
  bookings.forEach(function(b) {
    if (b.status === "cancelled") return;

    // An online booking is written to the database before the guest reaches
    // Stripe, so an abandoned checkout leaves an unpaid "pending" row. The
    // public booking page releases those after an hour; without the same rule
    // here they would block the dates on Airbnb permanently. A pending row
    // whose deposit is paid keeps its block — that is a real booking whose
    // status simply hasn't caught up.
    if (b.status === "pending") {
      var dep = (b.schedule || []).find(function(x) { return x.label === "Deposit"; });
      var paid = dep && dep.paid;
      var age = b.createdAt ? (Date.now() - new Date(b.createdAt).getTime()) : 0;
      if (!paid && isFinite(age) && age > PENDING_HOLD_MINUTES * 60 * 1000) return;
    }
    var stays = (b.stays && b.stays.length) ? b.stays : [b];
    stays.forEach(function(s, stayIdx) {
      if (s.propertyId !== propertyId) return;
      if (!s.checkIn || !s.checkOut) return;

      // The UID must be unique across the whole feed — Airbnb rejects a
      // calendar containing two VEVENTs with the same UID, since by the spec
      // that means one event redefining another.
      //
      // Deriving it from the booking id isn't enough: the data contains
      // records that share an id (a booking duplicated in error keeps the id
      // of the original), and one booking can hold two stays in the same
      // property. A running counter makes it unique by construction, whatever
      // state the data is in. The booking id is kept in the UID for
      // traceability, but uniqueness no longer depends on it.
      eventSeq += 1;
      var uid = "hbf-" + eventSeq + "-" + String(b.id) + "-" + String(s.propertyId) +
                "@hawthbushfarm.co.uk";
      // Deliberately says only that the dates are taken.
      var summary = b.bookingType === "Blocked" ? "Not available"
                  : b.source === "airbnb"        ? "Airbnb block"
                  : "Booked";
      var start = toIcalDate(s.checkIn);
      var end   = toIcalDate(s.checkOut);
      if (!start || !end || end <= start) return;   // unusable dates: skip the event, keep the feed
      if (end < cutoff) return;                     // finished long ago — blocks nothing, only bulk

      lines.push(foldLine("BEGIN:VEVENT"));
      lines.push(foldLine("DTEND;VALUE=DATE:" + end));
      lines.push(foldLine("DTSTAMP:" + toIcalStamp(b.createdAt)));
      lines.push(foldLine("DTSTART;VALUE=DATE:" + start));
      lines.push(foldLine("SEQUENCE:0"));
      lines.push(foldLine("STATUS:CONFIRMED"));
      lines.push(foldLine("SUMMARY:" + escapeIcal(summary)));
      lines.push(foldLine("UID:" + uid));
      lines.push(foldLine("END:VEVENT"));
    });
  });

  // Kept deliberately close to the Bookalet feed Airbnb already accepts:
  // properties in alphabetical order within each VEVENT, SEQUENCE and STATUS
  // present, and no METHOD or X-WR-* extensions. Those extras are valid iCal
  // but there is no reason to hand a fussy importer anything it doesn't need.
  var ical = [
    "BEGIN:VCALENDAR",
    "CALSCALE:GREGORIAN",
    "PRODID:-//Hawthbush Farm//Lettings//EN",
    "VERSION:2.0",
    "X-WR-CALNAME:Hawthbush Farm - " + propertyId
  ].concat(lines).concat(["END:VCALENDAR"]).join("\r\n") + "\r\n";

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "no-cache"
    },
    body: ical
  };
};
