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

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

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

  // Read existing
  let existing = [];
  const getRes = await fetch(
    `${SUPABASE_URL}/rest/v1/app_data?key=eq.${STORAGE_KEY}&select=value`,
    { headers: sbHeaders }
  );
  if (getRes.ok) {
    const rows = await getRes.json();
    if (Array.isArray(rows) && rows[0] && Array.isArray(rows[0].value)) {
      existing = rows[0].value;
    }
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
        from: FROM_EMAIL,
        to: NOTIFY_EMAIL,
        subject: `New Viewing Request - ${name} - ${date} at ${time}`,
        html: `<h2>New Viewing Request</h2>
          <p><b>Name:</b> ${name}</p><p><b>Email:</b> ${email}</p>
          <p><b>Event type:</b> ${eventType||"not provided"}</p>
          <p><b>Phone:</b> ${phone||"not provided"}</p>
          <p><b>Date:</b> ${date} at ${time}</p>
          <p><b>Guests:</b> ${guests||"not provided"}</p>
          <p><b>Year in mind:</b> ${preferredDate||"not provided"}</p>
          <p><b>Notes:</b> ${notes||"none"}</p>
          <p><a href="${process.env.URL || "https://hawthbushfarm.netlify.app"}"
            style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;margin-top:10px">
            Open App to Confirm</a></p>`,
      }),
    }).catch(e => console.error("Email failed:", e.message));
  }

  return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, id: request.id }) };
};
