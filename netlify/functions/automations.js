// netlify/functions/automations.js
//
// The three enquiry follow-ups, each OFF until switched on in Settings →
// Email templates → Follow-ups (app_data hbf_automations_v1):
//
//   followup  First enquiry follow-up. Any enquiry (including a brochure
//             request) N or more days old that has had no contact since it
//             arrived — however old (28 Oct, Toby: catch everyone not yet
//             emailed in one go, then trickle on). The per-run cap below
//             spreads the first batch over a few mornings.
//   second    Second enquiry follow-up. Only after the first: N days after
//             the first went (or after their last activity, if later).
//   third     Third enquiry follow-up. Only after the second: N days after
//             the second went (or after their last activity, if later).
//
// The second and third can each "mark Freezing": when ticked, an enquiry with
// no activity for X days after the last of them that went is set to
// temperature "freezing" (Toby's choice — it used to be only flagged). That is
// the ONE write this function makes to the shared enquiries array: just the
// temperature (and autoFrozenAt / autoFrozenAfter) of those enquiries, on a
// fresh read, written only if nobody has saved the array since that read
// (app_data.updated_at), re-planned on a clash. A Freezing enquiry is never
// emailed. Toby can warm one up again by hand; it is not frozen twice.
//
// Each email goes to a person once, ever. What was sent (and frozen) is
// recorded in its own key, hbf_automation_sent_v1 ({ "enq:<id>": { followup,
// second, third, frozen } }), which nothing else writes. Every send is logged
// to hbf_email_log_v1 so it shows in Recent Automated Emails.
//
// "Activity" is what the app already counts as last contact: the contact log
// (every note logged there is dated), a viewing that has happened, email
// exchanged with the address, and the enquiry arriving.
//
// Email is checked HERE, each run, in the farm's own Gmail
// (hawthbushfarm@gmail.com — where enquiries arrive), with the read-only
// access connected once for the Airbnb emails (airbnb_mail_state, sealed with
// a key from HBF_ADMIN_TOKEN): for every enquiry the run might act on, the
// newest message from or to the address. That result is merged over the
// app's own cache (hbf_enquiry_email_seen_v1, refreshed when the enquiries
// list is opened with Gmail connected), which is the fallback if the farm
// Gmail cannot be reached. Silence is only counted as far as Gmail has
// confirmed it: every gap runs from the last activity to the day Gmail last
// looked at that address, never beyond. An address Gmail has never been
// asked about is never emailed.
//
// The first follow-up has no upper age limit, deliberately: switching it on
// sends it to every open enquiry not yet contacted. The second and third only
// ever follow our own previous email, so they cannot wake up history.
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
const crypto = require("crypto");

// Constant-time compare for the office token. A plain === leaks, through its
// timing, how much of a guess was right. Unequal lengths (or no token set)
// never match; timingSafeEqual itself throws on unequal lengths.
function tokenMatches(given, expected) {
  if (!expected || typeof given !== "string" || !given) return false;
  var a = Buffer.from(given, "utf8"), b = Buffer.from(String(expected), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const SETTINGS_KEY   = "hbf_automations_v1";
const MARKS_KEY      = "hbf_automation_sent_v1";
const ENQUIRIES_KEY  = "hbf_enquiries_v1";
const EVENTS_KEY     = "hawthbush_bookings_v6";
const EMAIL_SEEN_KEY = "hbf_enquiry_email_seen_v1";
const EMAIL_LOG_KEY  = "hbf_email_log_v1";

const FROM_EMAIL  = "hello@hawthbushfarm.co.uk";
const FROM_HEADER = "Hawthbush Farm <" + FROM_EMAIL + ">";
const SITE_ORIGIN = "https://hawthbushfarm.netlify.app";
const FN_BUILD    = "2026-10-28b";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "631658172216-bh6vocim7t41lf8nhr21bdpb2ss2n1mm.apps.googleusercontent.com";
// At most this many addresses looked up in Gmail a run (two reads each), and
// only while the run is young: Netlify stops a function at 10 seconds, so the
// Gmail checks stop at GMAIL_BUDGET_MS and the sending at SEND_BUDGET_MS from
// the start. Whatever is not reached waits for the next run (09:20, or
// tomorrow) — unmarked, so it is never lost and never sent twice.
const MAX_GMAIL_CHECKS = 40;
const GMAIL_BUDGET_MS = 4000;
const SEND_BUDGET_MS = 7500;

// A bad day (a data import, a clock problem) must not become a mass mailing.
const MAX_SENDS_PER_RUN = 15;

// Mirrors DEFAULT_AUTOMATIONS in App.jsx. A field left blank in Settings falls
// back to this wording, field by field, so an empty email is never sent.
const DEFAULTS = {
  followup: { on: false, days: 3,
    subject: "Following up on your enquiry — Hawthbush Farm",
    body: "Hello {firstName},\n\nThank you again for getting in touch about Hawthbush Farm. I wanted to check that everything reached you, and to see whether you have any questions at all.\n\nIf you would like to come and see the farm, just reply with a few dates that suit you and we will arrange a viewing.\n\nAnd if you would rather we did not follow up, just say so — we will not mind in the least.\n\nWarm regards,\nHawthbush Farm" },
  second: { on: false, days: 21, freezeOn: false, freezeDays: 7,
    subject: "Still thinking about Hawthbush Farm?",
    body: "Hello {firstName},\n\nWe have not heard from you for a little while, so I wanted to check in. Dates do go, so if you are still thinking about Hawthbush Farm it is worth letting us know which ones you have in mind.\n\nAnd if you have found your venue elsewhere, congratulations — a one-line reply saying so would help us a great deal, and we will not email again.\n\nWarm regards,\nHawthbush Farm" },
  third: { on: false, days: 14, freezeOn: false, freezeDays: 7,
    subject: "A last note from Hawthbush Farm",
    body: "Hello {firstName},\n\nI will not keep emailing, but I did not want your enquiry to slip through the cracks. If you are still looking, we would love to help — just reply with the dates you have in mind, or a good time to call.\n\nIf your plans have moved on, we wish you all the very best.\n\nWarm regards,\nHawthbush Farm" }
};
// The three emails, in order. Each is sent once; the next only after it.
const STEPS = ["followup", "second", "third"];

// Occasions where "found your venue elsewhere? congratulations" would be
// badly wrong. The second and third never go to these; the neutral first
// follow-up still may.
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
    if (k === "second" || k === "third") {
      out[k].freezeOn = v.freezeOn === true;
      out[k].freezeDays = num(v.freezeDays, d.freezeDays);
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
function fill(str, tokens) {
  return String(str || "").replace(/\{(\w+)\}/g, function (m, k) { return tokens[k] != null ? String(tokens[k]) : ""; });
}
// Everything that is due today, without sending anything.
function planAutomations(o) {
  const cfg = mergeSettings(o.settings);
  const today = o.today;
  const marks = o.marks || {};
  const seen = o.emailSeen || {};
  const out = [];
  // Enquiries to mark Freezing (see the second and third follow-ups).
  const freeze = [];
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
    if (String(e.temperature || "") === "freezing") return;     // given up on: never emailed
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
    // count.
    if (cfg.followup.on && !m.followup && received && !viewing) {
      const age = daysBetween(received, today);
      const verified = verifiedQuietDays(received, checked);
      // "No contact since it arrived": nothing later than the day it came in.
      if (age >= cfg.followup.days && last && last <= received) {
        if (verified >= cfg.followup.days) {
          out.push({ kind: "followup", mark: "enq:" + e.id, refId: e.id, to: [to], who: e.name || to, tokens: tokens });
          planned = true; used[to] = true;
        } else {
          waiting.push({ kind: "followup", who: e.name || to, addr: to, verified: verified, needed: cfg.followup.days, checked: checked });
        }
      }
    }
    // Second and third: a chain from the first. Each only after the one
    // before it, N days after it went — or after their last activity if they
    // have been in touch since, so a reply is never answered with "we have
    // not heard from you".
    [["second", "followup"], ["third", "second"]].forEach(function (pair) {
      const step = pair[0], prev = pair[1];
      const c = cfg[step];
      if (!c.on || m[step] || planned || viewing || sombre || !last) return;
      if (!m[prev]) return;                                        // only ever after the one before it
      const prevAt = String(m[prev]).slice(0, 10);
      const touched = prevAt > last ? prevAt : last;
      const idle = daysBetween(touched, today);
      const verified = verifiedQuietDays(touched, checked);
      if (idle >= c.days) {
        if (verified >= c.days) {
          out.push({ kind: step, mark: "enq:" + e.id, refId: e.id, to: [to], who: e.name || to, tokens: tokens, basedOn: touched });
          planned = true; used[to] = true;
        } else {
          waiting.push({ kind: step, who: e.name || to, addr: to, verified: verified, needed: c.days, checked: checked });
        }
      }
    });

    // Mark Freezing: X quiet days (as Gmail confirms them) after the last of
    // the second / third that went, when that email's box is ticked. Not
    // twice: if Toby warms it up again, it stays warm.
    if (!planned && !m.frozen) {
      const lastStep = m.third ? "third" : m.second ? "second" : null;
      const rule = lastStep === "third" && cfg.third.freezeOn ? cfg.third
                 : lastStep && cfg.second.freezeOn ? cfg.second : null;
      if (rule) {
        const sentOn = String(m[lastStep]).slice(0, 10);
        const quietDays = verifiedQuietDays(sentOn, checked);
        if (!(last && last > sentOn)) {
          if (quietDays >= rule.freezeDays) freeze.push({ refId: e.id, mark: "enq:" + e.id, who: e.name || to, addr: to, after: lastStep });
          else if (daysBetween(sentOn, today) >= rule.freezeDays) {
            waiting.push({ kind: "freeze", who: e.name || to, addr: to, verified: quietDays, needed: rule.freezeDays, checked: checked });
          }
        }
      }
    }
  });

  return { cfg: cfg, due: out, waiting: waiting, freeze: freeze };
}

function renderEmail(item, cfg) {
  const t = cfg[item.kind];
  const subject = fill(t.subject, item.tokens);
  const body = fill(t.body, item.tokens);
  return { subject: subject, text: body, html: buildEmailHtml(body, {}) };
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
// Web addresses in an email become links, with or without the http(s)://
// ("hawthbushfarm.co.uk/book-viewing", "www.example.com" — 28 Oct). An email
// address is left alone; a full stop or bracket after an address stays text.
var LINK_RE = /(^|[^@\w.\/-])((?:https?:\/\/|www\.)[^\s<]+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:co\.uk|org\.uk|com|org|net|uk|events)(?:\/[^\s<]*)?)/gi;
function linkifyEscaped(safe, short) {
  return String(safe).replace(LINK_RE, function (m, pre, url) {
    var tail = (/[.,;:!?)]+$/.exec(url) || [""])[0];
    url = url.slice(0, url.length - tail.length);
    if (!url) return m;
    var href = /^https?:\/\//i.test(url) ? url : "https://" + url;
    // Show something readable rather than a 200-character query string.
    var label = short && url.length > 60 ? url.replace(/^https?:\/\//i, "").split("/")[0] + "/…" : url;
    return pre + '<a href="' + href + '" style="color:#2d2a25;text-decoration:underline">' + label + '</a>' + tail;
  });
}
function bodyToHtml(bodyText) {
  var paras = String(bodyText || "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  return paras.map(function (p) {
    var safe = escapeHtml(p.trim()).replace(/\n/g, "<br>");
    safe = linkifyEscaped(safe, false);
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
// ─── The farm's Gmail, checked by the run itself ─────────────────────────────
// The refresh token the Airbnb-mail connection stored (same sealing as
// airbnb-mail.js — copied, not shared, like every helper in this folder).
function openSealedToken(sealed) {
  const s = String(sealed || "");
  if (!s.startsWith("v1:")) throw new Error("stored Gmail token is in an unknown form");
  if (!ADMIN_TOKEN) throw new Error("HBF_ADMIN_TOKEN is not set");
  const key = crypto.createHash("sha256").update(ADMIN_TOKEN + "|airbnb-gmail-refresh-token").digest();
  const buf = Buffer.from(s.slice(3), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}
async function farmGmailAccess() {
  const res = await fetch(SUPABASE_URL + "/rest/v1/airbnb_mail_state?id=eq.1&select=token_enc,account_email", {
    headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY }
  });
  if (!res.ok) throw new Error("reading the Gmail connection: " + res.status);
  const row = (await res.json())[0];
  if (!row || !row.token_enc) throw new Error("the farm Gmail is not connected (Lettings → Settings → Airbnb Sync)");
  const t = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      grant_type: "refresh_token", refresh_token: openSealedToken(row.token_enc) }).toString()
  });
  const data = await t.json().catch(function () { return {}; });
  if (!t.ok || !data.access_token) throw new Error("Google refused the stored access (" + (data.error || t.status) + ")");
  return { access: data.access_token, account: row.account_email || "" };
}
// The newest message from or to an address, as a London date (null: none).
async function lastEmailWith(access, addr) {
  const get = async function (path) {
    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, { headers: { Authorization: "Bearer " + access } });
    if (!r.ok) throw new Error("Gmail " + r.status);
    return r.json();
  };
  const q = "from:" + addr + " OR to:" + addr + " OR cc:" + addr;
  const list = await get("messages?maxResults=1&q=" + encodeURIComponent(q));
  const id = list && list.messages && list.messages[0] && list.messages[0].id;
  if (!id) return null;
  const msg = await get("messages/" + id + "?format=minimal");
  const ms = Number(msg && msg.internalDate);
  return ms ? new Date(ms).toLocaleDateString("en-CA", { timeZone: "Europe/London" }) : null;
}
// Check the addresses the run might act on; returns a cache in the app's
// shape ({ addr: { date, at } }) for the ones Gmail answered for.
async function checkFarmGmail(addrs, deadline) {
  const g = await farmGmailAccess();
  const out = {}, nowIso = new Date().toISOString();
  let failed = 0;
  const list = addrs.slice(0, MAX_GMAIL_CHECKS);
  for (let i = 0; i < list.length; i += 5) {
    if (deadline && Date.now() > deadline) break;
    await Promise.all(list.slice(i, i + 5).map(async function (a) {
      try { out[a] = { date: await lastEmailWith(g.access, a), at: nowIso }; }
      catch (e) { failed++; }
    }));
  }
  return { seen: out, account: g.account, checked: Object.keys(out).length, failed: failed,
    skipped: Math.max(0, addrs.length - Object.keys(out).length - failed) };
}
// The run's view of email: the farm Gmail's answer where it has one (newest
// date of the two, checked now), the app's cache otherwise.
function mergeSeen(cache, fresh) {
  const out = Object.assign({}, cache || {});
  Object.keys(fresh || {}).forEach(function (a) {
    const old = out[a] || {}, f = fresh[a];
    const date = [old.date, f.date].filter(isIso).sort().pop() || null;
    out[a] = { date: date, at: f.at };
  });
  return out;
}

// Mark enquiries Freezing: only their temperature, on a fresh read, written
// only if nobody has saved the enquiries since that read; on a clash, read
// and apply again (three tries). Anything no longer open is left alone.
// Returns the ids actually changed.
async function freezeEnquiries(items, today) {
  if (!items.length) return [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(SUPABASE_URL + "/rest/v1/app_data?key=eq." + ENQUIRIES_KEY + "&select=value,updated_at", {
      headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY }
    });
    if (!res.ok) throw new Error("reading enquiries: " + res.status);
    const rows = await res.json();
    if (!rows || !rows[0] || !Array.isArray(rows[0].value)) throw new Error("enquiries are not a list");
    const stamp = rows[0].updated_at;
    const want = {};
    items.forEach(function (x) { want[String(x.refId)] = x.after; });
    const changed = [];
    const list = rows[0].value.map(function (e) {
      if (!e || !(String(e.id) in want)) return e;
      const outcome = String(e.outcome || "undecided");
      if (outcome === "booked" || outcome === "didnotbook" || String(e.temperature || "") === "freezing") return e;
      changed.push(e.id);
      return Object.assign({}, e, { temperature: "freezing", autoFrozenAt: today, autoFrozenAfter: want[String(e.id)] });
    });
    if (!changed.length) return [];
    if (list.length !== rows[0].value.length) throw new Error("enquiry count changed while freezing");
    const cond = stamp ? "&updated_at=eq." + encodeURIComponent(stamp) : "&updated_at=is.null";
    const w = await fetch(SUPABASE_URL + "/rest/v1/app_data?key=eq." + ENQUIRIES_KEY + cond, {
      method: "PATCH",
      headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ value: list, updated_at: new Date().toISOString() })
    });
    if (!w.ok) throw new Error("saving enquiries: " + w.status + " " + (await w.text()).slice(0, 200));
    const back = await w.json();
    if (Array.isArray(back) && back.length === 1) return changed;
    // Someone saved in between: go round again on their copy.
  }
  throw new Error("the enquiries kept changing; nothing was marked Freezing this run");
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
  const t0 = Date.now();
  if (event.httpMethod !== "POST") return reply(405, { error: "POST only" });
  if (!SERVICE_KEY) return reply(500, { error: "SUPABASE_SERVICE_KEY is not set" });
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "bad JSON" }); }

  const token = (event.headers && (event.headers["x-admin-token"] || event.headers["X-Admin-Token"])) || "";
  const byClock = tokenMatches(String(token), ADMIN_TOKEN);
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
  const input = { settings: settings, enquiries: Array.isArray(enquiries) ? enquiries : [],
    events: Array.isArray(events) ? events : [], emailSeen: emailSeen || {}, marks: marks || {}, today: today };
  // A first plan on the app's cache says which addresses matter today; the
  // farm Gmail is asked about just those, and the plan is made again on what
  // it says.
  const first = planAutomations(input);
  const addrs = [];
  first.due.forEach(function (d) { d.to.forEach(function (a) { if (addrs.indexOf(a) === -1) addrs.push(a); }); });
  first.waiting.concat(first.freeze).forEach(function (w) { if (w.addr && addrs.indexOf(w.addr) === -1) addrs.push(w.addr); });
  let gmail = { source: "app", checked: 0 };
  if (addrs.length) {
    try {
      const g = await checkFarmGmail(addrs, t0 + GMAIL_BUDGET_MS);
      input.emailSeen = mergeSeen(emailSeen || {}, g.seen);
      gmail = { source: "farm", account: g.account, checked: g.checked, failed: g.failed, skipped: g.skipped };
    } catch (e) {
      gmail = { source: "app", error: String(e.message || e) };
      console.error("[automations] farm Gmail not used:", gmail.error);
    }
  }
  const plan = addrs.length ? planAutomations(input) : first;

  if (body.dryRun) {
    return reply(200, { ok: true, today: today, dryRun: true,
      due: plan.due.map(function (d) { const r = renderEmail(d, plan.cfg); return { kind: d.kind, to: d.to, who: d.who, subject: r.subject }; }),
      waiting: plan.waiting,
      freeze: plan.freeze.map(function (f) { return { who: f.who, after: f.after }; }), gmail: gmail });
  }

  // Freezing first, on its own: it sends nothing, and a failure here must not
  // stop the emails (or the other way round).
  let frozen = [], freezeError = null;
  if (plan.freeze.length) {
    try {
      frozen = await freezeEnquiries(plan.freeze, today);
      if (frozen.length) {
        const ids = {}; frozen.forEach(function (id) { ids[String(id)] = true; });
        await updateMarks(function (marks) {
          plan.freeze.forEach(function (f) {
            if (!ids[String(f.refId)]) return;
            marks[f.mark] = Object.assign({}, marks[f.mark] || {}, { frozen: new Date().toISOString(), frozen_after: f.after });
          });
        });
      }
    } catch (e) { freezeError = String(e.message || e); console.error("[automations] freezing:", freezeError); }
  }

  if (!plan.due.length) return reply(freezeError ? 207 : 200, { ok: !freezeError, today: today, sent: 0, frozen: frozen.length, freezeError: freezeError, gmail: gmail });
  if (!RESEND_KEY) return reply(500, { error: "RESEND_API_KEY is not set", due: plan.due.length, frozen: frozen.length });

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
  let heldForTime = 0;
  for (const d of batch) {
    // Out of time: give it back (unmarked below), for the next run.
    if (Date.now() - t0 > SEND_BUDGET_MS) { failed.push({ kind: d.kind, ref: d.refId, mark: d.mark, error: "out of time — next run", held: true }); heldForTime++; continue; }
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
  return reply(failed.length || freezeError ? 207 : 200, { ok: !failed.length && !freezeError, today: today, sent: sent, failed: failed,
    held: Math.max(0, plan.due.length - MAX_SENDS_PER_RUN) + heldForTime, frozen: frozen.length, freezeError: freezeError, gmail: gmail });
};

exports._test = { planAutomations, freezeEnquiries, mergeSeen, openSealedToken, gmailCheckedOn, verifiedQuietDays, mergeSettings, renderEmail, receivedDate, lastActivity, firstName, DEFAULTS, STEPS };
