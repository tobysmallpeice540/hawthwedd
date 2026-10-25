// netlify/functions/airbnb-mail-cron.js
// The hourly trigger for airbnb-mail (the schedule is in netlify.toml).
//
// A shim for the same reason as brevo-sync-cron.js: Netlify answers 403 to any
// HTTP request aimed at a function that carries a `schedule`, so the work
// lives in a plain HTTP function — which Settings' "Sync now" also calls — and
// only the timer lives here. Until Gmail is connected in Settings → Airbnb
// email, the worker answers "not connected" and does nothing.
//
// Required env vars: HBF_ADMIN_TOKEN

const ADMIN_TOKEN = process.env.HBF_ADMIN_TOKEN;
const SITE_ORIGIN = "https://hawthbushfarm.netlify.app";

exports.handler = async function() {
  try {
    var res = await fetch(SITE_ORIGIN + "/.netlify/functions/airbnb-mail", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN || "" },
      body: JSON.stringify({ action: "sync" })
    });
    var text = await res.text();
    console.log("[airbnb-mail-cron] " + res.status + " " + text.slice(0, 1000));
    return { statusCode: res.ok ? 200 : 500, body: text };
  } catch (err) {
    console.error("airbnb-mail-cron error:", err && err.message ? err.message : err);
    return { statusCode: 500, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
