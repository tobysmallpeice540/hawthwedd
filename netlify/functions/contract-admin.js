// netlify/functions/contract-admin.js
//
// The office's side of contracts signed in the app. Admin only (a verified
// Supabase session whose profile role is admin).
//
//   { action: "invite",  contractId }   email each client who has not signed a
//                                       "ready to sign" email with a sign-in
//                                       link (the button) and code
//   { action: "remind",  contractId }   the reminder, by hand, also with a link
//   { action: "seal",    contractId }   make, file and email the signed copy
//                                       (a retry; normally done at signing)
//   { action: "preview", body, answers?, oneSigner? }
//                                       the PDF of a draft, never stored — for
//                                       checking the layout before sending
//
// The contract itself is created by ct_admin_issue from the app; sending the
// emails is this separate step and reported separately, so "the contract was
// made but an email didn't go" never reads as a failure to send the contract
// (the CLAUDE.md lesson from the portal invite).
//
// Required env vars: SUPABASE_SERVICE_KEY · RESEND_API_KEY

const L = require("./contract-lib/common.js");
const { renderContractPdf } = require("./contract-lib/pdf.js");
const auth = require("./portal-auth.js");

async function emailSigners(c, kind, staffName) {
  const t = await L.contractTemplate(kind === "invite" ? "contract_invite" : "contract_reminder");
  const ev = (c.body && c.body.event) || {};
  const unsigned = (c.signers || []).filter(function (s) { return !s.signed_at; });
  const results = [];
  for (const s of unsigned) {
    try {
      await auth.ensureUser(s.email);
      const link = await auth.mintLink(s.email);
      const others = (c.signers || []).filter(function (o) { return o.email !== s.email; });
      const vals = {
        firstName: L.firstName(s.name), event: ev.name || "your event", eventDate: L.ukLong(ev.date), portalUrl: L.PORTAL_URL,
        others: others.length ? others.map(function (o) { return L.firstName(o.name); }).join(" and ") +
          (others.some(function (o) { return o.signed_at; }) ? " has already signed." : " will get their own email to sign, too.") : "",
      };
      const subject = L.fill(t.subject, vals);
      const text = L.fill(t.body, vals);
      const r = await L.sendEmail(s.email, subject, text, { link: link.link, button: kind === "invite" ? t.button : "Read and sign", code: link.code });
      results.push({ email: s.email, ok: r.ok, error: r.error || null });
      if (r.ok) await L.logEmail(subject, s.email, "contract-" + kind, c.event_id, text);
    } catch (e) {
      results.push({ email: s.email, ok: false, error: e.message || String(e) });
    }
  }
  const sent = results.filter(function (r) { return r.ok; }).map(function (r) { return r.email; });
  const failed = results.filter(function (r) { return !r.ok; });
  if (sent.length) await L.sbRpc("ct_service_note", { p_contract: c.id, p_what: (kind === "invite" ? "Emailed to sign: " : "Reminder emailed: ") + sent.join(", "), p_who: staffName }).catch(function () {});
  if (failed.length) await L.sbRpc("ct_service_note", { p_contract: c.id, p_what: "Email NOT sent to " + failed.map(function (f) { return f.email; }).join(", ") + ": " + (failed[0].error || ""), p_who: staffName }).catch(function () {});
  return results;
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return L.bad("Method not allowed", 405);
  if (!L.SERVICE_KEY) return L.bad("Not configured — SUPABASE_SERVICE_KEY is missing", 500);
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return L.bad("Invalid JSON"); }
  const me = await L.adminFrom(event);
  if (!me) return L.bad("Only an admin can do this.", 403);

  if (body.action === "preview") {
    if (!body.body || !Array.isArray(body.body.blocks)) return L.bad("Nothing to preview.");
    const fake = {
      id: "PREVIEW — not sent", version: 0, body: Object.assign({}, body.body, { venue: body.body.venue || { company: "Hawthbush Farm Ltd", name: me.name, signed_at: new Date().toISOString() } }),
      answers: body.answers || {}, one_signer: !!body.oneSigner, signers: [], log: [],
      body_sha256: "(made when it is sent)", final_sha256: "(made when everyone has signed)", sent_at: null,
    };
    try {
      const pdf = await renderContractPdf(fake);
      return L.ok({ pdf: pdf.toString("base64") });
    } catch (e) { return L.bad("Could not draw the PDF: " + (e.message || e), 500); }
  }

  const id = String(body.contractId || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return L.bad("No contract given.");
  let c;
  try { c = await L.sbRpc("ct_service_contract", { p_contract: id }); }
  catch (e) { return L.bad("Could not read the contract.", 502); }
  if (!c || c.ok === false) return L.bad("Contract not found.", 404);

  if (body.action === "invite" || body.action === "remind") {
    if (c.status !== "out") return L.bad("That contract is not out for signing.", 409);
    const results = await emailSigners(c, body.action === "invite" ? "invite" : "remind", me.name);
    return L.ok({ results: results });
  }

  if (body.action === "seal") {
    try { return L.ok(await L.sealContract(id)); }
    catch (e) { return L.bad("Could not make the signed copy: " + (e.message || e), 502); }
  }

  return L.bad("Unknown action");
};
