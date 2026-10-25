// netlify/functions/portal-nudges-cron.js
// The Monday trigger for portal-nudges.js (the schedule is in netlify.toml).
//
// A shim for the same reason as automations-cron.js: Netlify answers 403 to any
// HTTP request aimed at a function that carries a `schedule`, so the work lives
// in a plain HTTP function — which the Settings preview also calls — and only
// the timer lives here. The reminder is off until switched on in Settings, so
// this does nothing until then.
//
// Required env vars: HBF_ADMIN_TOKEN

const ADMIN_TOKEN = process.env.HBF_ADMIN_TOKEN;
const SITE_ORIGIN = "https://hawthbushfarm.netlify.app";

exports.handler = async function () {
  try {
    var res = await fetch(SITE_ORIGIN + "/.netlify/functions/portal-nudges", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN || "" },
      body: "{}"
    });
    var text = await res.text();
    console.log("[portal-nudges-cron] " + res.status + " " + text.slice(0, 1000));
    return { statusCode: res.ok ? 200 : 500, body: text };
  } catch (err) {
    console.error("portal-nudges-cron error:", err && err.message ? err.message : err);
    return { statusCode: 500, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
