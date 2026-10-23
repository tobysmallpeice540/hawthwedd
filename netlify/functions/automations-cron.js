// netlify/functions/automations-cron.js
// The daily trigger for automations.js (the schedule is in netlify.toml).
//
// A shim for the same reason as brevo-sync-cron.js: Netlify answers 403 to any
// HTTP request aimed at a function that carries a `schedule`, so the work
// lives in a plain HTTP function — which the Settings preview can also call —
// and only the timer lives here. Every rule is off until switched on in
// Settings, so this does nothing at all until then.
//
// Required env vars: HBF_ADMIN_TOKEN

const ADMIN_TOKEN = process.env.HBF_ADMIN_TOKEN;
const SITE_ORIGIN = "https://hawthbushfarm.netlify.app";

exports.handler = async function() {
  try {
    var res = await fetch(SITE_ORIGIN + "/.netlify/functions/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN || "" },
      body: "{}"
    });
    var text = await res.text();
    console.log("[automations-cron] " + res.status + " " + text.slice(0, 1000));
    return { statusCode: res.ok ? 200 : 500, body: text };
  } catch (err) {
    console.error("automations-cron error:", err && err.message ? err.message : err);
    return { statusCode: 500, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
