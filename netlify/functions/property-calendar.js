// netlify/functions/property-calendar.js
// Returns an iCal feed for a single property so Airbnb can subscribe to availability.
//
// URL: /.netlify/functions/property-calendar?id=hamlet
// Add a redirect in netlify.toml if you want a cleaner URL:
//   from = "/property-calendar/:id.ics"
//   to   = "/.netlify/functions/property-calendar?id=:id"
//
// Required env vars: SUPABASE_ANON_KEY (or hardcoded fallback below)

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJrcWJ5aXNmbXZ3dWxzeXh6d2p6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NTI0MzgsImV4cCI6MjA5NjUyODQzOH0._CsyhvFrtHFC0KrfiLzbrLUaKcvxtbWlHydaH20tvfo";
const ACCOM_KEY    = "hbf_accom_v1";

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

function toIcalDate(iso) {
  // "2024-06-15" → "20240615"
  return (iso || "").replace(/-/g, "");
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
  var propertyId = event.queryStringParameters && event.queryStringParameters.id;
  if (!propertyId) {
    return { statusCode: 400, body: "Missing ?id= parameter. Use ?id=hamlet, ?id=amly, or ?id=glamping." };
  }

  var bookings;
  try {
    bookings = await sbGet(ACCOM_KEY) || [];
  } catch (e) {
    console.error("property-calendar sbGet error:", e);
    return { statusCode: 500, body: "Could not load bookings" };
  }

  // Build VEVENT list for this property
  var lines = [];
  bookings.forEach(function(b) {
    if (b.status === "cancelled") return;
    var stays = (b.stays && b.stays.length) ? b.stays : [b];
    stays.forEach(function(s) {
      if (s.propertyId !== propertyId) return;
      if (!s.checkIn || !s.checkOut) return;

      var uid = String(b.id) + "-" + String(s.propertyId) + "@hawthbushfarm.co.uk";
      var summary = b.bookingType === "Blocked" ? "Not available"
                  : b.source === "airbnb"        ? "Airbnb block"
                  : b.guestName                  ? b.guestName
                  : "Booked";
      var created = b.createdAt
        ? b.createdAt.replace(/[-:]/g, "").replace(/\.\d+/, "").slice(0, 15) + "Z"
        : new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "").slice(0, 15) + "Z";

      lines.push(foldLine("BEGIN:VEVENT"));
      lines.push(foldLine("UID:" + uid));
      lines.push(foldLine("DTSTART;VALUE=DATE:" + toIcalDate(s.checkIn)));
      lines.push(foldLine("DTEND;VALUE=DATE:" + toIcalDate(s.checkOut)));
      lines.push(foldLine("SUMMARY:" + escapeIcal(summary)));
      lines.push(foldLine("DTSTAMP:" + created));
      lines.push(foldLine("END:VEVENT"));
    });
  });

  var ical = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Hawthbush Farm//Lettings//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Hawthbush Farm - " + propertyId,
    "X-WR-CALDESC:Availability calendar for " + propertyId
  ].concat(lines).concat(["END:VCALENDAR"]).join("\r\n") + "\r\n";

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": "inline; filename=" + propertyId + ".ics",
      "Cache-Control": "no-cache"
    },
    body: ical
  };
};
