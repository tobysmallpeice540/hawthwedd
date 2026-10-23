// netlify/functions/automations.js
//
// The three automatic follow-ups, each OFF until switched on in Settings →
// Email templates → Follow-ups (app_data hbf_automations_v1):
//
//   followup  An enquiry (including a brochure request) that has had no
//             contact since it arrived, N days on: "did the brochure reach
//             you, would you like to visit?"
//   quiet     An open enquiry with no activity for N days: a check-in. If
//             nothing happens for a further M days after that, the app flags
//             the enquiry "gone quiet" (worked out in the app from the
//             marker this writes; nothing more is sent).
//   thanks    N days after a confirmed event: thank you, and a review link.
//
// Each goes to a person once, ever. What was sent is recorded in its own key,
// hbf_automation_sent_v1 ({ "enq:<id>": { followup, quiet },
// "ev:<id>:<date>": { thanks } }), which nothing else writes — this never rewrites the shared
// enquiries or events arrays. Every send is logged to hbf_email_log_v1 so it
// shows in Recent Automated Emails.
//
// "Activity" is what the app already counts as last contact: the contact log,
// a viewing that has happened, email exchanged with the address AS LAST SEEN
// BY THE APP (the Gmail cache, hbf_enquiry_email_seen_v1, refreshed when the
// enquiries list is opened with Gmail connected), and the enquiry arriving.
// Silence is only counted as far as Gmail has confirmed it: every gap runs
// from the last activity to the day Gmail last looked at that address
// (hbf_enquiry_email_seen_v1 records when), never to today. An address Gmail
// has never been asked about is never emailed by the follow-up or check-in.
//
// Never acts on anything old when first switched on: each rule has a window
// (a few days to a few weeks past its trigger) and ignores what is outside it.
//
//   POST, x-admin-token: HBF_ADMIN_TOKEN       runs it (automations-cron.js)
//   POST, Authorization: Bearer <admin JWT>    { dryRun: true } only — the
//                                              "What would go today" preview
//
// Required env vars: SUPABASE_SERVICE_KEY, RESEND_API_KEY, HBF_ADMIN_TOKEN

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const ADMIN_TOKEN  = process.env.HBF_ADMIN_TOKEN;

const SETTINGS_KEY   = "hbf_automations_v1";
const MARKS_KEY      = "hbf_automation_sent_v1";
const ENQUIRIES_KEY  = "hbf_enquiries_v1";
const EVENTS_KEY     = "hawthbush_bookings_v6";
const EMAIL_SEEN_KEY = "hbf_enquiry_email_seen_v1";
const EMAIL_LOG_KEY  = "hbf_email_log_v1";

const FROM_EMAIL  = "hello@hawthbushfarm.co.uk";
const FROM_HEADER = "Hawthbush Farm <" + FROM_EMAIL + ">";
const SITE_ORIGIN = "https://hawthbushfarm.netlify.app";
const FN_BUILD    = "2026-10-23a";

// A bad day (a data import, a clock problem) must not become a mass mailing.
const MAX_SENDS_PER_RUN = 15;

// Mirrors DEFAULT_AUTOMATIONS in App.jsx. A field left blank in Settings falls
// back to this wording, field by field, so an empty email is never sent.
const DEFAULTS = {
  followup: { on: false, days: 3,
    subject: "Following up on your enquiry — Hawthbush Farm",
    body: "Hello {firstName},\n\nThank you again for getting in touch about Hawthbush Farm. I wanted to check that everything reached you, and to see whether you have any questions at all.\n\nIf you would like to come and see the farm, just reply with a few dates that suit you and we will arrange a viewing.\n\nAnd if you would rather we did not follow up, just say so — we will not mind in the least.\n\nWarm regards,\nHawthbush Farm" },
  quiet: { on: false, days: 21, flagDays: 7,
    subject: "Still thinking about Hawthbush Farm?",
    body: "Hello {firstName},\n\nWe have not heard from you for a little while, so I wanted to check in. Dates do go, so if you are still thinking about Hawthbush Farm it is worth letting us know which ones you have in mind.\n\nAnd if you have found your venue elsewhere, congratulations — a one-line reply saying so would help us a great deal, and we will not email again.\n\nWarm regards,\nHawthbush Farm" },
  thanks: { on: false, days: 2, reviewUrl: "", button: "Leave a review",
    subject: "Thank you from Hawthbush Farm",
    body: "Dear {firstName},\n\nThank you for celebrating with us. It was a real pleasure to be part of your day, and we hope you and your guests enjoyed every moment.\n\nIf you have a minute, a review would mean a great deal to a small venue like ours.\n\nWith warmest wishes,\nHawthbush Farm" }
};
// How far past its trigger each rule still acts. Outside this, an enquiry or
// event is history and is left alone.
const WINDOW_DAYS = { followup: 7, quiet: 14, thanks: 14 };

// Occasions where "thank you for celebrating with us" and "found your venue
// elsewhere? congratulations" would be badly wrong. The check-in and the
// thank-you never go to these; the neutral first follow-up still may.
const SOMBRE = /\b(wake|funeral|memorial|celebration of life)\b/i;

// ─── Pure decisions (exported for tests) ─────────────────────────────────────
function isIso(d) { return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d); }
function daysBetween(a, b) { return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000); }
function validEmail(s) { const v = String(s || "").trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : ""; }
function num(v, d) { const n = Number(v); return isFinite(n) && n >= 1 && n <= 365 ? Math.round(n) : d; }

function mergeSettings(saved) {
  const s = saved && typeof saved === "object" ? saved : {};
  const out = {};
  Object.keys(DEFAULTS).forEach(function (k) {
    const d = DEFAULTS[k], v = s[k] && typeof s[k] === "object" ? s[k] : {};
    out[k] = Object.assign({}, d, {
      on: v.on === true,
      days: num(v.days, d.days),
      subject: String(v.subject || "").trim() || d.subject,
      body: String(v.body || "").trim() || d.body
    });
    if (k === "quiet") out[k].flagDays = num(v.flagDays, d.flagDays);
    if (k === "thanks") {
      const url = String(v.reviewUrl || "").trim();
      out[k].reviewUrl = /^https:\/\/\S+$/.test(url) ? url : "";
      out[k].button = String(v.button || "").trim() || d.button;
    }
  });
  return out;
}

// When the enquiry arrived: its id is minted as enq_<epoch>; otherwise the
// earliest contact line. Same reading as enquiryReceivedDate in App.jsx.
function receivedDate(e) {
  const m = /^enq_(\d{12,})$/.exec(String((e && e.id) || ""));
  if (m) { const d = new Date(Number(m[1])); if (!isNaN(d)) return d.toISOString().slice(0, 10); }
  const dates = ((e && e.contacts) || []).map(function (c) { return c && c.date; }).filter(isIso).sort();
  return dates[0] || null;
}
// The most recent activity, as lastContactFrom in App.jsx counts it.
function lastActivity(e, emailSeen, today) {
  const dates = [];
  (e.contacts || []).forEach(function (c) { if (c && isIso(c.date)) dates.push(c.date); });
  const em = validEmail(e.email);
  const seen = em && emailSeen && emailSeen[em];
  if (seen && isIso(seen.date)) dates.push(seen.date);
  (e.viewings || []).forEach(function (v) { if (v && isIso(v.date) && v.date <= today) dates.push(v.date); });
  const r = receivedDate(e);
  if (r) dates.push(r);
  return dates.sort().pop() || null;
}
// The day Gmail was last asked about this address (the app's cache records
// when it looked, whether or not it found anything). Silence is only known up
// to that day: after it, a reply could have arrived that nobody has seen.
function gmailCheckedOn(e, emailSeen) {
  const em = validEmail(e && e.email);
  const c = em && emailSeen && emailSeen[em];
  const t = c && Date.parse(c.at || "");
  if (!t || !isFinite(t)) return null;
  return new Date(t).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}
// Days of silence since `from` that Gmail has actually confirmed: from the
// last activity to the last check, never to today. 0 if never checked.
function verifiedQuietDays(from, checked) {
  if (!from || !checked || checked < from) return 0;
  return daysBetween(from, checked);
}
function hasViewingToCome(e, today) {
  return (e.viewings || []).some(function (v) { return v && isIso(v.date) && v.date > today; });
}
function firstName(name, email) {
  const n = String(name || "").trim();
  if (!n || n.indexOf("@") !== -1) return "there";
  return n.split(/[\s&,]+/)[0];
}
// "Elizabeth and Ashley" from the two client names, or from "Elizabeth
// Bradley & Ashley Williams" when only the couple field is filled in.
function coupleFirstNames(ev) {
  const named = [ev.client1Name, ev.client2Name].map(function (n) { return String(n || "").trim(); }).filter(Boolean);
  const parts = named.length ? named : String(ev.couple || "").split(/\s*(?:&|\band\b|\+)\s*/i).map(function (x) { return x.trim(); }).filter(Boolean);
  const firsts = parts.map(function (n) { return n.split(/\s+/)[0]; }).filter(Boolean).slice(0, 2);
  return firsts.length ? firsts.join(" and ") : "there";
}
function fill(str, tokens) {
  return String(str || "").replace(/\{(\w+)\}/g, function (m, k) { return tokens[k] != null ? String(tokens[k]) : ""; });
}
function longDate(iso) {
  if (!isIso(iso)) return "";
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });
}

// Everything that is due today, without sending anything.
function planAutomations(o) {
  const cfg = mergeSettings(o.settings);
  const today = o.today;
  const marks = o.marks || {};
  const seen = o.emailSeen || {};
  const out = [];
  // Due by the calendar but not yet confirmed by Gmail — shown in the preview
  // so "why has nothing gone?" has an answer.
  const waiting = [];
  // One email per address per run, whatever the rule — two enquiries from the
  // same couple must not mean two identical emails on the same morning.
  const used = {};
  // Anyone with a live event is a client, not an open enquiry, whatever the
  // enquiry's outcome says (an event entered directly leaves the enquiry
  // "undecided").
  const clients = {};
  (o.events || []).forEach(function (ev) {
    if (!ev || String(ev.status || "") === "Cancelled") return;
    [ev.email, ev.email2, ev.email3].forEach(function (x) { const v = validEmail(x); if (v) clients[v] = true; });
  });

  (o.enquiries || []).forEach(function (e) {
    if (!e || !e.id || e.noAutoEmails) return;
    const outcome = String(e.outcome || "undecided");
    if (outcome === "booked" || outcome === "didnotbook") return;
    const to = validEmail(e.email);
    if (!to || clients[to] || used[to]) return;
    const sombre = SOMBRE.test(String(e.eventType || ""));
    const m = marks["enq:" + e.id] || {};
    const received = receivedDate(e);
    const last = lastActivity(e, seen, today);
    const viewing = hasViewingToCome(e, today);
    const checked = gmailCheckedOn(e, seen);
    const tokens = { firstName: firstName(e.name, e.email), name: String(e.name || "").trim() };
    let planned = false;

    // Every gap is counted to the day Gmail last looked, not to today: three
    // days since the enquiry with Gmail last checked yesterday is two verified
    // days. The contact log counts as activity, so a logged call restarts the
    // count. The window past the trigger is still measured to today, so a
    // check that comes very late does not wake up history.
    if (cfg.followup.on && !m.followup && received && !viewing) {
      const age = daysBetween(received, today);
      const verified = verifiedQuietDays(received, checked);
      // "No contact since it arrived": nothing later than the day it came in.
      if (age >= cfg.followup.days && age <= cfg.followup.days + WINDOW_DAYS.followup && last && last <= received) {
        if (verified >= cfg.followup.days) {
          out.push({ kind: "followup", mark: "enq:" + e.id, refId: e.id, to: [to], who: e.name || to, tokens: tokens });
          planned = true; used[to] = true;
        } else {
          waiting.push({ kind: "followup", who: e.name || to, verified: verified, needed: cfg.followup.days, checked: checked });
        }
      }
    }
    if (cfg.quiet.on && !m.quiet && !planned && !viewing && !sombre && last) {
      // Our own follow-up counts as the last touch: a check-in the day after
      // it would read as nagging.
      const touched = m.followup && String(m.followup).slice(0, 10) > last ? String(m.followup).slice(0, 10) : last;
      const idle = daysBetween(touched, today);
      const verified = verifiedQuietDays(touched, checked);
      if (idle >= cfg.quiet.days && idle <= cfg.quiet.days + WINDOW_DAYS.quiet) {
        if (verified >= cfg.quiet.days) {
          out.push({ kind: "quiet", mark: "enq:" + e.id, refId: e.id, to: [to], who: e.name || to, tokens: tokens, basedOn: touched });
          used[to] = true;
        } else {
          waiting.push({ kind: "quiet", who: e.name || to, verified: verified, needed: cfg.quiet.days, checked: checked });
        }
      }
    }
  });

  if (cfg.thanks.on) {
    (o.events || []).forEach(function (ev) {
      if (!ev || ev.id == null || String(ev.status || "") !== "Confirmed") return;
      if (!isIso(ev.date) || SOMBRE.test(String(ev.eventType || ""))) return;
      const end = isIso(ev.endDate) && ev.endDate > ev.date ? ev.endDate : ev.date;
      const age = daysBetween(end, today);
      if (age < cfg.thanks.days || age > cfg.thanks.days + WINDOW_DAYS.thanks) return;
      // Keyed by id AND date: ids are reused after a delete, and a new event
      // on an old id must not inherit "already thanked".
      const mk = "ev:" + ev.id + ":" + ev.date;
      const m = marks[mk] || {};
      if (m.thanks) return;
      const to = [validEmail(ev.email), validEmail(ev.email2)].filter(Boolean)
        .filter(function (x, i, a) { return a.indexOf(x) === i && !used[x]; });
      if (!to.length) return;
      to.forEach(function (x) { used[x] = true; });
      out.push({ kind: "thanks", mark: mk, refId: ev.id, to: to, who: ev.couple || to[0],
                 tokens: { firstName: coupleFirstNames(ev), name: String(ev.couple || "").trim(), eventDate: longDate(ev.date),
                           reviewLink: cfg.thanks.reviewUrl } });
    });
  }
  return { cfg: cfg, due: out, waiting: waiting };
}

// The quiet-enquiry flag the app shows: a check-in went, and nothing has
// happened in the M days since. Mirrors enquiryGoneQuiet in App.jsx.
function goneQuiet(e, marks, emailSeen, settings, today) {
  const cfg = mergeSettings(settings);
  const m = (marks || {})["enq:" + (e && e.id)] || {};
  if (!m.quiet) return false;
  const outcome = String(e.outcome || "undecided");
  if (outcome === "booked" || outcome === "didnotbook") return false;
  const sent = String(m.quiet).slice(0, 10);
  const last = lastActivity(e, emailSeen || {}, today);
  if (last && last > sent) return false;
  // As with the emails: silence counts only as far as Gmail has looked.
  return verifiedQuietDays(sent, gmailCheckedOn(e, emailSeen || {})) >= cfg.quiet.flagDays;
}

function renderEmail(item, cfg) {
  const t = cfg[item.kind];
  const subject = fill(t.subject, item.tokens);
  let body = fill(t.body, item.tokens);
  const opts = {};
  if (item.kind === "thanks" && cfg.thanks.reviewUrl) {
    opts.buttonUrl = cfg.thanks.reviewUrl;
    opts.buttonLabel = cfg.thanks.button;
    if (body.indexOf(cfg.thanks.reviewUrl) === -1) body += "\n\n" + cfg.thanks.reviewUrl;
  }
  return { subject: subject, text: body, html: buildEmailHtml(body, opts) };
}

// ─── SHARED EMAIL SHELL (verbatim from _email-shell.js) ──────────────────────
const BRAND = {
  logo:    SITE_ORIGIN + "/email-logo.png",
  site:    "https://www.hawthbushfarm.co.uk",
  bg:      "#f9f6f1",
  panel:   "#ffffff",
  text:    "#2d2a25",
  muted:   "#7a7060",
  border:  "#e8e2d9",
  accent:  "#b8a88a"
};
function escapeHtml(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function bodyToHtml(bodyText) {
  var paras = String(bodyText || "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  return paras.map(function (p) {
    var safe = escapeHtml(p.trim()).replace(/\n/g, "<br>");
    safe = safe.replace(/(https?:\/\/[^\s<]+)/g, function (url) {
      return '<a href="' + url + '" style="color:#2d2a25;text-decoration:underline">' + url + '</a>';
    });
    return '<p style="margin:0 0 15px;font-size:15px;line-height:1.65;color:' + BRAND.text + '">' + safe + '</p>';
  }).join("");
}
function buildEmailHtml(bodyText, opts) {
  var o = opts || {};
  var inner = bodyToHtml(bodyText);
  if (o.buttonUrl) {
    inner += '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 6px">' +
      '<tr><td align="center" bgcolor="' + BRAND.text + '" style="border-radius:8px">' +
      '<a href="' + escapeHtml(o.buttonUrl) + '" style="display:inline-block;padding:13px 30px;font-family:Helvetica,Arial,sans-serif;' +
      'font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px">' +
      escapeHtml(o.buttonLabel || "Open") + '</a></td></tr></table>';
  }
  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Hawthbush Farm</title></head>' +
    '<body style="margin:0;padding:0;background:' + BRAND.bg + ';">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + BRAND.bg + ';padding:26px 12px">' +
    '<tr><td align="center">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%">' +
    '<tr><td align="center" style="padding:0 0 20px">' +
    '<a href="' + BRAND.site + '"><img src="' + BRAND.logo + '" alt="Hawthbush Farm" width="110" ' +
    'style="display:block;border:0;width:110px;height:auto"></a>' +
    '</td></tr>' +
    '<tr><td style="background:' + BRAND.panel + ';border:1px solid ' + BRAND.border + ';border-radius:14px;padding:30px 34px;' +
    'font-family:Helvetica,Arial,sans-serif">' + inner + '</td></tr>' +
    '<tr><td align="center" style="padding:20px 16px 0;font-family:Helvetica,Arial,sans-serif">' +
    '<p style="margin:0 0 4px;font-size:12px;line-height:1.6;color:' + BRAND.muted + '">' +
    'Hawthbush Farm, Gun Hill, Heathfield, East Sussex &middot; ' +
    '<a href="mailto:' + FROM_EMAIL + '" style="color:' + BRAND.muted + '">' + FROM_EMAIL + '</a></p>' +
    '<p style="margin:0;font-size:12px;color:' + BRAND.muted + '">' +
    '<a href="' + BRAND.site + '" style="color:' + BRAND.muted + '">hawthbushfarm.co.uk</a></p>' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

// ─── I/O ─────────────────────────────────────────────────────────────────────
async function sbGet(key) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data?key=eq." + key + "&select=value", {
    headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY }
  });
  if (!res.ok) throw new Error("reading " + key + ": " + res.status + " " + (await res.text()).slice(0, 200));
  const rows = await res.json();
  return rows && rows[0] ? rows[0].value : null;
}
async function sbSet(key, value) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data", {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key: key, value: value, updated_at: new Date().toISOString() })
  });
  if (!res.ok) throw new Error("saving " + key + ": " + res.status + " " + (await res.text()).slice(0, 200));
}
// The sent record. Re-read, change, write, every time: it is small, and only
// this function writes it.
async function updateMarks(change) {
  const cur = (await sbGet(MARKS_KEY)) || {};
  const marks = cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {};
  change(marks);
  await sbSet(MARKS_KEY, marks);
}
// One read and one write of the email log for the whole run — it is large,
// and a run must finish well inside the function's time limit.
async function logEmails(entries) {
  if (!entries.length) return;
  try {
    const log = (await sbGet(EMAIL_LOG_KEY)) || [];
    entries.forEach(function (x) {
      log.push({
        id: "el" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
        sentAt: x.at, subject: x.subject, to: x.to, template: "auto_" + x.kind, bookingId: x.refId,
        body: String(x.text || "").slice(0, 8000)
      });
    });
    await sbSet(EMAIL_LOG_KEY, log.slice(-500));
  } catch (e) { console.error("email log write failed:", e.message); }
}
async function resolveAdmin(event) {
  const auth = event.headers["authorization"] || event.headers["Authorization"] || "";
  const jwt = auth.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return null;
  const res = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + jwt } });
  if (!res.ok) return null;
  const user = await res.json();
  if (!user || !user.id) return null;
  const pr = await fetch(SUPABASE_URL + "/rest/v1/profiles?id=eq." + user.id + "&select=role,active",
    { headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY } });
  if (!pr.ok) return null;
  const p = (await pr.json())[0];
  return p && p.active !== false && p.role === "admin" ? user.id : null;
}

function reply(code, body) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ build: FN_BUILD }, body)) };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return reply(405, { error: "POST only" });
  if (!SERVICE_KEY) return reply(500, { error: "SUPABASE_SERVICE_KEY is not set" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "bad JSON" }); }

  const token = (event.headers && (event.headers["x-admin-token"] || event.headers["X-Admin-Token"])) || "";
  const byClock = !!ADMIN_TOKEN && token === ADMIN_TOKEN;
  if (!byClock) {
    // A signed-in admin may look, never send: the sends belong to the clock.
    if (!body.dryRun) return reply(403, { error: "Only the scheduled run sends." });
    if (!(await resolveAdmin(event))) return reply(403, { error: "Admins only." });
  }

  let settings, enquiries, events, emailSeen, marks;
  try {
    [settings, enquiries, events, emailSeen, marks] = await Promise.all(
      [SETTINGS_KEY, ENQUIRIES_KEY, EVENTS_KEY, EMAIL_SEEN_KEY, MARKS_KEY].map(sbGet));
  } catch (e) {
    // A failed read must never look like "nobody to email" — or worse, like
    // "everybody to email". Stop.
    return reply(500, { error: e.message });
  }
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const plan = planAutomations({ settings: settings, enquiries: Array.isArray(enquiries) ? enquiries : [],
    events: Array.isArray(events) ? events : [], emailSeen: emailSeen || {}, marks: marks || {}, today: today });

  if (body.dryRun) {
    return reply(200, { ok: true, today: today, dryRun: true,
      due: plan.due.map(function (d) { const r = renderEmail(d, plan.cfg); return { kind: d.kind, to: d.to, who: d.who, subject: r.subject }; }),
      waiting: plan.waiting });
  }
  if (!plan.due.length) return reply(200, { ok: true, today: today, sent: 0 });
  if (!RESEND_KEY) return reply(500, { error: "RESEND_API_KEY is not set", due: plan.due.length });

  // Marked BEFORE sending, in one write. If the run is cut off part way, the
  // worst outcome is that somebody marked is not emailed — never that
  // somebody is emailed twice. A send that fails is unmarked at the end so it
  // is tried again tomorrow.
  const batch = plan.due.slice(0, MAX_SENDS_PER_RUN);
  const startedAt = new Date().toISOString();
  try {
    await updateMarks(function (marks) {
      batch.forEach(function (d) {
        const entry = Object.assign({}, marks[d.mark] || {});
        entry[d.kind] = startedAt;
        if (d.basedOn) entry[d.kind + "_basedOn"] = d.basedOn;
        marks[d.mark] = entry;
      });
    });
  } catch (e) {
    return reply(500, { error: "Could not record what is about to be sent, so nothing was sent: " + e.message });
  }

  const sent = [], failed = [], logged = [];
  for (const d of batch) {
    const r = renderEmail(d, plan.cfg);
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM_HEADER, to: d.to, reply_to: FROM_EMAIL, subject: r.subject, html: r.html, text: r.text })
      });
      if (!res.ok) throw new Error((await res.text()).slice(0, 300));
      sent.push({ kind: d.kind, ref: d.refId });
      logged.push({ at: new Date().toISOString(), subject: r.subject, to: d.to.join(", "), kind: d.kind, refId: d.refId, text: r.text });
    } catch (e) {
      failed.push({ kind: d.kind, ref: d.refId, mark: d.mark, error: String(e.message || e) });
    }
  }
  if (failed.length) {
    try {
      await updateMarks(function (marks) {
        failed.forEach(function (f) {
          const entry = Object.assign({}, marks[f.mark] || {});
          delete entry[f.kind]; delete entry[f.kind + "_basedOn"];
          if (Object.keys(entry).length) marks[f.mark] = entry; else delete marks[f.mark];
        });
      });
    } catch (e) { console.error("could not unmark failed sends (they will not be retried):", e.message); }
  }
  await logEmails(logged);
  console.log("[automations] " + today + " sent " + sent.length + ", failed " + failed.length +
              (plan.due.length > MAX_SENDS_PER_RUN ? ", " + (plan.due.length - MAX_SENDS_PER_RUN) + " held to tomorrow" : ""));
  return reply(failed.length ? 207 : 200, { ok: !failed.length, today: today, sent: sent, failed: failed,
    held: Math.max(0, plan.due.length - MAX_SENDS_PER_RUN) });
};

exports._test = { planAutomations, goneQuiet, gmailCheckedOn, verifiedQuietDays, mergeSettings, renderEmail, receivedDate, lastActivity, firstName, coupleFirstNames, DEFAULTS };
