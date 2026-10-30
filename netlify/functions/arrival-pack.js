// netlify/functions/arrival-pack.js
//
// A fixed link to the arrival pack attached to a lettings email template, so
// the WhatsApp (and anywhere else) can link to it and it never needs
// updating: replace the attachment on the email template (Settings → Email
// templates → Lettings) and this link serves the new file (Toby, 30 Oct).
//
//   https://hawthbushfarm.netlify.app/pack/<template id>/<key>
//   https://hawthbushfarm.netlify.app/pack/<template id>/<key>/<tag>
//   (netlify.toml rewrites those to ?t=<template id>&k=<key>[&p=<tag>])
//
// <tag> is a property ("hamlet") or a kind of event ("event-party"): each
// attachment on the template can be marked for one (31 Oct, Toby). That link
// serves the attachment marked for it, else the one for everyone.
//
// <key> is an HMAC of the template id with HBF_ADMIN_TOKEN, so the link can't
// be guessed — packs carry gate codes and the like — but stays the same until
// that token is rotated. whatsapp-send's status hands the page each link.
//
// Serves the attachment inline, as stored (the app keeps
// attachments as data URLs inside app_data hbf_email_templates_v1).
//
// Required env vars: SUPABASE_SERVICE_KEY, HBF_ADMIN_TOKEN

"use strict";

const crypto = require("crypto");
const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";

const { packKey, packUrl, packAttachment } = require("./whatsapp-reminders/templates.js");
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

const notFound = { statusCode: 404, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "This arrival pack link isn't available. Please contact Hawthbush Farm." };

exports.handler = async function (event) {
  const q = (event && event.queryStringParameters) || {};
  const t = String(q.t || ""), k = String(q.k || ""), p = String(q.p || "");
  const secret = process.env.HBF_ADMIN_TOKEN;
  if (!/^[a-z0-9_]{1,60}$/.test(t) || !/^[a-z0-9_-]{0,60}$/.test(p) || !secret
    || !safeEqual(k, packKey(t, secret, p || undefined))) return notFound;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data?key=eq.hbf_email_templates_v1&select=value",
    { headers: { "apikey": key, "Authorization": "Bearer " + key } });
  if (!res.ok) return { statusCode: 503, body: "Please try again in a moment." };
  const rows = await res.json();
  const list = rows[0] && Array.isArray(rows[0].value) ? rows[0].value : [];
  const tpl = list.filter(function (x) { return x && x.id === t; })[0];
  const att = tpl && packAttachment(tpl, p || undefined);
  const m = att && /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s.exec(String(att.dataUrl || ""));
  if (!m) return notFound;
  const name = String(att.name || "arrival-pack.pdf").replace(/[^\w .()-]/g, "_");
  return {
    statusCode: 200,
    headers: {
      "Content-Type": att.type || m[1] || "application/octet-stream",
      "Content-Disposition": "inline; filename=\"" + name + "\"",
      // Short, so a replaced pack shows within minutes.
      "Cache-Control": "public, max-age=300",
      "X-Robots-Tag": "noindex"
    },
    body: m[2],
    isBase64Encoded: true
  };
};

exports.packKey = packKey;
exports.packUrl = packUrl;
