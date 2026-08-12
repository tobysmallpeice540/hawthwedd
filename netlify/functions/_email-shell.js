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
  logo:    SITE_ORIGIN + "/email-logo.png",
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
      return '<a href="' + url + '" style="color:#2d2a25;text-decoration:underline">' + url + '</a>';
    });
    return '<p style="margin:0 0 15px;font-size:15px;line-height:1.65;color:' + BRAND.text + '">' + safe + '</p>';
  }).join("");
}

// opts: { termsUrl, buttonLabel, buttonUrl }
function buildEmailHtml(bodyText, opts) {
  var o = opts || {};
  var inner = bodyToHtml(bodyText);

  if (o.buttonUrl) {
    inner += '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 6px">' +
      '<tr><td align="center" bgcolor="' + BRAND.text + '" style="border-radius:8px">' +
      '<a href="' + o.buttonUrl + '" style="display:inline-block;padding:13px 30px;font-family:Helvetica,Arial,sans-serif;' +
      'font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px">' +
      escapeHtml(o.buttonLabel || "Pay now") + '</a></td></tr></table>';
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
