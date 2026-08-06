// netlify/functions/todoist-feed.js
//
// Fetches a Todoist iCalendar feed and returns the tasks as JSON.
//
// Needed because the browser can't read the feed directly — Todoist doesn't
// send CORS headers, so the request has to be made server-side.
//
// The feed URL is supplied by the app (stored in Settings) rather than being
// configured here, but is checked against an allow-list first: this endpoint is
// public, and a proxy that will fetch any URL on request can be used to reach
// private addresses. Only Todoist hosts are permitted.

const ALLOWED_HOSTS = ["todoist.com", "ics.todoist.com", "www.todoist.com"];
const CACHE_MS = 5 * 60 * 1000;

let cache = {};   // url -> { at, tasks }

function jsonResponse(statusCode, body) {
  return { statusCode: statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function hostAllowed(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return false; }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  return ALLOWED_HOSTS.some(function(a) { return h === a || h.endsWith("." + a); });
}

// iCalendar folds long lines by starting the continuation with a space or tab.
function unfold(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

function unescapeIcs(v) {
  return String(v || "")
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

// DTSTART can be a date (20260805), a UTC timestamp (20260805T090000Z) or a
// local timestamp with a TZID parameter. Only the calendar date is needed here.
function parseIcsDate(value) {
  const v = String(value || "").trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return m[1] + "-" + m[2] + "-" + m[3];
}

function parseIcs(text) {
  const lines = unfold(text).split("\n");
  const tasks = [];
  let cur = null;

  lines.forEach(function(line) {
    const t = line.trim();
    if (t === "BEGIN:VEVENT") { cur = {}; return; }
    if (t === "END:VEVENT") {
      if (cur && cur.summary) {
        tasks.push({
          uid: cur.uid || (cur.summary + "|" + (cur.date || "")),
          summary: cur.summary,
          date: cur.date || null,
          allDay: !!cur.allDay,
          url: cur.url || null,
          description: cur.description || ""
        });
      }
      cur = null;
      return;
    }
    if (!cur) return;

    const idx = t.indexOf(":");
    if (idx < 0) return;
    const rawName = t.slice(0, idx);
    const value = t.slice(idx + 1);
    const name = rawName.split(";")[0].toUpperCase();

    if (name === "SUMMARY") cur.summary = unescapeIcs(value);
    else if (name === "UID") cur.uid = value.trim();
    else if (name === "DESCRIPTION") cur.description = unescapeIcs(value);
    else if (name === "URL") cur.url = value.trim();
    else if (name === "DTSTART") {
      cur.date = parseIcsDate(value);
      cur.allDay = /VALUE=DATE(?!-TIME)/i.test(rawName) || !/T\d{6}/.test(value);
    }
  });

  return tasks;
}

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return jsonResponse(400, { error: "Invalid JSON" }); }

  // Prefer a server-side env var. The feed URL contains an ical_token that
  // grants read access to the whole task list, and anything stored in Supabase
  // is readable with the public anon key that ships in the browser bundle — so
  // TODOIST_ICS_URL in Netlify keeps the token out of the client entirely.
  // The Settings field remains as a fallback for convenience.
  const url = String(process.env.TODOIST_ICS_URL || body.url || "").trim();
  if (!url) return jsonResponse(400, { error: "No feed URL set" });
  if (!hostAllowed(url)) {
    return jsonResponse(400, { error: "That doesn't look like a Todoist feed URL — it must be an https link on todoist.com." });
  }

  const hit = cache[url];
  if (hit && (Date.now() - hit.at) < CACHE_MS && !body.force) {
    return jsonResponse(200, { ok: true, tasks: hit.tasks, cached: true });
  }

  try {
    const res = await fetch(url, { headers: { "Accept": "text/calendar, text/plain" } });
    const text = await res.text();
    if (!res.ok) {
      return jsonResponse(res.status === 404 ? 404 : 502, {
        error: "Todoist returned " + res.status + ". Check the feed URL hasn't been regenerated."
      });
    }
    if (text.indexOf("BEGIN:VCALENDAR") === -1) {
      return jsonResponse(502, { error: "That URL didn't return a calendar feed." });
    }

    const tasks = parseIcs(text).sort(function(a, b) {
      return (a.date || "9999") > (b.date || "9999") ? 1 : -1;
    });
    cache[url] = { at: Date.now(), tasks: tasks };
    return jsonResponse(200, { ok: true, tasks: tasks, count: tasks.length });

  } catch (err) {
    console.error("todoist-feed error:", err);
    return jsonResponse(500, { error: String(err.message || err) });
  }
};
