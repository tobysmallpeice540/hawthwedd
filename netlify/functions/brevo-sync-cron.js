// netlify/functions/brevo-sync-cron.js
// The nightly trigger for brevo-sync.
//
// It exists only because Netlify returns 403 to any HTTP request aimed at a
// function that carries a `schedule` — so a scheduled function can never be
// run on demand or tested. Keeping the work in a plain HTTP function and the
// timer in this shim means the same code path runs whether it was fired by the
// clock or by the Sync now button in the app, which is the whole point.
//
// Required env vars: HBF_ADMIN_TOKEN

const ADMIN_TOKEN = process.env.HBF_ADMIN_TOKEN;
const SITE_ORIGIN = "https://hawthbushfarm.netlify.app";

exports.handler = async function() {
  try {
    var res = await fetch(SITE_ORIGIN + "/.netlify/functions/brevo-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN || "" }
    });
    var text = await res.text();
    console.log("[brevo-sync-cron] " + res.status + " " + text);
    return { statusCode: res.ok ? 200 : 500, body: text };
  } catch (err) {
    console.error("brevo-sync-cron error:", err && err.message ? err.message : err);
    return { statusCode: 500, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
