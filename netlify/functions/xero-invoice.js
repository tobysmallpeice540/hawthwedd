// netlify/functions/xero-invoice.js
//
// Pushes an event invoice into Xero as a DRAFT, creating/reusing the customer
// contact as it goes, then reads the invoice back to verify the totals.
//
// The Xero access token lives client-side (sessionStorage) exactly as it does
// for the existing read-only calls, so it is passed in with each request. This
// function performs the WRITE calls server-side because Netlify's proxy
// redirects are only wired up for GETs, and because doing contact lookup +
// theme lookup + create + verify in one round trip keeps the client simple.
//
// Actions:
//   "preflight" — resolve branding theme + contact WITHOUT creating an invoice
//   "push"      — create (or reuse) the contact, then create the DRAFT invoice
//
// Required Xero scopes (see XERO_SCOPES in App.jsx):
//   accounting.transactions, accounting.contacts, accounting.settings.read

const XERO_API = "https://api.xero.com/api.xro/2.0/";

function jsonResponse(statusCode, body) {
  return {
    statusCode: statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

// ── Xero helpers (no header spread) ──────────────────────────────────────────
async function xeroCall(accessToken, tenantId, path, method, payload) {
  const opts = {
    method: method || "GET",
    headers: {
      "Authorization": "Bearer " + accessToken,
      "Xero-tenant-id": tenantId,
      "Accept": "application/json",
      "Content-Type": "application/json"
    }
  };
  if (payload) opts.body = JSON.stringify(payload);

  const res = await fetch(XERO_API + path, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }

  if (!res.ok) {
    // Surface Xero's own validation messages — they are far more useful than
    // a bare status code when a line item or account code is wrong.
    let detail = "";
    if (data && data.Elements && data.Elements.length) {
      const errs = [];
      data.Elements.forEach(function(el) {
        (el.ValidationErrors || []).forEach(function(ve) { errs.push(ve.Message); });
      });
      detail = errs.join("; ");
    }
    if (!detail && data && data.Message) detail = data.Message;
    if (!detail) detail = text.slice(0, 300);
    const err = new Error("Xero " + res.status + ": " + detail);
    err.statusCode = res.status;
    throw err;
  }
  return data;
}

// Look up the branding theme by name so we never hardcode a GUID.
// Deliberately non-fatal: reading branding themes needs the accounting.settings
// scope, which the app no longer requests (it caused authorize failures). If
// the call is refused we simply let Xero apply its default theme rather than
// failing the whole invoice push over cosmetics.
async function resolveBrandingTheme(accessToken, tenantId, themeName) {
  try {
    const data = await xeroCall(accessToken, tenantId, "BrandingThemes", "GET", null);
    const themes = (data && data.BrandingThemes) || [];
    const wanted = String(themeName || "").trim().toLowerCase();
    const match = themes.find(function(t) {
      return String(t.Name || "").trim().toLowerCase() === wanted;
    });
    return {
      brandingThemeId: match ? match.BrandingThemeID : null,
      available: themes.map(function(t) { return t.Name; }),
      unavailable: false
    };
  } catch (e) {
    console.warn("Branding theme lookup skipped:", e.message);
    return { brandingThemeId: null, available: [], unavailable: true };
  }
}

// Find an existing contact by any of the candidate names, else create one.
// Xero requires contact names to be unique across all active contacts, so we
// must search before creating or the second push would fail outright.
async function findOrCreateContact(accessToken, tenantId, opts) {
  const names = (opts.names || []).filter(Boolean);

  for (let i = 0; i < names.length; i++) {
    const q = encodeURIComponent('Name=="' + names[i].replace(/"/g, '') + '"');
    const found = await xeroCall(accessToken, tenantId, "Contacts?where=" + q, "GET", null);
    const list = (found && found.Contacts) || [];
    if (list.length) return { contact: list[0], created: false };
  }

  if (!opts.createIfMissing) return { contact: null, created: false };

  const emails = opts.emails || [];
  const contact = {
    Name: names[0],
    // Xero holds one primary email; any extras become ContactPersons flagged
    // to be included when the invoice is emailed.
    EmailAddress: emails[0] || "",
    ContactPersons: emails.slice(1).map(function(e) {
      const local = String(e).split("@")[0].replace(/[._-]+/g, " ").trim();
      return {
        FirstName: (local.split(" ")[0] || "Contact").slice(0, 50),
        LastName: (local.split(" ").slice(1).join(" ") || "Billing").slice(0, 50),
        EmailAddress: e,
        IncludeInEmails: true
      };
    })
  };

  const created = await xeroCall(accessToken, tenantId, "Contacts", "POST",
    { Contacts: [contact] });
  const madeList = (created && created.Contacts) || [];
  if (!madeList.length) throw new Error("Xero did not return the created contact");
  return { contact: madeList[0], created: true };
}

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return jsonResponse(400, { error: "Invalid JSON" }); }

  const accessToken = body.accessToken;
  const tenantId    = body.tenantId;
  if (!accessToken || !tenantId) {
    return jsonResponse(400, { error: "Missing Xero credentials — reconnect Xero and try again." });
  }

  try {
    // ── Branding theme ───────────────────────────────────────────────────────
    const theme = await resolveBrandingTheme(accessToken, tenantId, body.themeName);

    if (body.action === "preflight") {
      const pf = await findOrCreateContact(accessToken, tenantId, {
        names: body.contactNames || [],
        emails: body.emails || [],
        createIfMissing: false
      });
      return jsonResponse(200, {
        brandingThemeId: theme.brandingThemeId,
        availableThemes: theme.available,
        contactFound: !!pf.contact,
        contactId: pf.contact ? pf.contact.ContactID : null,
        contactName: pf.contact ? pf.contact.Name : null
      });
    }

    if (body.action !== "push") {
      return jsonResponse(400, { error: "Unknown action" });
    }

    // ── Validate the invoice payload before touching Xero ────────────────────
    const lines = body.lines || [];
    if (!lines.length) return jsonResponse(400, { error: "Invoice has no lines" });
    if (!body.invoiceDate) return jsonResponse(400, { error: "Invoice has no date" });

    const expectedTotal = Math.round(
      lines.reduce(function(a, l) { return a + Number(l.amount || 0); }, 0) * 100
    ) / 100;
    if (!(expectedTotal > 0)) {
      return jsonResponse(400, { error: "Invoice total must be greater than zero (it is " + expectedTotal + ")" });
    }

    // ── Contact ──────────────────────────────────────────────────────────────
    let contactId = body.contactId || null;
    let contactCreated = false;
    let contactName = null;
    if (!contactId) {
      const cRes = await findOrCreateContact(accessToken, tenantId, {
        names: body.contactNames || [],
        emails: body.emails || [],
        createIfMissing: true
      });
      if (!cRes.contact) return jsonResponse(400, { error: "Could not find or create the Xero contact" });
      contactId = cRes.contact.ContactID;
      contactCreated = cRes.created;
      contactName = cRes.contact.Name;
    }

    // ── Build the invoice ────────────────────────────────────────────────────
    // LineAmountTypes MUST be "Inclusive": every figure held in the app is
    // VAT-inclusive, and Xero defaults to Exclusive when this is omitted —
    // which would silently add 20% to every invoice.
    const invoice = {
      Type: "ACCREC",
      Status: "DRAFT",
      LineAmountTypes: "Inclusive",
      Contact: { ContactID: contactId },
      Date: body.invoiceDate,
      DueDate: body.dueDate || body.invoiceDate,
      Reference: body.reference || "",
      // Tax is derived from each account's default rate (200 and 205 are both
      // set to standard VAT), so TaxType is deliberately not set per line.
      LineItems: lines.map(function(l) {
        return {
          Description: String(l.desc || "").slice(0, 4000),
          Quantity: 1,
          UnitAmount: Number(l.amount || 0),
          AccountCode: String(l.account || "")
        };
      })
    };
    if (theme.brandingThemeId) invoice.BrandingThemeID = theme.brandingThemeId;

    const createRes = await xeroCall(accessToken, tenantId, "Invoices", "POST",
      { Invoices: [invoice] });
    const made = ((createRes && createRes.Invoices) || [])[0];
    if (!made) throw new Error("Xero did not return the created invoice");

    // ── Verify ───────────────────────────────────────────────────────────────
    // Read the invoice back and compare against what we intended. This is the
    // guard against a LineAmountTypes/tax misconfiguration silently producing
    // invoices 20% out — it would be caught on the very first push.
    const readBack = await xeroCall(accessToken, tenantId, "Invoices/" + made.InvoiceID, "GET", null);
    const fresh = ((readBack && readBack.Invoices) || [])[0] || made;
    const xeroTotal = Number(fresh.Total || 0);
    const mismatch = Math.abs(xeroTotal - expectedTotal) > 0.01;

    return jsonResponse(200, {
      ok: true,
      invoiceId: fresh.InvoiceID,
      invoiceNumber: fresh.InvoiceNumber || "",
      status: fresh.Status,
      total: xeroTotal,
      subTotal: Number(fresh.SubTotal || 0),
      totalTax: Number(fresh.TotalTax || 0),
      expectedTotal: expectedTotal,
      totalMismatch: mismatch,
      lineAmountTypes: fresh.LineAmountTypes,
      brandingThemeApplied: !!theme.brandingThemeId,
      availableThemes: theme.available,
      contactId: contactId,
      contactCreated: contactCreated,
      contactName: contactName,
      warning: mismatch
        ? "Xero's total (" + xeroTotal.toFixed(2) + ") does not match the expected total (" +
          expectedTotal.toFixed(2) + "). Check the draft in Xero before sending — this usually " +
          "means VAT is being applied on top rather than treated as included."
        : theme.brandingThemeId ? null
        : theme.unavailable
          ? "Xero's default branding theme was used — set the theme on the draft in Xero if it matters."
          : "Branding theme not found; Xero's default theme was used."
    });

  } catch (err) {
    console.error("xero-invoice error:", err);
    return jsonResponse(err.statusCode === 401 ? 401 : 500, {
      error: String(err.message || err),
      needsReconnect: err.statusCode === 401 || /unauthor/i.test(String(err.message || ""))
    });
  }
};
