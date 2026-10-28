// netlify/functions/checklists/checklists.js
//
// Starts the staff checklists that are due (see plan.js for the rules, and
// supabase/2026-10-28t-checklists.sql for the tables).
//
//   POST, x-admin-token: HBF_ADMIN_TOKEN     the 15-minute shim (checklists-cron.js)
//   POST, Authorization: Bearer <admin JWT>  Settings → Checklists → "Check now"
//
// One run: ask the database which templates are switched on and which lists
// are open (chk_worker_state), read only the bookings those templates need,
// work out the plan, and hand it to chk_worker_apply — which fires each anchor
// at most once, and refuses to move or cancel a list anyone has ticked.
// Nothing is emailed.
//
// Required env vars: SUPABASE_SERVICE_KEY, HBF_ADMIN_TOKEN

"use strict";

const crypto = require("crypto");
const { planChecklists } = require("./plan.js");

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";

function json(statusCode, body) {
  return { statusCode: statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
function serviceHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return { "apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json" };
}

// A failed read is null, never an empty list: plan.js cancels nothing on a
// source it is not sure of.
async function appData(key) {
  try {
    const res = await fetch(SUPABASE_URL + "/rest/v1/app_data?key=eq." + encodeURIComponent(key) + "&select=value",
      { headers: serviceHeaders() });
    if (!res.ok) { console.error("[checklists] read " + key + " " + res.status); return null; }
    const rows = await res.json();
    return Array.isArray(rows) && rows[0] ? rows[0].value : undefined;   // undefined: no such key
  } catch (e) { console.error("[checklists] read " + key + " " + e.message); return null; }
}
async function rest(path) {
  try {
    const res = await fetch(SUPABASE_URL + "/rest/v1/" + path, { headers: serviceHeaders() });
    if (!res.ok) { console.error("[checklists] read " + path.split("?")[0] + " " + res.status); return null; }
    const rows = await res.json();
    return Array.isArray(rows) ? rows : null;
  } catch (e) { console.error("[checklists] read " + path.split("?")[0] + " " + e.message); return null; }
}
async function rpc(fn, args) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + fn, {
    method: "POST", headers: serviceHeaders(), body: JSON.stringify(args || {})
  });
  const text = await res.text();
  if (!res.ok) throw new Error(fn + " " + res.status + " " + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}
function asArray(v) { return v === undefined ? [] : (Array.isArray(v) ? v : null); }

async function resolveAdmin(event) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  const h = (event && event.headers) || {};
  const jwt = String(h["authorization"] || h["Authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt || !key) return null;
  try {
    const res = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { "apikey": key, "Authorization": "Bearer " + jwt } });
    if (!res.ok) return null;
    const user = await res.json();
    if (!user || !user.id) return null;
    const pr = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + encodeURIComponent(user.id) + "&select=role,active",
      { headers: { "apikey": key, "Authorization": "Bearer " + key } });
    if (!pr.ok) return null;
    const rows = await pr.json();
    const p = Array.isArray(rows) ? rows[0] : null;
    return p && p.active !== false && p.role === "admin" ? user.id : null;
  } catch (e) { return null; }
}
function tokenMatches(given, expected) {
  if (!expected || typeof given !== "string" || !given) return false;
  const a = Buffer.from(given, "utf8"), b = Buffer.from(String(expected), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// What each trigger needs read.
const NEEDS = {
  checkin: ["accom", "properties"], checkout: ["accom", "properties"],
  event: ["events", "settings", "drinks", "boxEvents"],
  viewing: ["events", "enquiries"], cleaned: ["changeovers"]
};

async function loadData(templates) {
  const need = {};
  templates.forEach(function(t) { (NEEDS[t.trig && t.trig.kind] || []).forEach(function(k) { need[k] = true; }); });
  const since = new Date(Date.now() - 60 * 86400000).toISOString();
  const jobs = {
    accom:       function() { return appData("hbf_accom_v1").then(asArray); },
    properties:  function() { return appData("hbf_properties_v1").then(asArray); },
    events:      function() { return appData("hawthbush_bookings_v6").then(asArray); },
    enquiries:   function() { return appData("hbf_enquiries_v1").then(asArray); },
    changeovers: function() { return appData("hbf_changeovers_v1").then(asArray); },
    settings:    function() { return appData("hbf_checklist_settings_v1").then(function(v) { return v && typeof v === "object" ? v : {}; }); },
    drinks:      function() { return rest("wp_drinks?select=event_id,pay_bar,staff_pay_bar"); },
    boxEvents:   function() { return rest("box_events?status=neq.draft&starts_at=gte." + encodeURIComponent(since) +
                                          "&select=id,name,status,starts_at,pay_bar&order=starts_at.asc&limit=500"); }
  };
  const keys = Object.keys(need);
  const values = await Promise.all(keys.map(function(k) { return jobs[k](); }));
  const data = {};
  keys.forEach(function(k, i) { data[k] = values[i]; });
  return data;
}

async function runOnce(now) {
  const state = await rpc("chk_worker_state", {});
  const templates = (state && state.templates) || [];
  if (!templates.length) return { ok: true, templates: 0, fired: 0 };
  const data = await loadData(templates);
  const plan = planChecklists({ now: now || new Date(), state: state, data: data });
  if (!plan.fire.length && !plan.retime.length && !plan.cancel.length) {
    return { ok: true, templates: templates.length, fired: 0, notes: plan.notes };
  }
  const applied = await rpc("chk_worker_apply", { p: { fire: plan.fire, retime: plan.retime, cancel: plan.cancel } });
  return Object.assign({ templates: templates.length, considered: plan.fire.length, notes: plan.notes }, applied);
}

exports.handler = async function(event) {
  if (event && event.httpMethod && event.httpMethod !== "POST") return json(405, { error: "POST only" });
  const headers = (event && event.headers) || {};
  const fromCron = tokenMatches(headers["x-admin-token"] || "", process.env.HBF_ADMIN_TOKEN);
  if (!fromCron && !(await resolveAdmin(event))) {
    return json(403, { error: "Only a signed-in administrator can run the checklists." });
  }
  if (!process.env.SUPABASE_SERVICE_KEY) return json(500, { error: "SUPABASE_SERVICE_KEY is not set" });
  try {
    const result = await runOnce(new Date());
    console.log("[checklists] " + JSON.stringify(result).slice(0, 1000));
    return json(200, result);
  } catch (e) {
    console.error("[checklists] " + (e && e.message));
    return json(500, { error: String((e && e.message) || e) });
  }
};

exports._test = { runOnce, loadData };
