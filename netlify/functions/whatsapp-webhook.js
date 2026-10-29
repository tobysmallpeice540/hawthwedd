// netlify/functions/whatsapp-webhook.js
// The address Meta calls for the WhatsApp Cloud API (the 01825 number).
//
//   https://hawthbushfarm.netlify.app/.netlify/functions/whatsapp-webhook
//
// GET  — Meta's one-off check when the callback URL is saved in the developer
//        app. It sends hub.mode=subscribe, hub.verify_token and hub.challenge;
//        we answer with the challenge only if the token matches
//        WHATSAPP_VERIFY_TOKEN (a Netlify environment variable).
// POST — every delivery receipt and every message a guest sends to the 01825
//        number. Signed by Meta with the app secret: once WHATSAPP_APP_SECRET is
//        set, anything whose X-Hub-Signature-256 does not match is refused.
//
// For now the POST side only acknowledges. Meta retries anything that is not
// answered 200 quickly, for days, so the answer has to come first. Storing
// replies against the booking, the "this number isn't monitored" auto-reply
// and the email to the farm inbox are the next build, once the number is
// registered and there is real traffic to test against.
//
// Nothing a guest writes is logged: Netlify function logs are not the place
// for guests' messages. Counts only.
const crypto = require("crypto");

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "";
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || "";

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.timingSafeEqual(x, y);
}

function rawBody(event) {
  if (!event.body) return Buffer.alloc(0);
  return event.isBase64Encoded ? Buffer.from(event.body, "base64") : Buffer.from(event.body, "utf8");
}

exports.handler = async (event) => {
  if (event.httpMethod === "GET") {
    const q = event.queryStringParameters || {};
    if (!VERIFY_TOKEN) {
      // Fail loudly rather than accept any token while the variable is missing.
      console.error("whatsapp-webhook: WHATSAPP_VERIFY_TOKEN is not set");
      return { statusCode: 500, body: "Not configured" };
    }
    if (q["hub.mode"] === "subscribe" && safeEqual(q["hub.verify_token"], VERIFY_TOKEN)) {
      return { statusCode: 200, headers: { "Content-Type": "text/plain" }, body: String(q["hub.challenge"] || "") };
    }
    return { statusCode: 403, body: "Forbidden" };
  }

  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const body = rawBody(event);
  if (APP_SECRET) {
    const h = event.headers || {};
    const sig = String(h["x-hub-signature-256"] || h["X-Hub-Signature-256"] || "");
    const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(body).digest("hex");
    if (!safeEqual(sig, expected)) return { statusCode: 401, body: "Bad signature" };
  }

  let payload;
  try { payload = JSON.parse(body.toString("utf8")); } catch (e) { return { statusCode: 400, body: "Bad JSON" }; }

  let messages = 0, statuses = 0;
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      messages += (v.messages || []).length;
      statuses += (v.statuses || []).length;
    }
  }
  console.log("whatsapp-webhook: " + messages + " message(s), " + statuses + " status update(s)" + (APP_SECRET ? "" : " (unsigned check: WHATSAPP_APP_SECRET not set)"));
  return { statusCode: 200, body: "OK" };
};
