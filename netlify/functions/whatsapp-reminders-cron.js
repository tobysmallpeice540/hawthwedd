// netlify/functions/whatsapp-reminders-cron.js
// The 15-minute trigger for whatsapp-reminders (schedule in netlify.toml).
// A shim for the same reason as brevo-sync-cron: Netlify answers 403 to any
// HTTP request aimed at a scheduled function, so the work lives in a plain
// function the Settings "Check now" button can reach too.
//
// Required env vars: HBF_ADMIN_TOKEN

const ADMIN_TOKEN = process.env.HBF_ADMIN_TOKEN;
const SITE_ORIGIN = "https://hawthbushfarm.netlify.app";

exports.handler = async function () {
  try {
    const res = await fetch(SITE_ORIGIN + "/.netlify/functions/whatsapp-reminders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN || "" }
    });
    const text = await res.text();
    console.log("[whatsapp-reminders-cron] " + res.status + " " + text.slice(0, 500));
    return { statusCode: res.ok ? 200 : 500, body: text };
  } catch (err) {
    console.error("whatsapp-reminders-cron error:", err && err.message ? err.message : err);
    return { statusCode: 500, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
