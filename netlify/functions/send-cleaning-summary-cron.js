// netlify/functions/send-cleaning-summary-cron.js
// The timer for send-cleaning-summary (the schedule is in netlify.toml).
//
// It exists only because Netlify returns 403 to any HTTP request aimed at a
// function that carries a `schedule` — so the app's "Send one now" button
// could never reach a scheduled worker. The work stays in the plain HTTP
// function; this shim calls it with HBF_ADMIN_TOKEN, which is what tells the
// worker to apply its "3am London, chosen weekday, once a day" rules. Same
// pattern as brevo-sync-cron.js and automations-cron.js.
//
// Required env vars: HBF_ADMIN_TOKEN

const ADMIN_TOKEN = process.env.HBF_ADMIN_TOKEN;
const SITE_ORIGIN = "https://hawthbushfarm.netlify.app";

exports.handler = async function() {
  try {
    var res = await fetch(SITE_ORIGIN + "/.netlify/functions/send-cleaning-summary", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN || "" },
      body: "{}"
    });
    var text = await res.text();
    console.log("[send-cleaning-summary-cron] " + res.status + " " + text);
    return { statusCode: res.ok ? 200 : 500, body: text };
  } catch (err) {
    console.error("send-cleaning-summary-cron error:", err && err.message ? err.message : err);
    return { statusCode: 500, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
