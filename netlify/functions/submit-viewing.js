// netlify/functions/submit-viewing.js
const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
// The service key, not the anon key. Server-side code has no business
// holding the same credential the public pages carry — and once app_data
// has row level security this is what keeps the scheduled jobs working.
// No fallback to the anon key on purpose: a missing variable should fail
// loudly rather than quietly reopen what this change closes.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const STORAGE_KEY  = "hbf_viewing_requests_v1";
const NOTIFY_EMAIL = "hello@hawthbushfarm.co.uk";
const FROM_EMAIL   = "hello@hawthbushfarm.co.uk";
// What the recipient sees in their inbox. Without a display name, mail clients
// fall back to the local part of the address — so everything arrived from
// "hello", which tells nobody anything. FROM_EMAIL itself stays a bare address
// because the footer uses it for a mailto: link.
const FROM_HEADER  = "Hawthbush Farm <" + FROM_EMAIL + ">";

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

// Everything a visitor typed is escaped before it goes into the office email.
function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Method not allowed" }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { name, email, phone, guests, preferredDate, notes, date, time, eventType } = body;
  if (!name || !email || !date || !time) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Missing required fields" }) };
  }

  const sbHeaders = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
  };

  // Read existing. A refused read is NOT an empty list: treating it as one
  // wrote back a list holding only this request, erasing every other. So a
  // failed read refuses to save, and the visitor is asked to try again.
  let existing = [];
  let getRes;
  try {
    getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/app_data?key=eq.${STORAGE_KEY}&select=value`,
      { headers: sbHeaders }
    );
  } catch (e) { getRes = null; }
  if (!getRes || !getRes.ok) {
    console.error("submit-viewing: read failed —", getRes ? getRes.status : "network");
    return { statusCode: 503, headers: cors, body: JSON.stringify({ error: "We couldn't save your request just now. Please try again in a minute." }) };
  }
  const rows = await getRes.json().catch(() => null);
  if (!Array.isArray(rows)) {
    return { statusCode: 503, headers: cors, body: JSON.stringify({ error: "We couldn't save your request just now. Please try again in a minute." }) };
  }
  if (rows[0] && Array.isArray(rows[0].value)) existing = rows[0].value;
  else if (rows[0] && rows[0].value != null) {
    // A row that holds something other than a list is not ours to replace.
    console.error("submit-viewing: stored value is not a list — refusing to overwrite it");
    return { statusCode: 503, headers: cors, body: JSON.stringify({ error: "We couldn't save your request just now. Please try again in a minute." }) };
  }

  // Build request
  const request = {
    id: `vr_${Date.now()}`,
    name, email,
    eventType: eventType || "",
    phone: phone || "",
    guests: guests || "",
    preferredDate: preferredDate || "",
    notes: notes || "",
    date, time,
    status: "pending",
    submittedAt: new Date().toISOString(),
  };

  // Write to Supabase
  const setRes = await fetch(`${SUPABASE_URL}/rest/v1/app_data`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key: STORAGE_KEY, value: [...existing, request] }),
  });

  if (!setRes.ok) {
    const errText = await setRes.text();
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Save failed: " + errText }) };
  }

  // Send notification email
  if (RESEND_KEY) {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM_HEADER,
        to: NOTIFY_EMAIL,
        subject: `New Viewing Request - ${String(name).replace(/[\r\n]+/g, " ").slice(0, 120)} - ${date} at ${time}`,
        html: `<h2>New Viewing Request</h2>
          <p><b>Name:</b> ${esc(name)}</p><p><b>Email:</b> ${esc(email)}</p>
          <p><b>Event type:</b> ${esc(eventType||"not provided")}</p>
          <p><b>Phone:</b> ${esc(phone||"not provided")}</p>
          <p><b>Date:</b> ${esc(date)} at ${esc(time)}</p>
          <p><b>Guests:</b> ${esc(guests||"not provided")}</p>
          <p><b>Year in mind:</b> ${esc(preferredDate||"not provided")}</p>
          <p><b>Notes:</b> ${esc(notes||"none").replace(/\n/g, "<br>")}</p>
          <p><a href="${process.env.URL || "https://hawthbushfarm.netlify.app"}"
            style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;margin-top:10px">
            Open App to Confirm</a></p>`,
      }),
    }).catch(e => console.error("Email failed:", e.message));
  }

  // The internal request id is not returned: the public page does not use it,
  // and it is the handle the office uses to confirm or decline.
  return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
};
