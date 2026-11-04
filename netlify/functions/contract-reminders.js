// netlify/functions/contract-reminders.js
//
// Daily (contract-reminders-cron.js). Two jobs:
//
//   1. Any contract signed by everyone that has no PDF yet — a signing request
//      that was cut short — is sealed now (made, filed, emailed).
//   2. The booking form reminder: OFF until switched on in Settings → Email
//      templates → Client portal → "Booking form reminder", which also sets how
//      often (every N days, counted from the contract being sent or the last
//      reminder). Every client who has not signed gets the same email each
//      time. It links to the planner's sign-in page, never a sign-in link: a
//      link is a credential, and this one would sit in an inbox for days.
//
// Each reminder is marked (ct_service_mark_reminded) BEFORE it is sent and the
// mark refuses a contract another run has just reminded, so a doubled run
// never sends twice. A failed send is noted on the contract's activity.
//
//   POST, x-admin-token: HBF_ADMIN_TOKEN       runs it (contract-reminders-cron.js)
//   POST, Authorization: Bearer <admin JWT>    { dryRun: true } — who would get one
//
// Required env vars: SUPABASE_SERVICE_KEY, RESEND_API_KEY, HBF_ADMIN_TOKEN

const crypto = require("crypto");
const L = require("./contract-lib/common.js");

const ADMIN_TOKEN = process.env.HBF_ADMIN_TOKEN;
const MAX_SENDS = 30;
const TIME_BUDGET_MS = 7000;

function tokenOk(event) {
  const got = String((event.headers || {})["x-admin-token"] || "");
  if (!ADMIN_TOKEN || !got || got.length !== ADMIN_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(ADMIN_TOKEN));
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return L.bad("Method not allowed", 405);
  if (!L.SERVICE_KEY) return L.bad("Not configured — SUPABASE_SERVICE_KEY is missing", 500);
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { body = {}; }
  const started = Date.now();
  const byToken = tokenOk(event);
  let dry = false;
  if (!byToken) {
    const me = await L.adminFrom(event);
    if (!me || body.dryRun !== true) return L.bad("Not allowed", 403);
    dry = true;
  }

  const t = await L.contractTemplate("contract_reminder");
  let due = [];
  try { due = await L.sbRpc("ct_service_due_reminders", { p_every_days: t.everyDays }); }
  catch (e) { return L.bad("Could not read the contracts: " + e.message, 502); }
  if (dry) return L.ok({ on: t.on, everyDays: t.everyDays, due: due });

  const out = { sealed: [], reminded: [], failed: [], skipped: 0, on: t.on };

  // 1. Finish sealing anything signed but not yet made into a PDF.
  try {
    const unsealed = await L.sbRpc("ct_service_unsealed", {});
    for (const id of unsealed || []) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      try { const r = await L.sealContract(id); if (r.sealed) out.sealed.push(id); }
      catch (e) { out.failed.push({ id: id, error: "seal: " + e.message }); }
    }
  } catch (e) { console.warn("unsealed check failed:", e.message); }

  // 2. Reminders, only while switched on.
  if (t.on) {
    let sends = 0;
    for (const c of due) {
      if (Date.now() - started > TIME_BUDGET_MS || sends >= MAX_SENDS) { out.skipped++; continue; }
      const mark = await L.sbRpc("ct_service_mark_reminded", { p_contract: c.id, p_last: c.last }).catch(function () { return null; });
      if (!mark || mark.ok !== true) { out.skipped++; continue; }
      const sentTo = [], failedTo = [];
      for (const s of c.unsigned || []) {
        const vals = { firstName: L.firstName(s.name), event: c.event_name || "your event", eventDate: L.ukLong(c.event_date), portalUrl: L.PORTAL_URL, others: "" };
        const subject = L.fill(t.subject, vals);
        const text = L.fill(t.body, vals);
        const r = await L.sendEmail(s.email, subject, text, { link: L.PORTAL_URL, button: t.button });
        sends++;
        if (r.ok) { sentTo.push(s.email); await L.logEmail(subject, s.email, "contract-reminder", c.event_id, text); }
        else failedTo.push(s.email + " (" + r.error + ")");
      }
      if (sentTo.length) await L.sbRpc("ct_service_note", { p_contract: c.id, p_what: "Reminder emailed: " + sentTo.join(", "), p_who: "system" }).catch(function () {});
      if (failedTo.length) await L.sbRpc("ct_service_note", { p_contract: c.id, p_what: "Reminder NOT sent: " + failedTo.join(", "), p_who: "system" }).catch(function () {});
      out.reminded.push({ id: c.id, to: sentTo });
      if (failedTo.length) out.failed.push({ id: c.id, error: failedTo.join("; ") });
    }
  }
  console.log("[contract-reminders] " + JSON.stringify(out));
  return L.ok(out);
};
