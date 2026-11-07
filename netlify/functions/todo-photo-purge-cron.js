// netlify/functions/todo-photo-purge-cron.js
// The nightly timer for todo-photo-purge.js, which takes away the photos of
// to-dos finished more than a month ago (schedule in netlify.toml).
//
// A shim, like checklists-cron.js: Netlify answers 403 to any HTTP request
// aimed at a function that carries a `schedule`, so the work lives in a plain
// HTTP function.
//
// Required env vars: HBF_ADMIN_TOKEN

const ADMIN_TOKEN = process.env.HBF_ADMIN_TOKEN;
const SITE_ORIGIN = "https://hawthbushfarm.netlify.app";

exports.handler = async function() {
  try {
    var res = await fetch(SITE_ORIGIN + "/.netlify/functions/todo-photo-purge", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN || "" },
      body: "{}"
    });
    var text = await res.text();
    console.log("[todo-photo-purge-cron] " + res.status + " " + text.slice(0, 1000));
    return { statusCode: res.ok ? 200 : 500, body: text };
  } catch (err) {
    console.error("todo-photo-purge-cron error:", err && err.message ? err.message : err);
    return { statusCode: 500, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
