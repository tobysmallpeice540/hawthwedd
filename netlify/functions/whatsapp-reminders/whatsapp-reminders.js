// netlify/functions/whatsapp-reminders/whatsapp-reminders.js
//
// Sends WhatsApp checklist reminders to named staff (rules in plan.js).
//
//   POST, x-admin-token: HBF_ADMIN_TOKEN     the 15-minute shim (whatsapp-reminders-cron.js)
//   POST, Authorization: Bearer <admin JWT>  Settings → WhatsApp → "Check now"
//
// Does nothing unless Settings → WhatsApp → Checklist reminders is on
// (app_data hbf_whatsapp_settings_v1). Each (list, person) is marked in
// wa_reminders_sent BEFORE the send — a run cut short can miss someone, never
// message them twice — and the mark is removed if WhatsApp refuses, so the
// next run (if still before the due time) tries again. Every message sent is
// kept in wa_messages as direction "out".
//
// Required env vars: SUPABASE_SERVICE_KEY, HBF_ADMIN_TOKEN, WHATSAPP_TOKEN

"use strict";

const crypto = require("crypto");
const { planReminders } = require("./plan.js");

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const GRAPH = "https://graph.facebook.com/v23.0";
const PHONE_NUMBER_ID = "1454490917738977";   // the 01825 number (as in whatsapp-send.js)
const TEMPLATE = { name: "checklist_reminder", language: "en_GB" };
const SETTINGS_KEY = "hbf_whatsapp_settings_v1";
const STOP_AFTER_MS = 7500;                    // Netlify's limit is 10s

function json(statusCode, body) {
  return { statusCode: statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
function sh(extra) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return Object.assign({ "apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json" }, extra || {});
}
async function rest(path, opts) {
  const o = opts || {};
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + path, { method: o.method || "GET", headers: sh(o.headers), body: o.body });
  const text = await res.text();
  if (!res.ok) throw new Error(path.split("?")[0] + " " + res.status + " " + text.slice(0, 200));
  return text ? JSON.parse(text) : null;
}
function inList(ids) { return "(" + ids.map(function (i) { return '"' + String(i).replace(/"/g, "") + '"'; }).join(",") + ")"; }

async function loadData(now) {
  const rows = await rest("app_data?key=eq." + SETTINGS_KEY + "&select=value");
  const settings = (rows && rows[0] && rows[0].value && rows[0].value.checklistReminders) || {};
  if (!settings.on) return { off: true };

  const runs = await rest("chk_runs?status=eq.open&opens_at=lte." + encodeURIComponent(now.toISOString()) +
    "&select=id,title,context,status");
  if (!runs.length) return { settings: settings, runs: [], items: [], people: {}, sent: new Set() };
  const ids = runs.map(function (r) { return r.id; });
  const items = await rest("chk_run_items?state=eq.open&who=like.person:*&run_id=in." + encodeURIComponent(inList(ids)) +
    "&select=run_id,title,who,due_at,position,state");
  const sentRows = await rest("wa_reminders_sent?kind=eq.checklist&run_id=in." + encodeURIComponent(inList(ids)) + "&select=run_id,person");
  const profiles = await rest("profiles?select=id,name,mobile,active");
  const people = {};
  profiles.forEach(function (p) { people[String(p.id).toLowerCase()] = { name: p.name, mobile: p.mobile, active: p.active }; });
  const sent = new Set(sentRows.map(function (r) { return r.run_id + "|" + String(r.person).toLowerCase(); }));
  return { settings: settings, runs: runs, items: items, people: people, sent: sent };
}

async function sendTemplate(to, params) {
  const res = await fetch(GRAPH + "/" + PHONE_NUMBER_ID + "/messages", {
    method: "POST",
    headers: { "Authorization": "Bearer " + process.env.WHATSAPP_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", to: to, type: "template",
      template: { name: TEMPLATE.name, language: { code: TEMPLATE.language },
        components: [{ type: "body", parameters: params.map(function (t) { return { type: "text", text: t }; }) }] }
    })
  });
  const d = await res.json().catch(function () { return null; });
  if (!res.ok || !d || !d.messages || !d.messages[0]) {
    const e = new Error("WhatsApp " + res.status + (d && d.error ? ": " + (d.error.error_user_msg || d.error.message) : ""));
    e.code = d && d.error && d.error.code;
    throw e;
  }
  return d.messages[0].id;
}

async function runOnce(now) {
  const started = Date.now();
  const data = await loadData(now);
  if (data.off) return { off: true, sent: 0 };
  if (!process.env.WHATSAPP_TOKEN) return { error: "WHATSAPP_TOKEN is not set", sent: 0 };
  const plan = planReminders({ runs: data.runs, items: data.items, people: data.people, sent: data.sent,
    settings: data.settings, now: now });

  const out = { sent: 0, failed: [], noMobile: plan.noMobile.map(function (x) { return x.name; }) };
  for (const r of plan.send) {
    if (Date.now() - started > STOP_AFTER_MS) { out.stoppedEarly = true; break; }
    // Mark first. An empty answer means another run got there: skip.
    const mark = await rest("wa_reminders_sent?on_conflict=kind,run_id,person", {
      method: "POST", headers: { "Prefer": "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify([{ kind: "checklist", run_id: r.run_id, person: r.person }])
    });
    if (!mark || !mark.length) continue;
    try {
      const id = await sendTemplate(r.to, r.params);
      out.sent++;
      await rest("wa_reminders_sent?kind=eq.checklist&run_id=eq." + r.run_id + "&person=eq." + r.person, {
        method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ wa_id: id }) }).catch(function () {});
      await rest("wa_messages", { method: "POST", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({
        id: id, direction: "out", number: r.to, msg_type: "template",
        body: "Checklist reminder: " + r.params.slice(1).join(" | "), at: new Date().toISOString(), status: "accepted",
        record_kind: "checklist", record_id: r.run_id, record_name: r.params[2] }) }).catch(function () {});
    } catch (e) {
      out.failed.push(e.message);
      await rest("wa_reminders_sent?kind=eq.checklist&run_id=eq." + r.run_id + "&person=eq." + r.person,
        { method: "DELETE", headers: { "Prefer": "return=minimal" } }).catch(function () {});
      // 132001: the template is not approved (or not submitted) yet — stop, the rest would fail the same way.
      if (e.code === 132001 || /132001/.test(e.message)) { out.templateMissing = true; break; }
    }
  }
  return out;
}

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

exports.handler = async function (event) {
  if (event && event.httpMethod && event.httpMethod !== "POST") return json(405, { error: "POST only" });
  const headers = (event && event.headers) || {};
  const fromCron = tokenMatches(headers["x-admin-token"] || "", process.env.HBF_ADMIN_TOKEN);
  if (!fromCron && !(await resolveAdmin(event))) return json(403, { error: "Administrators only." });
  if (!process.env.SUPABASE_SERVICE_KEY) return json(500, { error: "SUPABASE_SERVICE_KEY is not set" });
  try {
    const result = await runOnce(new Date());
    console.log("[whatsapp-reminders] " + JSON.stringify(result).slice(0, 800));
    return json(200, result);
  } catch (e) {
    console.error("[whatsapp-reminders] " + (e && e.message));
    return json(500, { error: String((e && e.message) || e) });
  }
};

exports._test = { runOnce: runOnce };
