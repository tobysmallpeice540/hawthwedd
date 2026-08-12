// netlify/functions/handle-viewing.js
const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJrcWJ5aXNmbXZ3dWxzeXh6d2p6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NTI0MzgsImV4cCI6MjA5NjUyODQzOH0._CsyhvFrtHFC0KrfiLzbrLUaKcvxtbWlHydaH20tvfo";
const RESEND_KEY  = process.env.RESEND_API_KEY;
const STORAGE_KEY = "hbf_viewing_requests_v1";
const EMAIL_LOG_KEY = "hbf_email_log_v1";
const FROM_EMAIL  = "hello@hawthbushfarm.co.uk";
const TERMS_KEY   = "hbf_terms_v1";
const SITE_ORIGIN = "https://hawthbushfarm.netlify.app";

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

async function sbGet(key) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data?key=eq." + key + "&select=value", {
    headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY }
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return (Array.isArray(rows) && rows[0]) ? rows[0].value : null;
}

async function sbSet(key, value) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data", {
    method: "POST",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key: key, value: value }),
  });
  if (!res.ok) throw new Error("sbSet failed: " + await res.text());
}

// Record a sent email so it shows up in the Home dashboard's "Recent Automated Emails" panel
async function logEmail(entry) {
  try {
    var log = (await sbGet(EMAIL_LOG_KEY)) || [];
    var rec = Object.assign({ id: "el" + Date.now() + "-" + Math.random().toString(36).slice(2, 6), sentAt: new Date().toISOString() }, entry);
    log.push(rec);
    await sbSet(EMAIL_LOG_KEY, log.slice(-500));
  } catch (e) {
    console.error("logEmail failed:", e.message);
  }
}

// ─── SHARED EMAIL SHELL ───────────────────────────────────────────────────────
// Copied verbatim into each sending function (Netlify functions can't share
// local modules without a bundler step, and the rest of this codebase already
// duplicates its helpers the same way). If you change it, change it everywhere:
//   send-accom-email.js · send-accom-reminders.js · stripe-accom-webhook.js
//
// Deliberately table-based with inline styles: Outlook ignores <style> blocks
// and flexbox, so anything cleverer falls apart in exactly the client most
// guests read mail in. Webfonts don't load reliably either, hence Georgia and
// Helvetica rather than the Cormorant/Jost pairing used on the website.
const BRAND = {
  // The live logo from hawthbushfarm.co.uk, requested at 400px wide so it stays
  // crisp on high-DPI screens while rendering at 110px. Hot-linked rather than
  // hosted here so it tracks the website; if the Squarespace site is ever
  // rebuilt this URL should be re-checked.
  logo:    "https://images.squarespace-cdn.com/content/v1/6897aa6fe61ae2143f465ab1/1754770036281-I54E64T6O6J1YLVL9KYF/logo.png?format=400w",
  site:    "https://www.hawthbushfarm.co.uk",
  bg:      "#f9f6f1",
  panel:   "#ffffff",
  text:    "#2d2a25",
  muted:   "#7a7060",
  border:  "#e8e2d9",
  accent:  "#b8a88a"
};

// Turn the plain-text template body into email HTML: blank lines become
// paragraphs, and any bare URL becomes a link (payment links are pasted into
// the templates as raw URLs).
function bodyToHtml(bodyText) {
  var paras = String(bodyText || "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  return paras.map(function (p) {
    var safe = escapeHtml(p.trim());
    safe = safe.replace(/(https?:\/\/[^\s<]+)/g, function (url) {
      // Show something readable rather than a 200-character query string.
      var label = url.length > 60 ? url.replace(/^https?:\/\//, "").split("/")[0] + "/…" : url;
      return '<a href="' + url + '" style="color:#2d2a25;text-decoration:underline">' + label + '</a>';
    });
    return '<p style="margin:0 0 15px;font-size:15px;line-height:1.65;color:' + BRAND.text + '">' + safe + '</p>';
  }).join("");
}

// opts: { termsUrl, buttonLabel, buttonUrl }
function buildEmailHtml(bodyText, opts) {
  var o = opts || {};

  var payButton = "";
  if (o.buttonUrl) {
    payButton = '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0">' +
      '<tr><td align="center" bgcolor="' + BRAND.text + '" style="border-radius:8px">' +
      '<a href="' + o.buttonUrl + '" style="display:inline-block;padding:14px 34px;font-family:Helvetica,Arial,sans-serif;' +
      'font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px">' +
      escapeHtml(o.buttonLabel || "Pay now") + '</a></td></tr>' +
      // The Stripe cue reassures the guest about where their card details go —
      // it replaces the reassurance the visible checkout.stripe.com URL used
      // to give before the raw link was taken out.
      '<tr><td align="center" style="padding-top:8px;font-family:Helvetica,Arial,sans-serif;font-size:11px;color:' + BRAND.muted + '">' +
      'Secure card payment powered by Stripe</td></tr></table>';
  }

  // Checkout URLs run past a hundred characters and wrap over several lines,
  // which looks broken. The button carries the link instead — and it goes
  // exactly where the URL sat, so the sentence introducing it still leads into
  // it and the sign-off stays at the bottom. With no URL in the wording (an
  // older template), the button is appended after the text.
  var inner;
  if (o.buttonUrl && String(bodyText || "").indexOf(o.buttonUrl) !== -1) {
    var halves = String(bodyText).split(o.buttonUrl);
    var before = halves[0].replace(/[ \t]+$/, "").replace(/\n+$/, "");
    var after  = halves.slice(1).join(o.buttonUrl).replace(/^\n+/, "");
    inner = bodyToHtml(before) + payButton + bodyToHtml(after);
  } else {
    inner = bodyToHtml(bodyText) + payButton;
  }

  var terms = "";
  if (o.termsUrl) {
    terms = '<p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:' + BRAND.muted + '">' +
      'Your booking is subject to our <a href="' + o.termsUrl + '" style="color:' + BRAND.muted + '">Terms &amp; Conditions</a>.' +
      '</p>';
  }

  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Hawthbush Farm</title></head>' +
    '<body style="margin:0;padding:0;background:' + BRAND.bg + ';">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + BRAND.bg + ';padding:26px 12px">' +
    '<tr><td align="center">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%">' +

    // Logo
    '<tr><td align="center" style="padding:0 0 20px">' +
    '<a href="' + BRAND.site + '"><img src="' + BRAND.logo + '" alt="Hawthbush Farm" width="110" ' +
    'style="display:block;border:0;width:110px;height:auto"></a>' +
    '</td></tr>' +

    // Body panel
    '<tr><td style="background:' + BRAND.panel + ';border:1px solid ' + BRAND.border + ';border-radius:14px;padding:30px 34px;' +
    'font-family:Helvetica,Arial,sans-serif">' + inner + '</td></tr>' +

    // Footer
    '<tr><td align="center" style="padding:20px 16px 0;font-family:Helvetica,Arial,sans-serif">' +
    terms +
    '<p style="margin:0 0 4px;font-size:12px;line-height:1.6;color:' + BRAND.muted + '">' +
    'Hawthbush Farm, Gun Hill, Heathfield, East Sussex &middot; ' +
    '<a href="mailto:' + FROM_EMAIL + '" style="color:' + BRAND.muted + '">' + FROM_EMAIL + '</a></p>' +
    '<p style="margin:0;font-size:12px;color:' + BRAND.muted + '">' +
    '<a href="' + BRAND.site + '" style="color:' + BRAND.muted + '">hawthbushfarm.co.uk</a></p>' +
    '</td></tr>' +

    '</table></td></tr></table></body></html>';
}

// The T&C link is only included when terms have actually been written, so a
// blank setting doesn't produce a link to an empty page.
async function getTermsUrl() {
  try {
    var t = await sbGet(TERMS_KEY);
    if (t && String(t.text || "").trim()) return SITE_ORIGIN + "/terms.html";
  } catch (e) { /* a missing T&C must never stop an email going out */ }
  return "";
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Method not allowed" }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  // action: "confirm" | "decline" | "amend"
  //   amend = confirm the viewing, but at a date/time we've proposed instead of
  //   the one requested. The stored request is updated so the diary and the
  //   confirmation email both reflect what was actually agreed.
  const { id, action, newDate, newTime } = body;
  if (!id || !action) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Missing id or action" }) };
  if (action === "amend" && (!newDate || !newTime)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "amend needs newDate and newTime" }) };
  }

  // Read existing requests
  const getRes = await fetch(
    `${SUPABASE_URL}/rest/v1/app_data?key=eq.${STORAGE_KEY}&select=value`,
    {
      method: "GET",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
      }
    }
  );
  const rows = await getRes.json();
  const requests = (Array.isArray(rows) && rows[0] && Array.isArray(rows[0].value)) ? rows[0].value : [];

  const req = requests.find(function(r) { return r.id === id; });
  if (!req) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: "Request not found" }) };

  // Update status (and the slot itself when amending)
  const newStatus = (action === "confirm" || action === "amend") ? "confirmed" : "declined";
  const origDate = req.date, origTime = req.time;
  const patch = { status: newStatus };
  if (action === "amend") {
    patch.date = newDate;
    patch.time = newTime;
    patch.amendedFrom = { date: origDate, time: origTime };
  }
  const updated = requests.map(function(r) {
    return r.id === id ? Object.assign({}, r, patch) : r;
  });
  // Everything below should describe the AGREED slot, not the requested one.
  if (action === "amend") { req.date = newDate; req.time = newTime; }

  const setRes = await fetch(`${SUPABASE_URL}/rest/v1/app_data`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates",
    },
    body: JSON.stringify({ key: STORAGE_KEY, value: updated }),
  });

  if (!setRes.ok) {
    const errText = await setRes.text();
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Save failed: " + errText }) };
  }

  // Format date
  const dateObj = new Date(req.date + "T00:00:00");
  const niceDate = dateObj.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  // Send email
  if (RESEND_KEY) {
    const origDateObj  = new Date(origDate + "T00:00:00");
    const origNiceDate = origDateObj.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

    // Composed as plain text and run through the shared branded shell, so
    // viewing emails look like the accommodation ones rather than carrying
    // their own hand-rolled markup.
    const slotLine = niceDate + " at " + req.time;
    const bodyText = action === "amend"
      ? "Dear " + req.name + ",\n\n" +
        "Thank you for your interest in Hawthbush Farm. We weren't able to do " + origNiceDate +
        " at " + origTime + ", so we've booked you in at the time below instead.\n\n" +
        slotLine + "\n\n" +
        "If that doesn't suit, just reply to this email and we'll find another time.\n\n" +
        "Warm regards,\nThe Hawthbush Farm Team"
      : action === "confirm"
      ? "Dear " + req.name + ",\n\n" +
        "We're delighted to confirm your viewing at Hawthbush Farm.\n\n" +
        slotLine + "\n\n" +
        "We look forward to welcoming you. Please reply if you have any questions.\n\n" +
        "Warm regards,\nThe Hawthbush Farm Team"
      : "Dear " + req.name + ",\n\n" +
        "Thank you for your interest in Hawthbush Farm.\n\n" +
        "Unfortunately we're unable to accommodate a viewing on " + slotLine + ".\n\n" +
        "Please get in touch at " + FROM_EMAIL + " and we'll find an alternative.\n\n" +
        "Warm regards,\nThe Hawthbush Farm Team";

    const emailBody = buildEmailHtml(bodyText, { termsUrl: await getTermsUrl() });

    const subject = action === "amend"
      ? "Your Viewing at Hawthbush Farm - new time, " + niceDate + " at " + req.time
      : action === "confirm"
      ? "Your Viewing at Hawthbush Farm - " + niceDate + " at " + req.time
      : "Your Viewing Request - Hawthbush Farm";

    try {
      const sendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + RESEND_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: req.email,
          subject: subject,
          html: emailBody,
        }),
      });
      if (sendRes.ok) {
        await logEmail({ subject: subject, to: req.email, type: "viewing_" + action, requestId: id,
          body: String(bodyText || "").slice(0, 8000) });
      } else {
        console.log("Email send failed:", await sendRes.text());
      }
    } catch (e) {
      console.log("Email error:", e.message);
    }
  }

  return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
};
