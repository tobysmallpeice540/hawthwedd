// netlify/functions/handle-viewing.js
const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJrcWJ5aXNmbXZ3dWxzeXh6d2p6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NTI0MzgsImV4cCI6MjA5NjUyODQzOH0._CsyhvFrtHFC0KrfiLzbrLUaKcvxtbWlHydaH20tvfo";
const RESEND_KEY  = process.env.RESEND_API_KEY;
const STORAGE_KEY = "hbf_viewing_requests_v1";
const EMAIL_LOG_KEY = "hbf_email_log_v1";
const FROM_EMAIL  = "hello@hawthbushfarm.co.uk";

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

async function sbGet(key) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data?key=eq." + key + "&select=value", {
    headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY }
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return (Array.isArray(rows) && rows[0]) ? rows[0].value : null;
}

async function sbSet(key, value) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data", {
    method: "POST",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key: key, value: value }),
  });
  if (!res.ok) throw new Error("sbSet failed: " + await res.text());
}

// Record a sent email so it shows up in the Home dashboard's "Recent Automated Emails" panel
async function logEmail(entry) {
  try {
    var log = (await sbGet(EMAIL_LOG_KEY)) || [];
    var rec = Object.assign({ id: "el" + Date.now() + "-" + Math.random().toString(36).slice(2, 6), sentAt: new Date().toISOString() }, entry);
    log.push(rec);
    await sbSet(EMAIL_LOG_KEY, log.slice(-500));
  } catch (e) {
    console.error("logEmail failed:", e.message);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Method not allowed" }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { id, action } = body;
  if (!id || !action) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Missing id or action" }) };

  // Read existing requests
  const getRes = await fetch(
    `${SUPABASE_URL}/rest/v1/app_data?key=eq.${STORAGE_KEY}&select=value`,
    {
      method: "GET",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
      }
    }
  );
  const rows = await getRes.json();
  const requests = (Array.isArray(rows) && rows[0] && Array.isArray(rows[0].value)) ? rows[0].value : [];

  const req = requests.find(function(r) { return r.id === id; });
  if (!req) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: "Request not found" }) };

  // Update status
  const newStatus = action === "confirm" ? "confirmed" : "declined";
  const updated = requests.map(function(r) {
    return r.id === id ? Object.assign({}, r, { status: newStatus }) : r;
  });

  const setRes = await fetch(`${SUPABASE_URL}/rest/v1/app_data`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key: STORAGE_KEY, value: updated }),
  });

  if (!setRes.ok) {
    const errText = await setRes.text();
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Save failed: " + errText }) };
  }

  // Format date
  const dateObj = new Date(req.date + "T00:00:00");
  const niceDate = dateObj.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  // Send email
  if (RESEND_KEY) {
    const emailBody = action === "confirm"
      ? "<div style='font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#333'>" +
        "<h2 style='color:#1e3a2f'>Viewing Confirmed</h2>" +
        "<p>Dear " + req.name + ",</p>" +
        "<p>We're delighted to confirm your viewing at <strong>Hawthbush Farm</strong>.</p>" +
        "<div style='background:#f0f7f3;border-left:4px solid #1e3a2f;padding:16px 20px;margin:20px 0;border-radius:0 8px 8px 0'>" +
        "<p style='margin:0;font-size:18px;font-weight:600;color:#1e3a2f'>" + niceDate + "</p>" +
        "<p style='margin:4px 0 0;font-size:16px;color:#2d5441'>" + req.time + "</p></div>" +
        "<p>We look forward to welcoming you. Please reply if you have any questions.</p>" +
        "<p>Warm regards,<br><strong>The Hawthbush Farm Team</strong><br>" +
        "<a href='mailto:" + FROM_EMAIL + "'>" + FROM_EMAIL + "</a></p></div>"
      : "<div style='font-family:Georgia,serif;max-width:600px;margin:0 auto;color:#333'>" +
        "<p>Dear " + req.name + ",</p>" +
        "<p>Thank you for your interest in Hawthbush Farm.</p>" +
        "<p>Unfortunately we're unable to accommodate a viewing on <strong>" + niceDate + " at " + req.time + "</strong>.</p>" +
        "<p>Please get in touch at <a href='mailto:" + FROM_EMAIL + "'>" + FROM_EMAIL + "</a> to find an alternative.</p>" +
        "<p>Warm regards,<br><strong>The Hawthbush Farm Team</strong></p></div>";

    const subject = action === "confirm"
      ? "Your Viewing at Hawthbush Farm - " + niceDate + " at " + req.time
      : "Your Viewing Request - Hawthbush Farm";

    try {
      const sendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + RESEND_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: req.email,
          subject: subject,
          html: emailBody,
        }),
      });
      if (sendRes.ok) {
        await logEmail({ subject: subject, to: req.email, type: "viewing_" + action, requestId: id });
      } else {
        console.log("Email send failed:", await sendRes.text());
      }
    } catch (e) {
      console.log("Email error:", e.message);
    }
  }

  return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
};
