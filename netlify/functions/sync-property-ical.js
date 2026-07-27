// netlify/functions/sync-property-ical.js
// Fetches Airbnb's iCal URL for a property, parses blocks, and imports
// any new ones into hbf_accom_v1. Called from the Lettings > Setup > Airbnb Sync UI.
//
// POST /.netlify/functions/sync-property-ical
// Body: { propertyId: "hamlet" }
//
// Returns: { imported: N, total: M, skipped: K }
//
// Required env vars: SUPABASE_ANON_KEY (or hardcoded fallback below)

const SUPABASE_URL  = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SUPABASE_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJrcWJ5aXNmbXZ3dWxzeXh6d2p6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NTI0MzgsImV4cCI6MjA5NjUyODQzOH0._CsyhvFrtHFC0KrfiLzbrLUaKcvxtbWlHydaH20tvfo";
const ACCOM_KEY     = "hbf_accom_v1";
const PROPS_KEY     = "hbf_properties_v1";

// ── Supabase helpers ──────────────────────────────────────────────────────────
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

async function sbSet(key, value) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data", {
    method: "POST",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates"
    },
    body: JSON.stringify({ key: key, value: value })
  });
  if (!res.ok) throw new Error("sbSet failed: " + await res.text());
}

// ── iCal parser ───────────────────────────────────────────────────────────────
function parseDate(s) {
  s = (s || "").trim().replace(/\r/g, "");
  // Handle DATE format: 20240601 or DATE-TIME: 20240601T160000Z
  var m = s.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return m[1] + "-" + m[2] + "-" + m[3];
}

function getField(block, field) {
  // Match "FIELD:" or "FIELD;...:value" at start of line
  var re = new RegExp("^" + field + "[^:]*:(.+)$", "im");
  var m = block.match(re);
  return m ? m[1].trim().replace(/\r/g, "") : null;
}

// Airbnb pads its export feed with placeholder blocks (host-set "Not available"
// ranges, min-stay padding, etc.) that aren't real guest reservations. These are
// not imported — we don't want them cluttering the accommodation calendar.
function isIgnorableBlock(summary) {
  var s = (summary || "").trim().toLowerCase();
  return s.indexOf("not available") !== -1 || s === "blocked" || s === "airbnb (not available)";
}

function parseIcal(text) {
  var events = [];
  // Split on BEGIN:VEVENT — index 0 is before first event
  var parts = text.split("BEGIN:VEVENT");
  for (var i = 1; i < parts.length; i++) {
    var block = parts[i];
    var uid     = getField(block, "UID")     || "";
    var summary = getField(block, "SUMMARY") || "";
    var start   = parseDate(getField(block, "DTSTART") || "");
    var end     = parseDate(getField(block, "DTEND")   || "");
    // Skip events with no valid dates
    if (!start || !end) continue;
    // Skip Airbnb's own "not available" placeholder blocks — not real bookings
    if (isIgnorableBlock(summary)) continue;
    events.push({ uid: uid, summary: summary, start: start, end: end });
  }
  return events;
}

function nightsBetween(ci, co) {
  if (!ci || !co) return 0;
  return Math.round((new Date(co + "T00:00:00") - new Date(ci + "T00:00:00")) / 86400000);
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  var body;
  try { body = JSON.parse(event.body); } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  var propertyId = body.propertyId;
  if (!propertyId) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing propertyId" }) };
  }

  try {
    // ── 1. Load property settings ─────────────────────────────────────────────
    var properties = await sbGet(PROPS_KEY) || [];
    var prop = null;
    for (var pi = 0; pi < properties.length; pi++) {
      if (properties[pi].id === propertyId) { prop = properties[pi]; break; }
    }
    if (!prop) {
      return { statusCode: 404, body: JSON.stringify({ error: "Property not found: " + propertyId }) };
    }
    if (!prop.airbnbImportUrl) {
      return { statusCode: 400, body: JSON.stringify({ error: "No Airbnb import URL set for " + prop.name }) };
    }

    // ── 2. Fetch Airbnb iCal ─────────────────────────────────────────────────
    var icalRes = await fetch(prop.airbnbImportUrl, {
      headers: { "User-Agent": "HawthbushFarm/1.0 (iCal sync)" }
    });
    if (!icalRes.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: "Failed to fetch Airbnb iCal: HTTP " + icalRes.status }) };
    }
    var icalText = await icalRes.text();

    // ── 3. Parse events ──────────────────────────────────────────────────────
    var feedEvents = parseIcal(icalText);

    // ── 4. Load existing bookings ────────────────────────────────────────────
    var bookings = await sbGet(ACCOM_KEY) || [];

    // Build set of existing Airbnb UIDs so we don't duplicate
    var existingUids = {};
    for (var bi = 0; bi < bookings.length; bi++) {
      if (bookings[bi].airbnbUid) {
        existingUids[bookings[bi].airbnbUid] = true;
      }
    }

    // ── 5. Create new blocks ─────────────────────────────────────────────────
    var newBlocks = [];
    var now = new Date().toISOString();

    for (var fi = 0; fi < feedEvents.length; fi++) {
      var fe = feedEvents[fi];
      if (existingUids[fe.uid]) continue; // already imported

      var nights = nightsBetween(fe.start, fe.end);
      var block = {
        id:              "ical-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
        guestName:       fe.summary || "Airbnb block",
        email:           "",
        phone:           "",
        guestCount:      1,
        source:          "airbnb",
        status:          "confirmed",
        bookingType:     "",
        linkedEventId:   null,
        stays:           [{ propertyId: propertyId, propertyName: prop.name, checkIn: fe.start, checkOut: fe.end, nights: nights, value: 0 }],
        value:           0,
        estimated:       false,
        extras:          [],
        breakage:        0,
        breakageStripeId: null,
        discountCode:    "",
        discountAmount:  0,
        schedule:        [],
        notes:           "Imported from Airbnb iCal sync (" + now.slice(0,10) + ")",
        createdAt:       now,
        airbnbUid:       fe.uid
      };
      newBlocks.push(block);
    }

    // ── 6. Write new blocks back to Supabase ─────────────────────────────────
    if (newBlocks.length > 0) {
      await sbSet(ACCOM_KEY, bookings.concat(newBlocks));
    }

    // ── 7. Update property lastSyncedAt ──────────────────────────────────────
    var updatedProps = properties.map(function(p) {
      if (p.id !== propertyId) return p;
      return Object.assign({}, p, { lastSyncedAt: now });
    });
    await sbSet(PROPS_KEY, updatedProps);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imported: newBlocks.length,
        total:    feedEvents.length,
        skipped:  feedEvents.length - newBlocks.length
      })
    };

  } catch (err) {
    console.error("sync-property-ical error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Sync failed: " + err.message })
    };
  }
};
