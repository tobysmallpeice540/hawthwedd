// netlify/functions/handle-viewing.js
const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJrcWJ5aXNmbXZ3dWxzeXh6d2p6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NTI0MzgsImV4cCI6MjA5NjUyODQzOH0._CsyhvFrtHFC0KrfiLzbrLUaKcvxtbWlHydaH20tvfo";
const RESEND_KEY   = process.env.RESEND_API_KEY;
const STORAGE_KEY  = "hbf_viewing_requests_v1";
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

  const { id, action } = body;
  if (!id || !action) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Missing id or action" }) };

  const requests = await sbGet(STORAGE_KEY) || [];
  const req = requests.find(r => r.id === id);
  if (!req) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: "Request not found" }) };

  const updated = requests.map(r => r.id === id ? { ...r, status: action === "confirm" ? "confirmed" : "declined" } : r);
  await sbSet(STORAGE_KEY, updated);

  const dateObj = new Date(req.date + "T00:00:00");
  const niceDate = dateObj.toLocaleDateString("en-GB", { weekday:"long", day:"numeric", month:"long", year:"numeric" });

  if (RESEND_KEY) {
    if (action === "confirm") {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: req.email,
          subject: `Your Viewing at Hawthbush Farm - ${niceDate} at ${req.time}`,
          html: `
            <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#333">
              <h2 style="color:#1e3a2f">Viewing Confirmed</h2>
              <p>Dear ${req.name},</p>
              <p>We're delighted to confirm your viewing at <strong>Hawthbush Farm</strong>.</p>
              <div style="background:#f0f7f3;border-left:4px solid #1e3a2f;padding:16px 20px;margin:20px 0;border-radius:0 8px 8px 0">
                <p style="margin:0;font-size:18px;font-weight:600;color:#1e3a2f">${niceDate}</p>
                <p style="margin:4px 0 0;font-size:16px;color:#2d5441">${req.time}</p>
              </div>
              <p>We look forward to welcoming you. Please reply to this email if you have any questions.</p>
              <p>Warm regards,<br><strong>The Hawthbush Farm Team</strong><br>
              <a href="mailto:hello@hawthbushfarm.co.uk">hello@hawthbushfarm.co.uk</a></p>
            </div>
          `,
        }),
      });
    } else {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: req.email,
          subject: `Your Viewing Request - Hawthbush Farm`,
          html: `
            <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#333">
              <p>Dear ${req.name},</p>
              <p>Thank you for your interest in Hawthbush Farm.</p>
              <p>Unfortunately we're unable to accommodate a viewing on <strong>${niceDate} at ${req.time}</strong>.</p>
              <p>We'd love to find an alternative — please get in touch at
              <a href="mailto:hello@hawthbushfarm.co.uk">hello@hawthbushfarm.co.uk</a>.</p>
              <p>Warm regards,<br><strong>The Hawthbush Farm Team</strong></p>
            </div>
          `,
        }),
      });
    }
  }

  return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
};
