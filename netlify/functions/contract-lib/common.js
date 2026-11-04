// netlify/functions/contract-lib/common.js
//
// What the three contract functions share: talking to Supabase with the
// service key, checking who is calling, the branded email (with an
// attachment), the editable wording, and SEALING a signed contract — the PDF,
// filing it, and the emails that go with it.
//
// Required env vars: SUPABASE_SERVICE_KEY · RESEND_API_KEY

const { renderContractPdf } = require("./pdf.js");

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const SITE_ORIGIN  = "https://hawthbushfarm.netlify.app";
const PORTAL_URL   = (process.env.PORTAL_ORIGIN || SITE_ORIGIN).replace(/\/+$/, "") + "/portal";
const FROM_EMAIL   = "hello@hawthbushfarm.co.uk";
const FROM_HEADER  = "Hawthbush Farm <" + FROM_EMAIL + ">";
const OFFICE_EMAIL = process.env.CONTRACT_OFFICE_EMAIL || "hello@hawthbushfarm.co.uk";
const BUCKET       = "booking-files";
const EMAIL_LOG_KEY = "hbf_email_log_v1";
const TEMPLATES_KEY = "hbf_portal_email_templates_v1";

function ok(d)     { return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) }; }
function bad(m, c, extra) { return { statusCode: c || 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ error: m }, extra || {})) }; }

async function sbRest(path, opts) {
  const o = opts || {};
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    method: o.method || "GET",
    headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + (o.jwt || SERVICE_KEY),
               "Content-Type": "application/json", Prefer: o.prefer || "return=representation" },
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  const text = await res.text();
  if (!res.ok) { const e = new Error("supabase " + res.status + ": " + text.slice(0, 300)); e.status = res.status; throw e; }
  try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
}
// A database function with the service key — or, given a jwt, AS THAT USER,
// so auth.uid() and wp_my_event_id() are theirs.
async function sbRpc(fn, args, jwt) { return sbRest("rpc/" + fn, { method: "POST", body: args || {}, jwt: jwt }); }

function bearer(event) {
  const auth = event.headers["authorization"] || event.headers["Authorization"] || "";
  return auth.replace(/^Bearer\s+/i, "").trim();
}

// Who is signed in, checked with Supabase rather than believed from the browser.
async function userFrom(event) {
  const jwt = bearer(event);
  if (!jwt) return null;
  const res = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + jwt } });
  if (!res.ok) return null;
  const u = await res.json().catch(function () { return null; });
  if (!u || !u.id || !u.email) return null;
  return { id: u.id, email: String(u.email).toLowerCase(), jwt: jwt };
}
async function adminFrom(event) {
  const u = await userFrom(event);
  if (!u) return null;
  const rows = await sbRest("profiles?id=eq." + u.id + "&select=role,active,name,email");
  const p = rows && rows[0];
  if (!p || p.active === false || p.role !== "admin") return null;
  return Object.assign(u, { name: p.name || p.email || "staff" });
}

function clientIp(event) {
  const h = event.headers || {};
  return String(h["x-nf-client-connection-ip"] || (h["x-forwarded-for"] || "").split(",")[0] || h["client-ip"] || "").trim().slice(0, 64);
}

// ── Email ───────────────────────────────────────────────────────────────────
// The same shell as portal-auth.js / _email-shell.js.
const BRAND = { logo: SITE_ORIGIN + "/email-logo.png", site: "https://www.hawthbushfarm.co.uk",
  bg: "#f9f6f1", panel: "#ffffff", text: "#2d2a25", muted: "#7a7060", border: "#e8e2d9" };
function escapeHtml(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function buildEmailHtml(bodyText, buttonUrl, buttonLabel, code) {
  let inner = String(bodyText || "").split(/\n\s*\n/).map(function (p) {
    return '<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:' + BRAND.text + '">' +
      escapeHtml(p).replace(/\n/g, "<br>") + "</p>";
  }).join("");
  if (buttonUrl) {
    inner += '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 6px">' +
      '<tr><td align="center" bgcolor="' + BRAND.text + '" style="border-radius:8px">' +
      '<a href="' + buttonUrl + '" style="display:inline-block;padding:13px 30px;font-family:Helvetica,Arial,sans-serif;' +
      'font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px">' +
      escapeHtml(buttonLabel || "Open") + "</a></td></tr></table>";
  }
  if (code) {
    inner += '<p style="margin:18px 0 6px;font-size:13px;line-height:1.6;color:' + BRAND.muted + '">' +
      "Using the planner app on your phone? Type this code on its sign-in page instead:</p>" +
      '<p style="margin:0 0 4px;font-family:Menlo,Consolas,monospace;font-size:26px;letter-spacing:6px;font-weight:bold;color:' + BRAND.text + '">' +
      escapeHtml(code) + "</p>";
  }
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>Hawthbush Farm</title></head>" +
    '<body style="margin:0;padding:0;background:' + BRAND.bg + ';">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + BRAND.bg + ';padding:26px 12px"><tr><td align="center">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%">' +
    '<tr><td align="center" style="padding:0 0 20px"><a href="' + BRAND.site + '"><img src="' + BRAND.logo + '" alt="Hawthbush Farm" width="110" style="display:block;border:0;width:110px;height:auto"></a></td></tr>' +
    '<tr><td style="background:' + BRAND.panel + ";border:1px solid " + BRAND.border + ';border-radius:14px;padding:30px 34px;font-family:Helvetica,Arial,sans-serif">' + inner + "</td></tr>" +
    '<tr><td align="center" style="padding:20px 16px 0;font-family:Helvetica,Arial,sans-serif">' +
    '<p style="margin:0 0 4px;font-size:12px;line-height:1.6;color:' + BRAND.muted + '">Hawthbush Farm, Gun Hill, Heathfield, East Sussex &middot; ' +
    '<a href="mailto:' + FROM_EMAIL + '" style="color:' + BRAND.muted + '">' + FROM_EMAIL + "</a></p></td></tr></table></td></tr></table></body></html>";
}

// to: one address or several. attachments: [{ filename, content (base64) }].
async function sendEmail(to, subject, bodyText, opt) {
  const o = opt || {};
  if (!RESEND_KEY) return { ok: false, error: "RESEND_API_KEY not set" };
  const payload = { from: FROM_HEADER, to: Array.isArray(to) ? to : [to], subject: subject,
    html: buildEmailHtml(bodyText, o.link, o.button, o.code) };
  if (o.replyTo) payload.reply_to = o.replyTo;
  if (o.attachments && o.attachments.length) payload.attachments = o.attachments;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) return { ok: false, error: "Resend failed: " + (await res.text()).slice(0, 300) };
  return { ok: true };
}

// Recent Automated Emails. Re-reads first (a shared array). The sign-in link
// is never in the body passed here: it is a credential.
async function logEmail(subject, to, type, bookingId, bodyText) {
  try {
    const rows = await sbRest("app_data?key=eq." + EMAIL_LOG_KEY + "&select=value");
    const log = (rows && rows[0] && rows[0].value) || [];
    log.push({ id: "el" + Date.now() + "-" + Math.random().toString(36).slice(2, 6), sentAt: new Date().toISOString(),
      subject: subject, to: Array.isArray(to) ? to.join(", ") : to, template: type,
      bookingId: bookingId == null ? "" : String(bookingId), body: String(bodyText || "").slice(0, 8000) });
    await sbRest("app_data", { method: "POST", prefer: "resolution=merge-duplicates",
      body: { key: EMAIL_LOG_KEY, value: log.slice(-500), updated_at: new Date().toISOString() } });
  } catch (e) { console.error("logEmail failed:", e.message); }
}

// The standard wording of the contract emails. Mirrored in App.jsx
// (DEFAULT_PORTAL_EMAILS) and editable under Settings → Email templates →
// Client portal; a field left blank there falls back to this.
const CONTRACT_EMAILS = {
  contract_invite: { subject: "Your booking form from Hawthbush Farm is ready to sign", button: "Read and sign",
    body: "Hello {firstName},\n\nYour booking form for {event} on {eventDate} is ready for you to read and sign.\n\n" +
          "The button below signs you straight in — there is no password. Read it through, fill in the few boxes we need from you, " +
          "and sign at the bottom by typing your name. {others}\n\nIf anything on it doesn't look right, just reply to this email and we will put it right before you sign." },
  contract_reminder: { subject: "A reminder: your booking form is waiting to be signed", button: "Open your planner", on: false, everyDays: 7,
    body: "Hello {firstName},\n\nJust a reminder that your booking form for {event} on {eventDate} is still waiting for your signature.\n\n" +
          "Go to {portalUrl}, ask for a sign-in link, and you will find it under Booking form.\n\nIf you have a question about any of it, just reply to this email." },
  contract_signed: { subject: "Your signed booking form — Hawthbush Farm", button: "",
    body: "Hello {firstName},\n\nThank you — your booking form for {event} on {eventDate} has now been signed by everyone. " +
          "A copy is attached for your records, and you can open it at any time from your planner.\n\n" +
          "Your booking is confirmed once the deposit invoice has been paid.\n\nWe are looking forward to it." },
};
async function contractTemplate(id) {
  const std = CONTRACT_EMAILS[id];
  try {
    const rows = await sbRest("app_data?key=eq." + TEMPLATES_KEY + "&select=value");
    const list = (rows && rows[0] && rows[0].value) || [];
    const t = list.find(function (x) { return x && x.id === id; }) || {};
    return { subject: String(t.subject || "").trim() || std.subject, body: String(t.body || "").trim() || std.body,
             button: String(t.button || "").trim() || std.button,
             on: t.on === true, everyDays: Number(t.everyDays) > 0 ? Number(t.everyDays) : std.everyDays };
  } catch (e) {
    console.warn("contract email template " + id + " unreadable, using the standard wording: " + e.message);
    return Object.assign({}, std, { on: false });
  }
}
function firstName(name) { return String(name || "").trim().split(/\s+/)[0] || "there"; }
function ukLong(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return "your date";
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return Number(m[3]) + " " + months[Number(m[2]) - 1] + " " + m[1];
}
function fill(text, v) {
  return String(text).replace(/\{(firstName|event|eventDate|portalUrl|others)\}/g, function (m, k) { return v[k] == null ? "" : v[k]; })
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

// ── Sealing ─────────────────────────────────────────────────────────────────
// Make the PDF of a signed contract, store it, record it (first run wins), and
// email it to the clients and the office. Safe to call twice: a contract that
// already has its PDF does nothing; a run that loses the race sends nothing.
async function sealContract(contractId) {
  const c = await sbRpc("ct_service_contract", { p_contract: contractId });
  if (!c || c.ok === false) throw new Error("contract not found");
  if (c.status !== "signed") return { sealed: false, reason: "not_signed" };
  if (c.pdf_path) return { sealed: false, reason: "already", path: c.pdf_path };

  const pdf = await renderContractPdf(c);
  const ev = (c.body && c.body.event) || {};
  const safeName = String(ev.name || "event").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "event";
  const path = "bookings/" + c.event_id + "/" + Date.now() + "_booking-form-v" + c.version + "-signed-" + safeName + ".pdf";
  const up = await fetch(SUPABASE_URL + "/storage/v1/object/" + BUCKET + "/" + path, {
    method: "POST", headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/pdf", "x-upsert": "false" },
    body: pdf
  });
  if (!up.ok) throw new Error("could not store the signed copy: " + (await up.text()).slice(0, 200));
  const set = await sbRpc("ct_service_set_pdf", { p_contract: contractId, p_path: path });
  if (!set || set.ok !== true) {
    // Another run filed it first; this copy is a spare and nobody is emailed twice.
    await fetch(SUPABASE_URL + "/storage/v1/object/" + BUCKET, { method: "DELETE",
      headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: [path] }) }).catch(function () {});
    return { sealed: false, reason: "already" };
  }

  const filename = "Booking form - " + (ev.name || "Hawthbush Farm") + " (signed).pdf";
  const attachments = [{ filename: filename.replace(/[\\/:*?"<>|]+/g, "-"), content: pdf.toString("base64") }];
  const t = await contractTemplate("contract_signed");
  const emails = [];
  for (const s of c.signers || []) {
    const vals = { firstName: firstName(s.name), event: ev.name || "your event", eventDate: ukLong(ev.date), portalUrl: PORTAL_URL, others: "" };
    const subject = fill(t.subject, vals);
    const text = fill(t.body, vals);
    const r = await sendEmail(s.email, subject, text, { attachments: attachments });
    emails.push({ to: s.email, ok: r.ok, error: r.error });
    if (r.ok) await logEmail(subject, s.email, "contract-signed", c.event_id, text);
  }
  const officeText = "The booking form for " + (ev.name || "an event") + " (" + ukLong(ev.date) + ") has been signed by everyone.\n\n" +
    (c.signers || []).map(function (s) { return s.name + " — signed as “" + (s.signed_name || "") + "”"; }).join("\n") +
    "\n\nThe signed copy is attached. It is filed against the event the next time the app is opened, and the answers are " +
    "waiting on the event's Contract tab to be applied.";
  const ro = await sendEmail(OFFICE_EMAIL, "Booking form signed — " + (ev.name || "event"), officeText, { attachments: attachments });
  emails.push({ to: OFFICE_EMAIL, ok: ro.ok, error: ro.error });
  const failed = emails.filter(function (e) { return !e.ok; });
  if (failed.length) {
    await sbRpc("ct_service_note", { p_contract: contractId, p_what: "Signed copy NOT emailed to " + failed.map(function (e) { return e.to; }).join(", ") + ": " + (failed[0].error || ""), p_who: "system" }).catch(function () {});
  } else {
    await sbRpc("ct_service_note", { p_contract: contractId, p_what: "Signed copy emailed to " + emails.map(function (e) { return e.to; }).join(", "), p_who: "system" }).catch(function () {});
  }
  return { sealed: true, path: path, emails: emails };
}

module.exports = {
  SUPABASE_URL, SERVICE_KEY, PORTAL_URL, BUCKET, OFFICE_EMAIL,
  ok, bad, sbRest, sbRpc, bearer, userFrom, adminFrom, clientIp,
  sendEmail, logEmail, contractTemplate, firstName, ukLong, fill, sealContract, CONTRACT_EMAILS,
};
