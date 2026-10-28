// netlify/functions/email-archive-cron.js
// The half-hourly trigger for email-archive (the schedule is in netlify.toml).
//
// A shim for the same reason as brevo-sync-cron.js: Netlify answers 403 to any
// HTTP request aimed at a function that carries a `schedule`, so the work
// lives in a plain HTTP function — which Settings' "Read now" also calls — and
// only the timer lives here. Until the farm Gmail is connected (Lettings →
// Settings → Airbnb Sync) the worker copies in the app's own emails and
// does nothing else.
//
// Required env vars: HBF_ADMIN_TOKEN

const ADMIN_TOKEN = process.env.HBF_ADMIN_TOKEN;
const SITE_ORIGIN = "https://hawthbushfarm.netlify.app";

exports.handler = async function() {
  try {
    var res = await fetch(SITE_ORIGIN + "/.netlify/functions/email-archive", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN || "" },
      body: JSON.stringify({ action: "sync" })
    });
    var text = await res.text();
    console.log("[email-archive-cron] " + res.status + " " + text.slice(0, 1000));
    return { statusCode: res.ok ? 200 : 500, body: text };
  } catch (err) {
    console.error("email-archive-cron error:", err && err.message ? err.message : err);
    return { statusCode: 500, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
