// netlify/functions/contract-sign.js
//
// The couple's side of a contract signed in the app.
//
//   { action: "sign", name, agree: true }   sign the booking form
//   { action: "download" }                  a five-minute link to the signed copy
//
// Who is signing is checked with Supabase (the bearer token), never believed
// from the browser; the IP address and browser are read here, because a
// database function cannot see them. The signature itself is recorded by
// ct_sign_service (service role only), which checks the email is a signer on
// the contract for THEIR event, that everything needed is filled in, and that
// they have not signed already. The first signature locks the details.
//
// When the last signature lands, the contract is sealed in the same request:
// the PDF is made, stored, recorded and emailed (contract-lib/common.js). If
// that part fails the signature still stands — the reminders run retries any
// signed contract without a PDF, and staff can press "Make the signed copy".
//
// Required env vars: SUPABASE_SERVICE_KEY · RESEND_API_KEY

const L = require("./contract-lib/common.js");

const LINK_SECONDS = 300;

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return L.bad("Method not allowed", 405);
  if (!L.SERVICE_KEY) return L.bad("Not configured — SUPABASE_SERVICE_KEY is missing", 500);
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return L.bad("Invalid JSON"); }

  const user = await L.userFrom(event);
  if (!user) return L.bad("Please sign in again.", 401);

  if (body.action === "sign") {
    if (body.agree !== true) return L.bad("Please tick to say you agree.");
    const name = String(body.name || "").replace(/\s+/g, " ").trim();
    if (name.length < 2) return L.bad("Please type your full name to sign.");
    const ua = String((event.headers || {})["user-agent"] || "").slice(0, 300);
    let r;
    try {
      r = await L.sbRpc("ct_sign_service", { p_user: user.id, p_email: user.email, p_name: name, p_ip: L.clientIp(event), p_ua: ua });
    } catch (e) {
      console.error("ct_sign_service failed:", e.message);
      return L.bad("We couldn't record your signature just now. Please try again in a moment.", 502);
    }
    if (!r || r.ok !== true) {
      const code = r && r.error;
      const msg = code === "incomplete" ? "A few things still need filling in first."
        : code === "already_signed" ? "You have already signed this booking form."
        : code === "not_a_signer" ? "This booking form is waiting for another signature, not yours. Sign in with the email address we sent it to."
        : code === "no_contract" ? "There is no booking form waiting to be signed."
        : code === "name_needed" ? "Please type your full name to sign."
        : "We couldn't record your signature.";
      return L.bad(msg, 409, { code: code, missing: (r && r.missing) || [] });
    }

    let sealed = null, sealError = null;
    if (r.complete) {
      try { sealed = await L.sealContract(r.contract_id); }
      catch (e) { sealError = e.message || String(e); console.error("sealing failed:", sealError); }
    } else {
      // A short note to the one who has signed. The other client already has
      // the invitation; nobody is emailed a sign-in link from here.
      try {
        const c = await L.sbRpc("ct_service_contract", { p_contract: r.contract_id });
        const me = (c.signers || []).find(function (s) { return s.email === user.email; }) || {};
        const waiting = (c.signers || []).filter(function (s) { return !s.signed_at; }).map(function (s) { return s.name; });
        const ev = (c.body && c.body.event) || {};
        const text = "Hello " + L.firstName(me.name) + ",\n\nThank you — we have your signature on the booking form for " +
          (ev.name || "your event") + " (" + L.ukLong(ev.date) + ").\n\n" +
          (waiting.length ? "We are now waiting for " + waiting.join(" and ") + " to sign. " : "") +
          "As soon as everyone has signed, we will email you both a copy of the signed form.";
        const sent = await L.sendEmail(user.email, "We have your signature — Hawthbush Farm", text, { copy: true });
        if (sent.ok) await L.logEmail("We have your signature — Hawthbush Farm", user.email, "contract-thanks", c.event_id, text, sent.gmailId);
      } catch (e) { console.warn("signature note failed:", e.message); }
    }
    return L.ok({ signed: true, complete: !!r.complete, sealed: !!(sealed && sealed.sealed), sealError: sealError ? true : false });
  }

  if (body.action === "download") {
    // Asked AS THE USER, so it can only ever be their own event's copy.
    let path;
    try { path = await L.sbRpc("ct_my_pdf_path", {}, user.jwt); }
    catch (e) { return L.bad("Please sign in again.", 401); }
    if (!path || typeof path !== "string") return L.bad("The signed copy isn't ready yet — it usually takes a minute.", 404);
    const res = await fetch(L.SUPABASE_URL + "/storage/v1/object/sign/" + L.BUCKET + "/" + path.split("/").map(encodeURIComponent).join("/"), {
      method: "POST",
      headers: { apikey: L.SERVICE_KEY, Authorization: "Bearer " + L.SERVICE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: LINK_SECONDS })
    });
    if (!res.ok) return L.bad("Could not open the signed copy just now.", 502);
    const j = await res.json().catch(function () { return {}; });
    const signed = j.signedURL || j.signedUrl;
    if (!signed) return L.bad("Could not open the signed copy just now.", 502);
    return L.ok({ url: L.SUPABASE_URL + "/storage/v1" + (signed.charAt(0) === "/" ? "" : "/") + signed });
  }

  return L.bad("Unknown action");
};
