// netlify/functions/whatsapp-reminders/whatsapp-reminders.js
//
// Sends the scheduled WhatsApps (rules in plan.js, wording in templates.js):
// checklist live / overdue, pre-arrival, and the weekly changeover summary.
//
//   POST, x-admin-token: HBF_ADMIN_TOKEN     the 15-minute shim (whatsapp-reminders-cron.js)
//   POST, Authorization: Bearer <admin JWT>  Settings → WhatsApp → "Check now"
//
// Nothing between 10pm and 8am. Each template sends only while it is switched
// on in Settings → WhatsApp (app_data hbf_whatsapp_settings_v1). Values are
// filled in the order of the version Meta approved (hbf_whatsapp_submitted_v1).
// Each message is marked in wa_sent_marks BEFORE it is sent — a run cut short
// can miss someone, never message them twice — and the mark is removed if
// WhatsApp refuses, so the next run tries again. Every message sent is kept in
// wa_messages with the text exactly as the recipient reads it.
//
// Required env vars: SUPABASE_SERVICE_KEY, HBF_ADMIN_TOKEN, WHATSAPP_TOKEN

"use strict";

const crypto = require("crypto");
const plan = require("./plan.js");
const T = require("./templates.js");

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const GRAPH = "https://graph.facebook.com/v23.0";
const PHONE_NUMBER_ID = "1454490917738977";   // the 01825 number (as in whatsapp-send.js)
const SETTINGS_KEY = "hbf_whatsapp_settings_v1";
const SUBMITTED_KEY = "hbf_whatsapp_submitted_v1";
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
async function appData(key) {
  const rows = await rest("app_data?key=eq." + encodeURIComponent(key) + "&select=value");
  return rows && rows[0] ? rows[0].value : null;
}
function inList(ids) { return "(" + ids.map(function (i) { return '"' + String(i).replace(/"/g, "") + '"'; }).join(",") + ")"; }

async function sentKeys(keys) {
  if (!keys.length) return new Set();
  const out = new Set();
  // Marks are (kind, ref); a key is "kind|ref".
  const byKind = {};
  keys.forEach(function (k) { const i = k.indexOf("|"); (byKind[k.slice(0, i)] = byKind[k.slice(0, i)] || []).push(k.slice(i + 1)); });
  for (const kind of Object.keys(byKind)) {
    const rows = await rest("wa_sent_marks?kind=eq." + encodeURIComponent(kind) + "&ref=in." + encodeURIComponent(inList(byKind[kind])) + "&select=ref");
    rows.forEach(function (r) { out.add(kind + "|" + r.ref); });
  }
  return out;
}

async function loadChecklists(now) {
  const runs = await rest("chk_runs?status=eq.open&opens_at=lte." + encodeURIComponent(now.toISOString()) +
    "&select=id,template_id,title,context,status,opens_at");
  if (!runs.length) return { runs: [], items: [], people: {} };
  const items = await rest("chk_run_items?state=eq.open&who=like.person:*&run_id=in." +
    encodeURIComponent(inList(runs.map(function (r) { return r.id; }))) + "&select=run_id,title,who,due_at,position,state");
  const profiles = await rest("profiles?select=id,name,mobile,active");
  const people = {};
  profiles.forEach(function (p) { people[String(p.id).toLowerCase()] = { name: p.name, mobile: p.mobile, active: p.active }; });
  return { runs: runs, items: items, people: people };
}

async function sendTemplate(name, to, order, values, payloads) {
  const params = order.map(function (k) { return { type: "text", text: T.cleanParam(values[k], 1000) }; });
  const template = { name: name, language: { code: T.TEMPLATES[name].language } };
  const comps = [];
  if (params.length) comps.push({ type: "body", parameters: params });
  // Tap-to-answer buttons carry a payload of ours, so a tap names the booking.
  // They follow any URL button in the template's button list.
  const offset = T.TEMPLATES[name].button ? 1 : 0;
  (T.TEMPLATES[name].quickReplies || []).forEach(function (label, i) {
    if (payloads && payloads[i]) comps.push({ type: "button", sub_type: "quick_reply", index: String(i + offset),
      parameters: [{ type: "payload", payload: payloads[i] }] });
  });
  if (comps.length) template.components = comps;
  const res = await fetch(GRAPH + "/" + PHONE_NUMBER_ID + "/messages", {
    method: "POST",
    headers: { "Authorization": "Bearer " + process.env.WHATSAPP_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: to, type: "template", template: template })
  });
  const d = await res.json().catch(function () { return null; });
  if (!res.ok || !d || !d.messages || !d.messages[0]) {
    const e = new Error("WhatsApp " + res.status + (d && d.error ? ": " + (d.error.error_user_msg || d.error.message) : ""));
    e.code = d && d.error && d.error.code;
    throw e;
  }
  return d.messages[0].id;
}

// Work out everything due now. Exposed for the page's preview and the tests.
async function planNow(now) {
  if (plan.isQuiet(now)) return { quiet: true, send: [], noMobile: [], skipped: [] };
  const settings = (await appData(SETTINGS_KEY)) || {};
  const tpl = settings.templates || {};
  const isOn = function (n) { return !!(tpl[n] && tpl[n].on); };
  const all = [], noMobile = [], skipped = [];

  if (isOn("checklist_live") || isOn("checklist_overdue")) {
    const c = await loadChecklists(now);
    const p = plan.planChecklists({ runs: c.runs, items: c.items, people: c.people, ticks: settings.checklists || {},
      on: { live: isOn("checklist_live"), overdue: isOn("checklist_overdue") }, now: now });
    all.push.apply(all, p.send); noMobile.push.apply(noMobile, p.noMobile);
  }
  if (isOn("pre_arrival")) {
    const arrival = settings.arrival || {};
    const hour = arrival.hour != null ? Number(arrival.hour) : 9;
    if (plan.londonHour(now) >= hour) {
      const accom = (await appData("hbf_accom_v1")) || [];
      const properties = (await appData("hbf_properties_v1")) || [];
      const emailTemplates = (await appData("hbf_email_templates_v1")) || [];
      // Only to tell which kind of event a linked letting is for (its pack).
      let events = [];
      try { events = (await appData("hawthbush_bookings_v6")) || []; } catch (e) { events = []; }
      const p = plan.planArrivals({ accom: accom, properties: properties, arrival: arrival, now: now, events: events,
        hostedPacks: T.hostedPacks(emailTemplates, process.env.HBF_ADMIN_TOKEN) });
      all.push.apply(all, p.send); skipped.push.apply(skipped, p.skipped);
    }
  }
  if (isOn("changeover_summary")) {
    const s = settings.summary || {};
    const day = s.day == null ? 0 : Number(s.day), hour = s.hour == null ? 8 : Number(s.hour);
    if (plan.londonWeekday(now) === day && plan.londonHour(now) >= hour) {
      const today = plan.londonDate(now);
      const until = new Date(now.getTime() + 11 * 864e5).toISOString();
      const data = {
        accom: (await appData("hbf_accom_v1")) || [],
        properties: (await appData("hbf_properties_v1")) || [],
        events: (await appData("hawthbush_bookings_v6")) || [],
        setups: (await appData("hbf_setup_cleans_v1")) || [],
        boxEvents: await rest("box_events?status=neq.draft&starts_at=gte." + today + "&starts_at=lte." + encodeURIComponent(until) +
          "&select=id,name,status,starts_at,ends_at")
      };
      // The wording in use decides how much room each day gets.
      const sub = ((await appData(SUBMITTED_KEY)) || {}).changeover_summary;
      const words = sub && sub.body ? sub.body : T.TEMPLATES.changeover_summary.body;
      const fixedLen = words.replace(/\{\{\s*[A-Za-z][A-Za-z0-9_]*\s*\}\}/g, "").length;
      const p = plan.planSummary(Object.assign({ settings: s, now: now, fixedLen: fixedLen }, data));
      all.push.apply(all, p.send); skipped.push.apply(skipped, p.skipped);
    }
  }
  const sent = await sentKeys(all.map(function (x) { return x.key; }));
  return { send: all.filter(function (x) { return !sent.has(x.key); }), noMobile: noMobile, skipped: skipped };
}

async function runOnce(now) {
  const started = Date.now();
  const p = await planNow(now);
  if (p.quiet) return { quiet: true, sent: 0 };
  if (!p.send.length) return { sent: 0, noMobile: p.noMobile.map(function (x) { return x.name; }) };
  if (!process.env.WHATSAPP_TOKEN) return { error: "WHATSAPP_TOKEN is not set", sent: 0 };
  const submitted = (await appData(SUBMITTED_KEY)) || {};
  const out = { sent: 0, failed: [], notApproved: [], noMobile: p.noMobile.map(function (x) { return x.name; }) };
  const dead = {};   // templates Meta refused as missing / unapproved this run
  for (const m of p.send) {
    if (Date.now() - started > STOP_AFTER_MS) { out.stoppedEarly = true; break; }
    if (dead[m.template]) continue;
    const i = m.key.indexOf("|"), kind = m.key.slice(0, i), ref = m.key.slice(i + 1);
    const mark = await rest("wa_sent_marks?on_conflict=kind,ref", {
      method: "POST", headers: { "Prefer": "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify([{ kind: kind, ref: ref }])
    });
    if (!mark || !mark.length) continue;            // another run got there first
    const sub = submitted[m.template] || null;
    const order = T.sendOrder(m.template, sub);
    try {
      const id = await sendTemplate(m.template, m.to, order, m.values, m.payloads);
      out.sent++;
      const text = T.render(sub && sub.body ? sub.body : T.TEMPLATES[m.template].body, m.values);
      await rest("wa_sent_marks?kind=eq." + encodeURIComponent(kind) + "&ref=eq." + encodeURIComponent(ref), {
        method: "PATCH", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({ wa_id: id }) }).catch(function () {});
      await rest("wa_messages", { method: "POST", headers: { "Prefer": "return=minimal" }, body: JSON.stringify({
        id: id, direction: "out", number: m.to, to_name: m.toName || null, template: m.template, msg_type: "template",
        body: text.slice(0, 4000), at: new Date().toISOString(), status: "accepted",
        record_kind: m.record.kind, record_id: m.record.id, record_name: m.record.name }) }).catch(function () {});
    } catch (e) {
      await rest("wa_sent_marks?kind=eq." + encodeURIComponent(kind) + "&ref=eq." + encodeURIComponent(ref),
        { method: "DELETE", headers: { "Prefer": "return=minimal" } }).catch(function () {});
      // 132001 / 132000-range: template missing, unapproved or its values
      // don't fit — the rest of this template would fail the same way.
      if (e.code === 132001 || e.code === 132000 || /13200[01]/.test(e.message)) {
        dead[m.template] = true; out.notApproved.push(m.template);
      } else {
        out.failed.push(m.template + ": " + e.message);
      }
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

exports._test = { runOnce: runOnce, planNow: planNow };
