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
// The service key, not the anon key. Server-side code has no business
// holding the same credential the public pages carry — and once app_data
// has row level security this is what keeps the scheduled jobs working.
// No fallback to the anon key on purpose: a missing variable should fail
// loudly rather than quietly reopen what this change closes.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
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

// RFC5545 line folding: continuation lines start with a single space or tab.
// Airbnb's DESCRIPTION field (which carries the reservation URL) is long enough
// to get folded, so we need to unfold before reading fields off it.
function unfoldIcal(text) {
  return (text || "").replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
}

function unescapeIcalText(s) {
  return (s || "")
    .replace(/\\n/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function getField(block, field) {
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
  var unfolded = unfoldIcal(text);
  var events = [];
  var parts = unfolded.split("BEGIN:VEVENT");
  for (var i = 1; i < parts.length; i++) {
    var block = parts[i];
    var uid     = getField(block, "UID")     || "";
    var summary = getField(block, "SUMMARY") || "";
    var start   = parseDate(getField(block, "DTSTART") || "");
    var end     = parseDate(getField(block, "DTEND")   || "");
    if (!start || !end) continue;
    if (isIgnorableBlock(summary)) continue;
    // DESCRIPTION carries "Reservation URL: ...\nPhone Number (Last 4 Digits): ...."
    var description = unescapeIcalText(getField(block, "DESCRIPTION") || "");
    events.push({ uid: uid, summary: summary, start: start, end: end, description: description });
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
      notes:            fe.description || ("Auto-synced from Airbnb iCal (" + now.slice(0,10) + ")"),
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
        results.push({ id: prop.id, property: prop.name, imported: result.imported, total: result.total });
        console.log("[sync-all-icals] " + prop.name + ": " + result.imported + " new / " + result.total + " total");
      } catch (propErr) {
        console.error("[sync-all-icals] Error syncing " + prop.name + ":", propErr.message);
        results.push({ id: prop.id, property: prop.name, error: propErr.message });
      }
    }

    // Persist new bookings (if any). The Airbnb fetches above can take many
    // seconds, so the array read at the start is stale by now: re-read it and
    // append only the imports that are still missing (by airbnbUid). Nothing
    // else in the fresh copy is touched, so an edit or a deletion made in the
    // app meanwhile survives.
    var totalImported = 0;
    if (allNewBlocks.length) {
      var merged = mergeNewImports(await sbGet(ACCOM_KEY) || [], allNewBlocks);
      if (merged.added) {
        await sbSet(ACCOM_KEY, merged.list);
        console.log("[sync-all-icals] Saved " + merged.added + " new blocks total.");
      }
      totalImported = merged.added;
    }

    // Stamp lastSyncedAt on the properties that actually synced, onto a fresh
    // copy of the settings — and only write if one did.
    var syncedIds = results.filter(function(r) { return !r.error; }).map(function(r) { return r.id; });
    if (syncedIds.length) {
      var stamped = stampSynced(await sbGet(PROPS_KEY) || [], syncedIds, now);
      if (stamped.changed) await sbSet(PROPS_KEY, stamped.list);
    }

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

// Append imported blocks to a freshly read bookings array, skipping any whose
// airbnbUid is already there (another sync, or the per-property button, may
// have imported it meanwhile). Returns { list, added }.
function mergeNewImports(fresh, newBlocks) {
  var list = Array.isArray(fresh) ? fresh.slice() : [];
  var have = {};
  list.forEach(function(b) { if (b && b.airbnbUid) have[b.airbnbUid] = true; });
  var added = 0;
  (newBlocks || []).forEach(function(nb) {
    if (!nb || (nb.airbnbUid && have[nb.airbnbUid])) return;
    if (nb.airbnbUid) have[nb.airbnbUid] = true;
    list.push(nb);
    added++;
  });
  return { list: list, added: added };
}

// Set lastSyncedAt on the given property ids in a freshly read settings list.
function stampSynced(fresh, ids, now) {
  var changed = false;
  var list = (Array.isArray(fresh) ? fresh : []).map(function(p) {
    if (!p || ids.indexOf(p.id) === -1 || !p.airbnbImportUrl) return p;
    changed = true;
    return Object.assign({}, p, { lastSyncedAt: now });
  });
  return { list: list, changed: changed };
}

exports._internals = { mergeNewImports, stampSynced, parseIcal };
