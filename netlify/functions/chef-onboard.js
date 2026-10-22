// netlify/functions/chef-onboard.js
// The link a chef is sent to set up (or finish setting up) their Stripe account.
//
// Stripe's own onboarding links ("Account Links") work once and expire within
// minutes, so they cannot be emailed. This is the link that IS emailed: it is
// signed, lasts two weeks, and each time it is opened it asks Stripe for a fresh
// onboarding link and sends the chef straight there. If the chef wanders off
// half way and Stripe's link lapses, Stripe sends them back here (refresh_url)
// and they carry on where they were.
//
// The signature is made in box-admin.js (chefOnboardUrl) with HBF_ADMIN_TOKEN as
// the key, over the chef's id and the expiry time. Without the key nobody can
// make a link for a different chef, or extend an old one.
//
// Opening this link only ever leads to Stripe's own forms for that chef's own
// account. It reveals nothing from the box office and changes nothing here.
//
// Required env vars: STRIPE_TICKET_SECRET_KEY · SUPABASE_SERVICE_KEY · HBF_ADMIN_TOKEN

const crypto = require("crypto");

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_TOKEN  = process.env.HBF_ADMIN_TOKEN;
const SITE_ORIGIN  = "https://hawthbushfarm.netlify.app";

// Ticketing's own Stripe account and the same pinned API version as the other
// ticket functions. Never the lettings key.
function getStripe() {
  if (!process.env.STRIPE_TICKET_SECRET_KEY) return null;
  return require("stripe")(process.env.STRIPE_TICKET_SECRET_KEY, { apiVersion: "2024-06-20" });
}

async function sbRest(path) {
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": "Bearer " + SERVICE_KEY,
      "Content-Type": "application/json"
    }
  });
  var text = await res.text();
  if (!res.ok) throw new Error("supabase " + res.status + ": " + text);
  try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
}

function page(title, message, status) {
  var esc = function(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  };
  return {
    statusCode: status || 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
    body: '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">' +
      "<title>" + esc(title) + " | Hawthbush Farm</title>" +
      '<style>body{margin:0;background:#f9f6f1;color:#2d2a25;font-family:Helvetica,Arial,sans-serif}' +
      ".w{max-width:520px;margin:0 auto;padding:56px 20px}.p{background:#fff;border:1px solid #e8e2d9;border-radius:14px;padding:32px 28px}" +
      "h1{font-family:Georgia,serif;font-weight:600;font-size:26px;margin:0 0 12px}p{line-height:1.65;margin:0}" +
      ".b{text-align:center;margin-bottom:22px}.b img{height:56px}</style></head><body><div class=\"w\">" +
      '<div class="b"><img src="/email-logo.png" alt="Hawthbush Farm"></div>' +
      '<div class="p"><h1>' + esc(title) + "</h1><p>" + esc(message) + "</p></div></div></body></html>"
  };
}

function signatureOk(payeeId, expiresAt, sig) {
  if (!ADMIN_TOKEN || !sig) return false;
  var expected = crypto.createHmac("sha256", ADMIN_TOKEN).update("chef-onboard:" + payeeId + ":" + expiresAt).digest("hex");
  var a = Buffer.from(expected, "utf8");
  var b = Buffer.from(String(sig), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

exports.handler = async function(event) {
  var q = event.queryStringParameters || {};
  var payeeId = String(q.p || "");
  var expiresAt = String(q.x || "");
  var sig = String(q.s || "");

  if (!/^[0-9a-f-]{36}$/i.test(payeeId) || !/^\d+$/.test(expiresAt) || !signatureOk(payeeId, expiresAt, sig)) {
    return page("That link isn't valid", "Please use the exact link Hawthbush Farm sent you, or ask them for a new one.", 400);
  }
  if (Number(expiresAt) < Math.floor(Date.now() / 1000)) {
    return page("That link has expired", "Setup links last two weeks. Please ask Hawthbush Farm to send you a new one.", 410);
  }

  var stripe = getStripe();
  if (!stripe || !SERVICE_KEY) {
    console.error("chef-onboard NOT CONFIGURED — STRIPE_TICKET_SECRET_KEY or SUPABASE_SERVICE_KEY missing");
    return page("Something went wrong", "Please let Hawthbush Farm know, and try again a little later.", 500);
  }

  try {
    var rows = await sbRest("box_payees?id=eq." + payeeId + "&select=id,stripe_account_id,charges_enabled");
    var payee = rows && rows[0];
    if (!payee || !payee.stripe_account_id) {
      return page("That link isn't valid", "Please ask Hawthbush Farm to send you a new one.", 404);
    }

    // Already able to take payments: there is nothing for this link to do, and
    // a finished account is changed by its owner in their own Stripe dashboard.
    var acct = await stripe.accounts.retrieve(payee.stripe_account_id);
    if (acct.charges_enabled && acct.details_submitted) {
      return page("You're all set up",
        "Your Stripe account is ready to take payments. To change any details, sign in to your own Stripe dashboard at dashboard.stripe.com.");
    }

    var self = SITE_ORIGIN + "/.netlify/functions/chef-onboard?p=" + encodeURIComponent(payeeId) +
      "&x=" + expiresAt + "&s=" + sig;
    var link = await stripe.accountLinks.create({
      account: payee.stripe_account_id,
      type: "account_onboarding",
      // If Stripe's short-lived link lapses mid-way, Stripe sends the chef
      // back here and they get a fresh one, for as long as this link lasts.
      refresh_url: self,
      return_url:  SITE_ORIGIN + "/chef-connected.html"
    });
    return { statusCode: 302, headers: { "Location": link.url, "Cache-Control": "no-store" }, body: "" };
  } catch (err) {
    console.error("chef-onboard error:", err && err.type ? "[" + err.type + "] " : "", err && err.message);
    return page("Something went wrong", "Stripe couldn't open the setup form just now. Please try the link again in a few minutes, or let Hawthbush Farm know.", 502);
  }
};
