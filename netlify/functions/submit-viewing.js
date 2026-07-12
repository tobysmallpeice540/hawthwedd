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

const sbGet = async (key) => {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/app_data?key=eq.${key}&select=value`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  return rows?.[0]?.value ?? null;
};

const sbSet = async (key, value) => {
  await fetch(`${SUPABASE_URL}/rest/v1/app_data`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key, value }),
  });
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Method not allowed" }) };

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { name, email, phone, guests, preferredDate, notes, date, time } = body;
  if (!name || !email || !date || !time) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Missing required fields" }) };
  }

  // Save to Supabase
  const existing = await sbGet(STORAGE_KEY) || [];
  const request = {
    id: `vr_${Date.now()}`,
    name, email, phone: phone||"", guests: guests||"", preferredDate: preferredDate||"",
    notes: notes||"", date, time,
    status: "pending",
    submittedAt: new Date().toISOString(),
  };
  await sbSet(STORAGE_KEY, [...existing, request]);

  // Email notification to farm
  if (RESEND_KEY) {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: NOTIFY_EMAIL,
        subject: `New Viewing Request - ${name} - ${date} at ${time}`,
        html: `
          <h2>New Viewing Request</h2>
          <table style="border-collapse:collapse;font-family:sans-serif;font-size:15px">
            <tr><td style="padding:6px 16px 6px 0;color:#666;font-weight:600">Name</td><td>${name}</td></tr>
            <tr><td style="padding:6px 16px 6px 0;color:#666;font-weight:600">Email</td><td>${email}</td></tr>
            <tr><td style="padding:6px 16px 6px 0;color:#666;font-weight:600">Phone</td><td>${phone||"not provided"}</td></tr>
            <tr><td style="padding:6px 16px 6px 0;color:#666;font-weight:600">Date</td><td>${date}</td></tr>
            <tr><td style="padding:6px 16px 6px 0;color:#666;font-weight:600">Time</td><td>${time}</td></tr>
            <tr><td style="padding:6px 16px 6px 0;color:#666;font-weight:600">Guests</td><td>${guests||"not provided"}</td></tr>
            <tr><td style="padding:6px 16px 6px 0;color:#666;font-weight:600">Year in Mind</td><td>${preferredDate||"not provided"}</td></tr>
            <tr><td style="padding:6px 16px 6px 0;color:#666;font-weight:600">Notes</td><td>${notes||"none"}</td></tr>
          </table>
          <p style="margin-top:20px">
            <a href="https://cool-sorbet-b1d599.netlify.app" style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">Open App to Confirm</a>
          </p>
        `,
      }),
    });
  }

  return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, id: request.id }) };
};
