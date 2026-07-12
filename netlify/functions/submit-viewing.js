// netlify/functions/submit-viewing.js
const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJrcWJ5aXNmbXZ3dWxzeXh6d2p6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NTI0MzgsImV4cCI6MjA5NjUyODQzOH0._CsyhvFrtHFC0KrfiLzbrLUaKcvxtbWlHydaH20tvfo";
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

const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Method not allowed" }) };

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { name, email, phone, guests, preferredDate, notes, date, time } = body;
  if (!name || !email || !date || !time) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Missing required fields" }) };
  }

  const request = {
    id: `vr_${Date.now()}`,
    name, email,
    phone: phone || "",
    guests: guests || "",
    preferredDate: preferredDate || "",
    notes: notes || "",
    date, time,
    status: "pending",
    submittedAt: new Date().toISOString(),
  };

  // Read existing requests
  let existing = [];
  try {
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/app_data?key=eq.${STORAGE_KEY}&select=value`,
      { headers }
    );
    const rows = await getRes.json();
    if (Array.isArray(rows) && rows.length > 0 && Array.isArray(rows[0].value)) {
      existing = rows[0].value;
    }
  } catch(e) { console.log("sbGet error:", e.message); }

  // Write updated list
  try {
    const newList = [...existing, request];
    const setRes = await fetch(`${SUPABASE_URL}/rest/v1/app_data`, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key: STORAGE_KEY, value: newList }),
    });
    const setBody = await setRes.text();
    console.log("sbSet status:", setRes.status, "body:", setBody);
  } catch(e) { console.log("sbSet error:", e.message); }

  // Send notification email
  if (RESEND_KEY) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: NOTIFY_EMAIL,
          subject: `New Viewing Request - ${name} - ${date} at ${time}`,
          html: `<h2>New Viewing Request</h2>
            <p><b>Name:</b> ${name}</p>
            <p><b>Email:</b> ${email}</p>
            <p><b>Phone:</b> ${phone || "not provided"}</p>
            <p><b>Date:</b> ${date} at ${time}</p>
            <p><b>Guests:</b> ${guests || "not provided"}</p>
            <p><b>Year in mind:</b> ${preferredDate || "not provided"}</p>
            <p><b>Notes:</b> ${notes || "none"}</p>
            <p><a href="https://cool-sorbet-b1d599.netlify.app" style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;margin-top:10px">Open App to Confirm</a></p>`,
        }),
      });
    } catch(e) { console.log("Email error:", e.message); }
  }

  return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, id: request.id }) };
};
