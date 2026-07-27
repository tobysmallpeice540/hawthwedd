// netlify/functions/sync-all-icals.js
// Scheduled function — runs every hour via cron "0 * * * *"
// Fetches Airbnb iCal for every property that has an airbnbImportUrl set,
// and imports any new blocks into hbf_accom_v1.
//
// Schedule is declared in netlify.toml:
//   [[functions]]
//   name = "sync-all-icals"
//   schedule = "0 * * * *"

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJrcWJ5aXNmbXZ3dWxzeXh6d2p6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NTI0MzgsImV4cCI6MjA5NjUyODQzOH0._CsyhvFrtHFC0KrfiLzbrLUaKcvxtbWlHydaH20tvfo";
const ACCOM_KEY    = "hbf_accom_v1";
const PROPS_KEY    = "hbf_properties_v1";

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
  var m = s.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return m[1] + "-" + m[2] + "-" + m[3];
}

function getField(block, field) {
  var re = new RegExp("^" + field + "[^:]*:(.+)$", "im");
  var m = block.match(re);
  return m ? m[1].trim().replace(/\r/g, "") : null;
}

function parseIcal(text) {
  var events = [];
  var parts = text.split("BEGIN:VEVENT");
  for (var i = 1; i < parts.length; i++) {
    var block = parts[i];
    var uid     = getField(block, "UID")     || "";
    var summary = getField(block, "SUMMARY") || "";
    var start   = parseDate(getField(block, "DTSTART") || "");
    var end     = parseDate(getField(block, "DTEND")   || "");
    if (!start || !end) continue;
    events.push({ uid: uid, summary: summary, start: start, end: end });
  }
  return events;
}

function nightsBetween(ci, co) {
  if (!ci || !co) return 0;
  return Math.round((new Date(co + "T00:00:00") - new Date(ci + "T00:00:00")) / 86400000);
}

// ── Sync one property ─────────────────────────────────────────────────────────
async function syncProperty(prop, bookings, now) {
  if (!prop.airbnbImportUrl) return { imported: 0, skipped: 0, total: 0 };

  // Fetch Airbnb iCal
  var icalRes = await fetch(prop.airbnbImportUrl, {
    headers: { "User-Agent": "HawthbushFarm/1.0 (iCal sync)" }
  });
  if (!icalRes.ok) throw new Error("HTTP " + icalRes.status + " fetching iCal for " + prop.name);
  var icalText = await icalRes.text();

  var feedEvents = parseIcal(icalText);

  // Build set of existing Airbnb UIDs
  var existingUids = {};
  for (var bi = 0; bi < bookings.length; bi++) {
    if (bookings[bi].airbnbUid) existingUids[bookings[bi].airbnbUid] = true;
  }

  var newBlocks = [];
  for (var fi = 0; fi < feedEvents.length; fi++) {
    var fe = feedEvents[fi];
    if (existingUids[fe.uid]) continue;
    newBlocks.push({
      id:               "ical-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      guestName:        fe.summary || "Airbnb block",
      email:            "",
      phone:            "",
      guestCount:       1,
      source:           "airbnb",
      status:           "confirmed",
      bookingType:      "",
      linkedEventId:    null,
      stays:            [{ propertyId: prop.id, propertyName: prop.name, checkIn: fe.start, checkOut: fe.end, nights: nightsBetween(fe.start, fe.end), value: 0 }],
      value:            0,
      estimated:        false,
      extras:           [],
      breakage:         0,
      breakageStripeId: null,
      discountCode:     "",
      discountAmount:   0,
      schedule:         [],
      notes:            "Auto-synced from Airbnb iCal (" + now.slice(0,10) + ")",
      createdAt:        now,
      airbnbUid:        fe.uid
    });
  }

  return { newBlocks: newBlocks, total: feedEvents.length, imported: newBlocks.length, skipped: feedEvents.length - newBlocks.length };
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async function() {
  var now = new Date().toISOString();
  console.log("[sync-all-icals] Starting hourly iCal sync at " + now);

  try {
    var properties = await sbGet(PROPS_KEY) || [];
    var syncable = properties.filter(function(p) { return p.airbnbImportUrl; });

    if (!syncable.length) {
      console.log("[sync-all-icals] No properties have an Airbnb import URL set. Done.");
      return { statusCode: 200, body: "No properties to sync" };
    }

    // Load bookings once, then accumulate new blocks across all properties
    var bookings = await sbGet(ACCOM_KEY) || [];
    var allNewBlocks = [];
    var results = [];

    for (var i = 0; i < syncable.length; i++) {
      var prop = syncable[i];
      try {
        var result = await syncProperty(prop, bookings.concat(allNewBlocks), now);
        if (result.newBlocks && result.newBlocks.length) {
          allNewBlocks = allNewBlocks.concat(result.newBlocks);
        }
        results.push({ property: prop.name, imported: result.imported, total: result.total });
        console.log("[sync-all-icals] " + prop.name + ": " + result.imported + " new / " + result.total + " total");
      } catch (propErr) {
        console.error("[sync-all-icals] Error syncing " + prop.name + ":", propErr.message);
        results.push({ property: prop.name, error: propErr.message });
      }
    }

    // Persist new bookings (if any)
    if (allNewBlocks.length) {
      await sbSet(ACCOM_KEY, bookings.concat(allNewBlocks));
      console.log("[sync-all-icals] Saved " + allNewBlocks.length + " new blocks total.");
    }

    // Update lastSyncedAt on all synced properties
    var updatedProps = properties.map(function(p) {
      if (!p.airbnbImportUrl) return p;
      return Object.assign({}, p, { lastSyncedAt: now });
    });
    await sbSet(PROPS_KEY, updatedProps);

    var totalImported = allNewBlocks.length;
    console.log("[sync-all-icals] Done. Total imported: " + totalImported);
    return {
      statusCode: 200,
      body: JSON.stringify({ results: results, totalImported: totalImported })
    };

  } catch (err) {
    console.error("[sync-all-icals] Fatal error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
