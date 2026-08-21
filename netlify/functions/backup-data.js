// netlify/functions/backup-data.js
//
// Daily snapshot of every data key into a dated Supabase row, so a bad write
// (or a mistaken delete) can be rolled back. Runs on a schedule from
// netlify.toml and can also be triggered by hand from Settings → Backup.
//
// Deliberately kept inside Supabase: the failure this protects against is the
// app overwriting its own data, not Supabase disappearing. For an off-platform
// copy, download the JSON from Settings → Backup and keep it wherever you like.
//
// Snapshots are stored under  hbf_backup_YYYY-MM-DD  and an index of them under
// hbf_backup_index_v1, with the oldest pruned beyond KEEP_SNAPSHOTS.

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJrcWJ5aXNmbXZ3dWxzeXh6d2p6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NTI0MzgsImV4cCI6MjA5NjUyODQzOH0._CsyhvFrtHFC0KrfiLzbrLUaKcvxtbWlHydaH20tvfo";

const INDEX_KEY = "hbf_backup_index_v1";
const KEEP_SNAPSHOTS = 30;

// Every key holding real data. Backup rows themselves are never included.
const DATA_KEYS = [
  "hawthbush_bookings_v6",
  "hawthbush_staff_v5",
  "hbf_accom_v1",
  "hbf_accom_guests_v1",
  "hbf_properties_v1",
  "hbf_enquiries_v1",
  "hbf_viewings_v1",
  "hbf_viewing_requests_v1",
  "hbf_viewing_blocks_v1",
  "hbf_bar_products_v1",
  "hbf_bar_events_v1",
  "hbf_bar_pos_map_v1",
  "hbf_discount_codes_v1",
  "hbf_email_templates_v1",
  "hbf_email_log_v1",
  "hbf_event_invoices_v1",
  "hbf_terms_v1",
  "hbf_starred_emails_v1"
];

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

async function sbDelete(key) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data?key=eq." + key, {
    method: "DELETE",
    headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY }
  });
  if (!res.ok) throw new Error("sbDelete " + key + " failed: " + await res.text());
}

exports.handler = async function(event) {
  const today = new Date().toISOString().slice(0, 10);
  const snapshotKey = "hbf_backup_" + today;

  try {
    // ── Collect ──────────────────────────────────────────────────────────────
    const data = {};
    const counts = {};
    const missing = [];
    for (let i = 0; i < DATA_KEYS.length; i++) {
      const k = DATA_KEYS[i];
      const v = await sbGet(k);
      if (v === null || v === undefined) { missing.push(k); continue; }
      data[k] = v;
      counts[k] = Array.isArray(v) ? v.length : 1;
    }

    // Refuse to write an empty or near-empty snapshot over a good one — a
    // snapshot recording that everything vanished is worse than no snapshot.
    const populated = Object.keys(data).length;
    if (!populated) {
      return jsonResponse(500, { error: "Nothing readable to back up — snapshot skipped." });
    }

    const snapshot = {
      takenAt: new Date().toISOString(),
      date: today,
      keys: Object.keys(data),
      counts: counts,
      missing: missing,
      data: data
    };

    const bytes = JSON.stringify(snapshot).length;
    await sbSet(snapshotKey, snapshot);

    // ── Index + prune ────────────────────────────────────────────────────────
    let index = [];
    try { index = (await sbGet(INDEX_KEY)) || []; } catch (e) { index = []; }
    if (!Array.isArray(index)) index = [];

    index = index.filter(function(e) { return e && e.key !== snapshotKey; });
    index.push({ key: snapshotKey, date: today, takenAt: snapshot.takenAt, counts: counts, bytes: bytes });
    index.sort(function(a, b) { return (a.date || "") > (b.date || "") ? -1 : 1; }); // newest first

    const keep = index.slice(0, KEEP_SNAPSHOTS);
    const drop = index.slice(KEEP_SNAPSHOTS);
    for (let i = 0; i < drop.length; i++) {
      try { await sbDelete(drop[i].key); } catch (e) { console.error("prune failed", drop[i].key, e.message); }
    }
    await sbSet(INDEX_KEY, keep);

    return jsonResponse(200, {
      ok: true,
      snapshot: snapshotKey,
      takenAt: snapshot.takenAt,
      keysBackedUp: populated,
      counts: counts,
      missing: missing,
      pruned: drop.map(function(d) { return d.key; }),
      totalSnapshots: keep.length
    });

  } catch (err) {
    console.error("backup-data error:", err);
    return jsonResponse(500, { error: String(err.message || err) });
  }
};
