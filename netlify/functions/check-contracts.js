// netlify/functions/check-contracts.js
//
// Ask SignWell once a day what has happened to every contract that is still
// out for signature, and record the answer on the event.
//
// WHY THIS EXISTS, given the standing decision not to run a SignWell webhook.
// That decision stands and this does not overturn it. A webhook fires at an
// unpredictable moment — very possibly while somebody has an event open and is
// typing into it — and would have to rewrite the whole events array from a
// background process, which is exactly how records have been lost in this
// project before. This job is a different trade in three ways:
//
//   1. It runs at 04:00, when nobody is in the app.
//   2. It writes ONLY the `contract` sub-object of the events it checked.
//      Every other field of every event, and every other event, is passed
//      through untouched.
//   3. It re-reads the array immediately before writing, so the window in
//      which a concurrent edit could be lost is the write itself rather than
//      the whole SignWell round trip.
//
// It deliberately does NOT file the signed PDF. That needs an upload into
// storage and an edit to the event's files list, which is a much bigger write
// than a status field, and it happens on its own the next time anybody opens
// the event's Contract tab. What this job gives you is a home page that is
// truthful without anyone pressing anything.
//
// Required env vars: SUPABASE_SERVICE_KEY · SIGNWELL_API_KEY

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SIGNWELL_KEY = process.env.SIGNWELL_API_KEY;
const SIGNWELL_API = "https://www.signwell.com/api/v1";

const BOOKING_KEY = "hawthbush_bookings_v6";

// Statuses that mean there is nothing left to find out.
const SETTLED = ["completed", "declined", "voided", "expired", "canceled", "cancelled"];

function jsonResponse(statusCode, body) {
  return { statusCode: statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function sbGet(key) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data?key=eq." + key + "&select=value", {
    headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY }
  });
  if (!res.ok) throw new Error("sbGet " + key + " failed: " + await res.text());
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
  if (!res.ok) throw new Error("sbSet " + key + " failed: " + await res.text());
}

async function signwellDoc(documentId) {
  const res = await fetch(SIGNWELL_API + "/documents/" + documentId + "/", {
    headers: { "X-Api-Key": SIGNWELL_KEY, "Accept": "application/json" }
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) {}
  return { ok: res.ok, status: res.status, body: json, text: text };
}

// Field values come back nested per page, exactly as signwell.js flattens them.
// Kept identical on purpose: the app reads contract.values written by either
// path and must not have to care which one wrote it.
function flatValues(doc) {
  const flat = [];
  const raw = (doc && doc.fields) || [];
  (Array.isArray(raw) ? raw : []).forEach(function(pageOrField) {
    if (Array.isArray(pageOrField)) pageOrField.forEach(function(f) { flat.push(f); });
    else flat.push(pageOrField);
  });
  const values = {};
  flat.forEach(function(f) { if (f && f.api_id) values[f.api_id] = f.value; });
  return values;
}

function isSettled(status) {
  return SETTLED.indexOf(String(status || "").toLowerCase()) !== -1;
}

// Which events are worth asking about: a real (non-test) contract that has
// been sent and has not reached an end state.
function outstanding(bookings) {
  return (bookings || []).filter(function(b) {
    const c = b && b.contract;
    if (!c || !c.documentId || !c.sentAt) return false;
    if (c.testMode) return false;
    return !isSettled(c.status);
  });
}

exports.handler = async function() {
  if (!SUPABASE_KEY) return jsonResponse(500, { error: "SUPABASE_SERVICE_KEY is not set." });
  if (!SIGNWELL_KEY) return jsonResponse(500, { error: "SIGNWELL_API_KEY is not set." });

  const startedAt = new Date().toISOString();

  let bookings;
  try { bookings = await sbGet(BOOKING_KEY); }
  catch (e) {
    console.error("check-contracts: could not read bookings", e);
    return jsonResponse(502, { error: String(e.message || e) });
  }
  if (!Array.isArray(bookings)) {
    // Never write from an unknown base — the same rule the app follows.
    return jsonResponse(500, { error: "Bookings did not come back as an array; nothing was written." });
  }

  const todo = outstanding(bookings);
  if (!todo.length) {
    return jsonResponse(200, { checked: 0, changed: 0, note: "No contracts are out for signature." });
  }

  // Ask SignWell about each one. A failure on a single document must not stop
  // the others — one dead document id should not freeze the whole sweep.
  const results = {};
  const failures = [];
  for (let i = 0; i < todo.length; i++) {
    const c = todo[i].contract;
    try {
      const doc = await signwellDoc(c.documentId);
      if (!doc.ok) { failures.push({ documentId: c.documentId, status: doc.status }); continue; }
      results[c.documentId] = {
        status: doc.body && doc.body.status,
        values: flatValues(doc.body),
        recipients: (doc.body && doc.body.recipients) || []
      };
    } catch (e) {
      failures.push({ documentId: c.documentId, error: String(e.message || e) });
    }
  }

  const found = Object.keys(results);
  if (!found.length) {
    return jsonResponse(502, { checked: todo.length, changed: 0, failures: failures,
      error: "Every SignWell lookup failed; nothing was written." });
  }

  // Re-read immediately before writing, so an edit made while we were talking
  // to SignWell survives.
  let latest;
  try { latest = await sbGet(BOOKING_KEY); }
  catch (e) {
    console.error("check-contracts: could not re-read bookings before writing", e);
    return jsonResponse(502, { error: "Could not re-read bookings; nothing was written." });
  }
  if (!Array.isArray(latest)) {
    return jsonResponse(500, { error: "Bookings did not come back as an array on re-read; nothing was written." });
  }

  const changed = [];
  const next = latest.map(function(b) {
    const c = b && b.contract;
    if (!c || !c.documentId) return b;
    const r = results[c.documentId];
    if (!r) return b;
    // Don't rewrite a record that has not moved. Fewer writes, and the
    // "changed" count in the log then means something.
    const settledNow = isSettled(r.status);
    const sameStatus = String(r.status || "").toLowerCase() === String(c.status || "").toLowerCase();
    if (sameStatus && !settledNow) {
      return Object.assign({}, b, { contract: Object.assign({}, c, { checkedAt: startedAt }) });
    }
    changed.push({ eventId: b.id, couple: b.couple, from: c.status, to: r.status });
    return Object.assign({}, b, {
      contract: Object.assign({}, c, {
        status: r.status,
        values: r.values && Object.keys(r.values).length ? r.values : c.values,
        recipients: r.recipients && r.recipients.length ? r.recipients : c.recipients,
        checkedAt: startedAt,
        // Stamped once, the first time we see it signed. The app uses this to
        // flag a signed contract whose PDF has not been filed yet.
        completedAt: (settledNow && String(r.status).toLowerCase() === "completed")
          ? (c.completedAt || startedAt) : c.completedAt
      })
    });
  });

  // Same tripwire as the app: a status sweep must never change how many events
  // exist. If it would, something is badly wrong — refuse rather than write.
  if (next.length !== latest.length) {
    console.error("check-contracts: refusing to write, event count changed",
      { before: latest.length, after: next.length });
    return jsonResponse(500, { error: "Event count changed during the sweep; nothing was written." });
  }

  try { await sbSet(BOOKING_KEY, next); }
  catch (e) {
    console.error("check-contracts: write failed", e);
    return jsonResponse(502, { error: String(e.message || e) });
  }

  return jsonResponse(200, {
    checked: todo.length,
    looked_up: found.length,
    changed: changed.length,
    changes: changed,
    failures: failures
  });
};
