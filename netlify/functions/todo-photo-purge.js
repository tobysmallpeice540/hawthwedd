// netlify/functions/todo-photo-purge.js
//
// A to-do's photos go a month after it is done (Toby, 7 Nov 2026). The to-do
// itself is kept for good; only its pictures are let go.
//
//   POST, x-admin-token: HBF_ADMIN_TOKEN    the nightly shim (todo-photo-purge-cron.js)
//
// One run, in batches, until the list is empty or time is nearly up:
//   1. todo_worker_old_photos(before): to-dos finished more than PURGE_DAYS ago
//      that still have photos;
//   2. delete those files (Storage API, service key) — `todos/…` paths from
//      build 06c live in booking-files, everything else in todo-photos;
//   3. todo_worker_photos_cleared(ids, before) — only for a batch whose
//      deletes all succeeded, and only to-dos still finished before then.
// Deleting first means a run cut short, or a failed delete, is simply done
// again next night (a file already gone is not an error).
//
// Required env vars: SUPABASE_SERVICE_KEY, HBF_ADMIN_TOKEN

"use strict";

const crypto = require("crypto");

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const PURGE_DAYS = 30;
const BATCH = 50;                 // to-dos per round
const STOP_AFTER_MS = 7500;       // Netlify's limit is 10s

function json(statusCode, body) {
  return { statusCode: statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
function serviceHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return { "apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json" };
}
function tokenMatches(given, expected) {
  if (!expected || typeof given !== "string" || !given) return false;
  const a = Buffer.from(given, "utf8"), b = Buffer.from(String(expected), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
async function rpc(fn, args) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + fn, { method: "POST", headers: serviceHeaders(), body: JSON.stringify(args || {}) });
  const text = await res.text();
  if (!res.ok) throw new Error(fn + " " + res.status + " " + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}

// Which bucket a stored path is in, and the object's name inside it.
function bucketOf(path) {
  return /^todos\//.test(path) ? "booking-files" : "todo-photos";
}
// Only paths shaped like ours are ever deleted: "<to-do id>/<file>" or
// "todos/<to-do id>/<file>", for that to-do.
function safePath(path, id) {
  return typeof path === "string" && path.indexOf("..") === -1 &&
    (path.indexOf(id + "/") === 0 || path.indexOf("todos/" + id + "/") === 0) && /^[A-Za-z0-9._\/-]+$/.test(path);
}

async function removeFiles(bucket, names) {
  if (!names.length) return true;
  const res = await fetch(SUPABASE_URL + "/storage/v1/object/" + bucket, {
    method: "DELETE", headers: serviceHeaders(), body: JSON.stringify({ prefixes: names })
  });
  if (!res.ok) { console.error("[todo-photo-purge] delete " + bucket + " " + res.status + " " + (await res.text()).slice(0, 200)); return false; }
  return true;
}

async function runOnce(now) {
  const t0 = Date.now();
  const before = new Date(now.getTime() - PURGE_DAYS * 86400000).toISOString();
  const out = { before: before, todos: 0, files: 0, failed: 0, skipped: 0, stoppedEarly: false };
  const failedIds = {};
  for (;;) {
    if (Date.now() - t0 > STOP_AFTER_MS) { out.stoppedEarly = true; break; }
    const list = (await rpc("todo_worker_old_photos", { p_before: before, p_limit: BATCH + Object.keys(failedIds).length })) || [];
    const batch = list.filter(function(x) { return !failedIds[x.id]; }).slice(0, BATCH);
    if (!batch.length) break;
    const byBucket = { "todo-photos": [], "booking-files": [] };
    const clear = [];
    batch.forEach(function(x) {
      const paths = Array.isArray(x.paths) ? x.paths : [];
      const ok = paths.every(function(p) { return safePath(p, x.id); });
      if (!ok) { out.skipped++; failedIds[x.id] = true; console.error("[todo-photo-purge] odd path on " + x.id + ", left alone"); return; }
      paths.forEach(function(p) { byBucket[bucketOf(p)].push(p); });
      clear.push(x);
    });
    const okPhotos = await removeFiles("todo-photos", byBucket["todo-photos"]);
    const okFiles = await removeFiles("booking-files", byBucket["booking-files"]);
    // A to-do is cleared only if every bucket holding its photos said yes.
    const ids = clear.filter(function(x) {
      return (x.paths || []).every(function(p) { return bucketOf(p) === "todo-photos" ? okPhotos : okFiles; });
    }).map(function(x) { return x.id; });
    clear.forEach(function(x) { if (ids.indexOf(x.id) === -1) { failedIds[x.id] = true; out.failed++; } });
    if (ids.length) {
      const n = await rpc("todo_worker_photos_cleared", { p_ids: ids, p_before: before });
      out.todos += Number(n) || 0;
      clear.forEach(function(x) { if (ids.indexOf(x.id) !== -1) out.files += (x.paths || []).length; });
    }
    if (!ids.length) break;     // nothing could be done this round: try again tomorrow
  }
  return out;
}

exports.handler = async function(event) {
  if (event && event.httpMethod && event.httpMethod !== "POST") return json(405, { error: "POST only" });
  const headers = (event && event.headers) || {};
  if (!tokenMatches(headers["x-admin-token"] || "", process.env.HBF_ADMIN_TOKEN)) return json(403, { error: "Not allowed." });
  if (!process.env.SUPABASE_SERVICE_KEY) return json(500, { error: "SUPABASE_SERVICE_KEY is not set" });
  try {
    const result = await runOnce(new Date());
    console.log("[todo-photo-purge] " + JSON.stringify(result));
    return json(200, result);
  } catch (e) {
    console.error("[todo-photo-purge] " + (e && e.message));
    return json(500, { error: String((e && e.message) || e) });
  }
};

exports._test = { runOnce, safePath, bucketOf, PURGE_DAYS };
