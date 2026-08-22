// netlify/functions/brevo-sync.js
// Keeps four Brevo lists topped up from the app's own records.
//
//   Box Office      (#8)  ← ticket buyers            box_orders
//   Wedding Couples (#7)  ← weddings actually booked hawthbush_bookings_v6
//   Event Enquiries (#6)  ← event enquiries          hbf_enquiries_v1
//   Cottage Guests  (#3)  ← lettings bookings        hbf_accom_v1
//
// Deliberately ONE scheduled function rather than a Brevo call wired into
// every save path. Two of those paths run in the browser, and an API key must
// never go there. It also means there is nothing to backfill separately:
// Brevo's import is an upsert, so the first run pushes everyone who already
// exists and each run after that quietly picks up whoever is new. No state to
// keep, and no way to double-add someone.
//
// Contacts are sent with a RECORD_DATE attribute holding the date of the
// record they came from — the order date, the enquiry date, the date the
// booking was made — not the date this function happened to run. That way the
// backfill produces a real history you can segment on rather than everybody
// appearing to have arrived on the same afternoon.
//
// Required env vars: BREVO_API_KEY · SUPABASE_SERVICE_KEY

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const BREVO_KEY    = process.env.BREVO_API_KEY;
const BREVO_API    = "https://api.brevo.com/v3";

// The date each contact came in on. Created automatically on first run.
const DATE_ATTR = "RECORD_DATE";

const LISTS = {
  boxOffice: 8,
  weddings:  7,
  enquiries: 6,
  cottages:  3
};

// ── Supabase helpers (service key, no header spread) ─────────────────────────
async function sbRest(path) {
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": "Bearer " + SERVICE_KEY
    }
  });
  var text = await res.text();
  if (!res.ok) throw new Error("supabase " + res.status + ": " + text);
  try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
}

async function sbGet(key) {
  var rows = await sbRest("app_data?key=eq." + key + "&select=value");
  return (rows && rows[0]) ? rows[0].value : null;
}

// ── Small helpers ────────────────────────────────────────────────────────────
function cleanEmail(v) {
  var e = String(v || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : "";
}

// Brevo wants YYYY-MM-DD. Anything unparseable is left off rather than guessed.
function asDate(v) {
  if (!v) return "";
  var d = new Date(String(v).length <= 10 ? String(v) + "T12:00:00Z" : v);
  if (isNaN(d)) return "";
  return d.toISOString().slice(0, 10);
}

// "Sarah & Tom Jones" doesn't split into first and last in any useful way, so
// a single name goes in FIRSTNAME whole rather than being chopped in two.
function nameParts(full) {
  var s = String(full || "").trim();
  if (!s) return { first: "", last: "" };
  if (s.indexOf("&") !== -1 || s.indexOf(" and ") !== -1) return { first: s, last: "" };
  var bits = s.split(/\s+/);
  if (bits.length === 1) return { first: bits[0], last: "" };
  return { first: bits.slice(0, -1).join(" "), last: bits[bits.length - 1] };
}

// One contact per address. Where somebody appears twice — a repeat cottage
// guest, a couple who enquired before booking — the EARLIEST date wins, so the
// attribute reads as "first seen" rather than flapping with each sync.
function collect(rows) {
  var byEmail = {};
  rows.forEach(function(r) {
    var email = cleanEmail(r.email);
    if (!email) return;
    var existing = byEmail[email];
    if (!existing) { byEmail[email] = r; return; }
    if (r.date && (!existing.date || r.date < existing.date)) existing.date = r.date;
    if (!existing.first && r.first) existing.first = r.first;
    if (!existing.last && r.last) existing.last = r.last;
  });
  return Object.keys(byEmail).map(function(k) {
    var r = byEmail[k];
    // Flat attributes alongside the address — this is the shape the import
    // endpoint takes, which differs from the single-contact endpoint.
    var out = { email: k };
    if (r.first) out.FIRSTNAME = r.first;
    if (r.last)  out.LASTNAME  = r.last;
    if (r.date)  out[DATE_ATTR] = r.date;
    return out;
  });
}

// ── Brevo ────────────────────────────────────────────────────────────────────
async function brevo(path, opts) {
  var o = opts || {};
  var res = await fetch(BREVO_API + path, {
    method: o.method || "GET",
    headers: {
      "api-key": BREVO_KEY,
      "content-type": "application/json",
      "accept": "application/json"
    },
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  var text = await res.text();
  var json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* Brevo returns 204 with no body */ }
  return { ok: res.ok, status: res.status, body: json, text: text };
}

// The date attribute has to exist before a contact can carry it. Creating it is
// idempotent in practice: a second attempt just reports it already exists.
async function ensureDateAttribute() {
  var r = await brevo("/contacts/attributes/normal/" + DATE_ATTR, {
    method: "POST",
    body: { type: "date" }
  });
  if (r.ok) return "created";
  if (r.status === 400) return "already there";
  console.error("Could not create " + DATE_ATTR + ":", r.status, r.text);
  return "failed";
}

// One call per list however many contacts it holds. Brevo processes the import
// in the background, which is what keeps this inside a function timeout even
// with several thousand cottage guests.
async function importInto(listId, contacts, label) {
  if (!contacts.length) return { list: label, sent: 0, note: "nothing to send" };
  var r = await brevo("/contacts/import", {
    method: "POST",
    body: {
      listIds: [listId],
      updateExistingContacts: true,
      emptyContactsAttributes: false,
      jsonBody: contacts
    }
  });
  if (!r.ok) {
    console.error("Brevo import failed for " + label + " (list " + listId + "):", r.status, r.text);
    return { list: label, sent: 0, error: r.status + " " + r.text };
  }
  return { list: label, sent: contacts.length, processId: r.body && r.body.processId };
}

// ── Handler ──────────────────────────────────────────────────────────────────
exports.handler = async function() {
  if (!BREVO_KEY || !SERVICE_KEY) {
    var missing = [];
    if (!BREVO_KEY) missing.push("BREVO_API_KEY");
    if (!SERVICE_KEY) missing.push("SUPABASE_SERVICE_KEY");
    console.error("brevo-sync NOT CONFIGURED — missing: " + missing.join(", "));
    return { statusCode: 500, body: JSON.stringify({ error: "missing env vars: " + missing.join(", ") }) };
  }

  try {
    var attr = await ensureDateAttribute();

    // ── 1. Ticket buyers ────────────────────────────────────────────────────
    // Only people who actually bought: an abandoned checkout is not a customer.
    var orders = await sbRest("box_orders?status=in.(paid,deposit_paid)&select=email,first_name,last_name,created_at");
    var boxOffice = collect((orders || []).map(function(o) {
      return { email: o.email, first: o.first_name, last: o.last_name, date: asDate(o.created_at) };
    }));

    // ── 2. Weddings actually booked ─────────────────────────────────────────
    // Not enquiries, not pencilled holds, not cancellations. Both partners'
    // addresses go on, because the list is the couple rather than one of them.
    var bookings = (await sbGet("hawthbush_bookings_v6")) || [];
    var weddingRows = [];
    bookings.forEach(function(b) {
      if (!b) return;
      var st = String(b.status || "").toLowerCase();
      if (st !== "confirmed" && st !== "booked") return;
      var n = nameParts(b.couple);
      [b.email, b.email2, b.email3].forEach(function(addr) {
        if (cleanEmail(addr)) {
          weddingRows.push({ email: addr, first: n.first, last: n.last, date: asDate(b.createdAt || b.date) });
        }
      });
    });
    var weddings = collect(weddingRows);

    // ── 3. Event enquiries ──────────────────────────────────────────────────
    // Enquiries carry no date field, but their id is minted as `enq_<epoch>`,
    // so the moment they were created is recoverable from it.
    var enquiries = (await sbGet("hbf_enquiries_v1")) || [];
    var enquiryRows = (enquiries || []).map(function(e) {
      if (!e) return null;
      var stamp = "";
      var m = String(e.id || "").match(/^enq_(\d{10,})$/);
      if (m) stamp = asDate(new Date(Number(m[1])).toISOString());
      var n = nameParts(e.name);
      return { email: e.email, first: n.first, last: n.last, date: stamp || asDate(e.firstViewing) };
    }).filter(Boolean);
    var enquiryContacts = collect(enquiryRows);

    // ── 4. Cottage guests ───────────────────────────────────────────────────
    // Blocked-out periods aren't guests, and a cancelled booking isn't either.
    var accom = (await sbGet("hbf_accom_v1")) || [];
    var cottageRows = (accom || []).filter(function(b) {
      if (!b) return false;
      if (String(b.status || "").toLowerCase() === "cancelled") return false;
      if (String(b.bookingType || "").toLowerCase() === "blocked") return false;
      return true;
    }).map(function(b) {
      var n = nameParts(b.guestName);
      return { email: b.email, first: n.first, last: n.last, date: asDate(b.createdAt) };
    });
    var cottages = collect(cottageRows);

    // ── Push ────────────────────────────────────────────────────────────────
    var results = [];
    results.push(await importInto(LISTS.boxOffice, boxOffice,       "Box Office"));
    results.push(await importInto(LISTS.weddings,  weddings,        "Wedding Couples"));
    results.push(await importInto(LISTS.enquiries, enquiryContacts, "Event Enquiries"));
    results.push(await importInto(LISTS.cottages,  cottages,        "Cottage Guests"));

    console.log("[brevo-sync] " + DATE_ATTR + ": " + attr + " · " + JSON.stringify(results));
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, dateAttribute: attr, results: results })
    };

  } catch (err) {
    console.error("brevo-sync error:", err && err.message ? err.message : err);
    return { statusCode: 500, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
