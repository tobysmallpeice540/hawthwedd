// netlify/functions/portal-nudges.js
//
// The weekly deadline reminder to couples. Monday mornings (portal-nudges-cron.js),
// OFF until switched on in Settings → Email templates → Client portal →
// "Deadline reminder" (app_data hbf_portal_email_templates_v1, item id
// "nudge", { on, subject, body, button }).
//
// What goes in it is worked out by the database, in wp_nudge_plan(today) —
// checklist items, payments still to come, the drinks order closing, and in
// the last eight weeks the pages not yet marked done. One email per event per
// week, to every active portal login on it, and only when something is due:
// a quiet week sends nothing.
//
// Never twice in a week: each (event, week) is recorded through wp_nudge_mark
// BEFORE the email goes, and the mark refuses a week already taken. A send that
// fails is given back (wp_nudge_unmark) so the next run can try. Every send is
// logged to hbf_email_log_v1 (Recent Automated Emails). The email links to the
// portal's sign-in page, never a sign-in link: a link is a credential, and this
// one would sit in an inbox for a week.
//
//   POST, x-admin-token: HBF_ADMIN_TOKEN       runs it (portal-nudges-cron.js)
//   POST, Authorization: Bearer <admin JWT>    { dryRun: true[, today] } only —
//                                              the "what would go" preview
//
// Required env vars: SUPABASE_SERVICE_KEY, RESEND_API_KEY, HBF_ADMIN_TOKEN

const crypto = require("crypto");

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const ADMIN_TOKEN  = process.env.HBF_ADMIN_TOKEN;

const SITE_ORIGIN   = "https://hawthbushfarm.netlify.app";
const PORTAL_URL    = SITE_ORIGIN + "/portal";
const FROM_EMAIL    = "hello@hawthbushfarm.co.uk";
const FROM_HEADER   = "Hawthbush Farm <" + FROM_EMAIL + ">";
const TEMPLATES_KEY = "hbf_portal_email_templates_v1";
const EMAIL_LOG_KEY = "hbf_email_log_v1";
const FN_BUILD      = "2026-10-25c";

// A bad week (a data import, a clock problem) must not become a mass mailing.
const MAX_SENDS_PER_RUN = 40;

// Mirrors the "nudge" entry of DEFAULT_PORTAL_EMAILS in App.jsx. A field left
// blank in Settings falls back to this wording, field by field.
const DEFAULT_NUDGE = {
  on: false,
  subject: "Coming up for your day at Hawthbush Farm",
  button: "Open your planner",
  body: "Hello {firstName},\n\n" +
        "A quick note of what is coming up for {event} on {eventDate}.\n\n" +
        "{list}\n\n" +
        "You can do all of these in your planner — the button below takes you there. Anything you have already done, tick off or mark as done and it will not come up again.\n\n" +
        "If you have a question about any of it, just reply to this email."
};

// The pages a couple marks as done, as the portal names them (READY_LABEL in
// src/portal/ReadyBar.jsx).
const SECTION_LABEL = {
  guests: "your guest list", food: "your food choices", drinks: "your drinks order", bar: "your bar choices",
  timeline: "your timeline", music: "your music", suppliers: "your suppliers", layout: "your table plan",
  items: "the list of things you are bringing", details: "your details"
};

function tokenMatches(given, expected) {
  if (!expected || typeof given !== "string" || !given) return false;
  var a = Buffer.from(given, "utf8"), b = Buffer.from(String(expected), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─── Pure (exported for tests) ───────────────────────────────────────────────
function isIso(d) { return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d); }
function londonToday() { return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" }); }
// The Monday of the week `iso` falls in — the key for "once a week".
function weekOf(iso) {
  var d = new Date(iso + "T12:00:00Z");
  var back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}
function money(v) {
  return "£" + Number(v).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function dayDate(iso) {
  if (!isIso(iso)) return "";
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London" });
}
function longDate(iso) {
  if (!isIso(iso)) return "";
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });
}
function joinWords(a) {
  if (a.length <= 1) return a.join("");
  return a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
}
// "Sam and Alex" from the two client names, or from "Sam Jones & Alex Smith".
function coupleFirstNames(ev) {
  var named = [ev.client1, ev.client2].map(function (n) { return String(n || "").trim(); }).filter(Boolean);
  var parts = named.length ? named : String(ev.couple || "").split(/\s*(?:&|\band\b|\+)\s*/i).map(function (x) { return x.trim(); }).filter(Boolean);
  var firsts = parts.map(function (n) { return n.split(/\s+/)[0]; }).filter(Boolean).slice(0, 2);
  return firsts.length ? firsts.join(" and ") : "there";
}

function mergeTemplate(saved) {
  var list = Array.isArray(saved) ? saved : [];
  var t = list.find(function (x) { return x && x.id === "nudge"; }) || {};
  return {
    on: t.on === true,
    subject: String(t.subject || "").trim() || DEFAULT_NUDGE.subject,
    body: String(t.body || "").trim() || DEFAULT_NUDGE.body,
    button: String(t.button || "").trim() || DEFAULT_NUDGE.button
  };
}

// The items as groups of lines. Plain text; the HTML is built from the same.
function listGroups(items) {
  var overdue = [], soon = [], pages = [], paidNote = false;
  (items || []).forEach(function (i) {
    if (i.kind === "section") { if (SECTION_LABEL[i.section]) pages.push(SECTION_LABEL[i.section]); return; }
    var line;
    if (i.kind === "payment") {
      line = String(i.label || "Payment") + ": " + money(i.amount) + (i.overdue ? " — was due " : " — due ") + dayDate(i.due);
      if (i.overdue) paidNote = true;
    } else if (i.kind === "drinks") {
      line = "Your drinks order closes on " + dayDate(i.due);
    } else {
      line = String(i.label || "") + (i.overdue ? " — was due " : " — by ") + dayDate(i.due);
    }
    (i.overdue ? overdue : soon).push(line);
  });
  var groups = [];
  if (overdue.length) groups.push({ title: "Still to do", lines: overdue });
  if (soon.length) groups.push({ title: "Coming up in the next three weeks", lines: soon });
  if (pages.length) groups.push({ title: "Before the day", lines: ["Still to mark as done: " + joinWords(pages) + " — there is a button for it at the bottom of each page"] });
  if (paidNote) groups.push({ title: null, lines: ["If you have paid recently, thank you — it can take a few days to reach our records."] });
  return groups;
}
function listText(groups) {
  return groups.map(function (g) {
    return (g.title ? g.title + ":\n" : "") + g.lines.map(function (l) { return (g.title ? "• " : "") + l; }).join("\n");
  }).join("\n\n");
}

function escapeHtml(s) {
  return String(s === null || s === undefined ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function listHtml(groups) {
  return groups.map(function (g) {
    if (!g.title) return '<p style="margin:0 0 15px;font-size:13px;line-height:1.6;color:#7a7060">' + g.lines.map(escapeHtml).join("<br>") + "</p>";
    return '<p style="margin:0 0 6px;font-size:15px;line-height:1.5;color:#2d2a25"><strong>' + escapeHtml(g.title) + "</strong></p>" +
      '<ul style="margin:0 0 15px;padding-left:20px;font-size:15px;line-height:1.65;color:#2d2a25">' +
      g.lines.map(function (l) { return "<li>" + escapeHtml(l) + "</li>"; }).join("") + "</ul>";
  }).join("");
}

// Everything that would go, without sending.
function planEmails(plan, tpl) {
  return (Array.isArray(plan) ? plan : []).map(function (ev) {
    var groups = listGroups(ev.items);
    if (!groups.length) return null;
    var tokens = { firstName: coupleFirstNames(ev), event: String(ev.couple || "").trim() || "your day",
                   eventDate: longDate(ev.event_date), portalUrl: PORTAL_URL };
    var fillText = function (s) { return String(s).replace(/\{(\w+)\}/g, function (m, k) { return k === "list" ? m : (tokens[k] != null ? tokens[k] : ""); }); };
    var body = fillText(tpl.body);
    if (body.indexOf("{list}") === -1) body = body.replace(/\n\n/, "\n\n{list}\n\n");          // never an email with no list
    if (body.indexOf("{list}") === -1) body += "\n\n{list}";
    var text = body.split("{list}").join(listText(groups)) + "\n\n" + tpl.button + ": " + PORTAL_URL;
    var html = body.replace(/\r\n/g, "\n").split(/\n{2,}/).map(function (p) {
      p = p.trim();
      if (!p) return "";
      if (p === "{list}") return listHtml(groups);
      return '<p style="margin:0 0 15px;font-size:15px;line-height:1.65;color:#2d2a25">' +
        escapeHtml(p).replace(/\n/g, "<br>").split("{list}").join("</p>" + listHtml(groups) + '<p style="margin:0 0 15px;font-size:15px;line-height:1.65;color:#2d2a25">') + "</p>";
    }).join("");
    return {
      event_id: ev.event_id, who: ev.couple || ev.emails[0], to: ev.emails,
      subject: fillText(tpl.subject), text: text, html: emailShell(html, { buttonUrl: PORTAL_URL, buttonLabel: tpl.button }),
      items: (ev.items || []).length
    };
  }).filter(Boolean);
}

// ─── SHARED EMAIL SHELL (as _email-shell.js, taking ready-made HTML) ─────────
function emailShell(inner, o) {
  if (o && o.buttonUrl) {
    inner += '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 6px">' +
      '<tr><td align="center" bgcolor="#2d2a25" style="border-radius:8px">' +
      '<a href="' + escapeHtml(o.buttonUrl) + '" style="display:inline-block;padding:13px 30px;font-family:Helvetica,Arial,sans-serif;' +
      'font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px">' +
      escapeHtml(o.buttonLabel || "Open") + "</a></td></tr></table>";
  }
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>Hawthbush Farm</title></head>" +
    '<body style="margin:0;padding:0;background:#f9f6f1;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f9f6f1;padding:26px 12px">' +
    '<tr><td align="center"><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%">' +
    '<tr><td align="center" style="padding:0 0 20px"><a href="https://www.hawthbushfarm.co.uk"><img src="' + SITE_ORIGIN + '/email-logo.png" alt="Hawthbush Farm" width="110" ' +
    'style="display:block;border:0;width:110px;height:auto"></a></td></tr>' +
    '<tr><td style="background:#ffffff;border:1px solid #e8e2d9;border-radius:14px;padding:30px 34px;font-family:Helvetica,Arial,sans-serif">' + inner + "</td></tr>" +
    '<tr><td align="center" style="padding:20px 16px 0;font-family:Helvetica,Arial,sans-serif">' +
    '<p style="margin:0 0 4px;font-size:12px;line-height:1.6;color:#7a7060">Hawthbush Farm, Gun Hill, Heathfield, East Sussex &middot; ' +
    '<a href="mailto:' + FROM_EMAIL + '" style="color:#7a7060">' + FROM_EMAIL + "</a></p>" +
    '<p style="margin:0;font-size:12px;color:#7a7060"><a href="https://www.hawthbushfarm.co.uk" style="color:#7a7060">hawthbushfarm.co.uk</a></p>' +
    "</td></tr></table></td></tr></table></body></html>";
}

// ─── I/O ─────────────────────────────────────────────────────────────────────
async function rpc(fn, args) {
  var res = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + fn, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(args || {})
  });
  var text = await res.text();
  if (!res.ok) throw new Error(fn + " " + res.status + ": " + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}
async function sbGet(key) {
  var res = await fetch(SUPABASE_URL + "/rest/v1/app_data?key=eq." + key + "&select=value", {
    headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY }
  });
  if (!res.ok) throw new Error("reading " + key + ": " + res.status);
  var rows = await res.json();
  return rows && rows[0] ? rows[0].value : null;
}
async function sbSet(key, value) {
  var res = await fetch(SUPABASE_URL + "/rest/v1/app_data", {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key: key, value: value, updated_at: new Date().toISOString() })
  });
  if (!res.ok) throw new Error("saving " + key + ": " + res.status);
}
// One read and one write of the email log for the whole run. Re-read first.
async function logEmails(entries) {
  if (!entries.length) return;
  try {
    var log = (await sbGet(EMAIL_LOG_KEY)) || [];
    entries.forEach(function (x) {
      log.push({ id: "el" + Date.now() + "-" + Math.random().toString(36).slice(2, 6), sentAt: x.at, subject: x.subject,
                 to: x.to, template: "portal_nudge", bookingId: String(x.event_id), body: String(x.text || "").slice(0, 8000) });
    });
    await sbSet(EMAIL_LOG_KEY, log.slice(-500));
  } catch (e) { console.error("email log write failed:", e.message); }
}
async function resolveAdmin(event) {
  var auth = event.headers["authorization"] || event.headers["Authorization"] || "";
  var jwt = auth.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return null;
  var res = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + jwt } });
  if (!res.ok) return null;
  var user = await res.json();
  if (!user || !user.id) return null;
  var pr = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + user.id + "&select=role,active",
    { headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY } });
  if (!pr.ok) return null;
  var p = (await pr.json())[0];
  return p && p.active !== false && p.role === "admin" ? user.id : null;
}

function reply(code, body) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ build: FN_BUILD }, body)) };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return reply(405, { error: "POST only" });
  if (!SERVICE_KEY) return reply(500, { error: "SUPABASE_SERVICE_KEY is not set" });
  var body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "bad JSON" }); }

  var token = (event.headers && (event.headers["x-admin-token"] || event.headers["X-Admin-Token"])) || "";
  var byClock = tokenMatches(String(token), ADMIN_TOKEN);
  if (!byClock) {
    // An admin may look, never send: the sends belong to the clock.
    if (!body.dryRun) return reply(403, { error: "Only the scheduled run sends." });
    if (!(await resolveAdmin(event))) return reply(403, { error: "Admins only." });
  }

  var today = londonToday();
  // The preview can be asked about another day ("next Monday"); the real run
  // is always today.
  if (body.dryRun && isIso(body.today)) today = body.today;

  var tpl, plan;
  try {
    tpl = mergeTemplate(await sbGet(TEMPLATES_KEY));
    plan = await rpc("wp_nudge_plan", { p_today: today });
  } catch (e) {
    // A failed read must never look like "nobody to remind" — or like everybody.
    return reply(500, { error: e.message });
  }
  var emails = planEmails(plan, tpl);
  var week = weekOf(today);

  if (body.dryRun) {
    return reply(200, { ok: true, dryRun: true, today: today, week: week, on: tpl.on,
      due: emails.map(function (m) { return { event_id: m.event_id, who: m.who, to: m.to, subject: m.subject, items: m.items, text: m.text }; }) });
  }
  if (!tpl.on) return reply(200, { ok: true, today: today, off: true, sent: 0 });
  if (!emails.length) return reply(200, { ok: true, today: today, sent: 0 });
  if (!RESEND_KEY) return reply(500, { error: "RESEND_API_KEY is not set", due: emails.length });

  var sent = [], skipped = [], failed = [], logged = [];
  for (var i = 0; i < emails.length && sent.length < MAX_SENDS_PER_RUN; i++) {
    var m = emails[i];
    // Marked BEFORE sending. False means this event already had its email
    // this week (a second run, or a retry) — skip it.
    var mine;
    try { mine = await rpc("wp_nudge_mark", { p_event: m.event_id, p_week: week, p_emails: m.to, p_items: m.items }); }
    catch (e) { failed.push({ event_id: m.event_id, error: "could not record: " + e.message }); continue; }
    if (mine !== true) { skipped.push(m.event_id); continue; }
    try {
      var res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM_HEADER, to: m.to, reply_to: FROM_EMAIL, subject: m.subject, html: m.html, text: m.text })
      });
      if (!res.ok) throw new Error((await res.text()).slice(0, 300));
      sent.push(m.event_id);
      logged.push({ at: new Date().toISOString(), subject: m.subject, to: m.to.join(", "), event_id: m.event_id, text: m.text });
    } catch (e) {
      failed.push({ event_id: m.event_id, error: String(e.message || e) });
      try { await rpc("wp_nudge_unmark", { p_event: m.event_id, p_week: week }); }
      catch (x) { console.error("could not free the week for event " + m.event_id + " (it will not be retried this week):", x.message); }
    }
  }
  await logEmails(logged);
  var held = emails.length - sent.length - skipped.length - failed.length;
  console.log("[portal-nudges] " + today + " (week of " + week + ") sent " + sent.length + ", already sent " + skipped.length +
              ", failed " + failed.length + (held > 0 ? ", " + held + " held to the next run" : ""));
  return reply(failed.length ? 207 : 200, { ok: !failed.length, today: today, week: week, sent: sent, skipped: skipped, failed: failed, held: Math.max(0, held) });
};

exports._test = { weekOf, listGroups, listText, planEmails, mergeTemplate, coupleFirstNames, DEFAULT_NUDGE, SECTION_LABEL };
