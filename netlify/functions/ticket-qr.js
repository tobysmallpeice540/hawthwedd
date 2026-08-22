// netlify/functions/ticket-qr.js
// The QR code, served as a real PNG at its own URL: /.netlify/functions/ticket-qr?t=<token>
//
// It is a hosted image rather than a data: URI or an attachment, and that was
// reasoned through rather than assumed: Gmail strips data: URI images, and
// Resend attachments don't reliably display inline. A PNG at a URL renders
// everywhere, so that is what the email points an ordinary <img> at.
//
// The code carries the random 32-character token — never the order reference,
// so a reference glimpsed on someone else's ticket can't be turned into a
// working code. It encodes the full /my-ticket URL so that a phone camera
// pointed at a printed ticket does something useful; the door scanner takes
// the token back out of it.
//
// Required env vars: SUPABASE_SERVICE_KEY

const QRCode = require("qrcode");

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const SITE_ORIGIN  = "https://hawthbushfarm.netlify.app";

async function sbRest(path) {
  var res = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": "Bearer " + SERVICE_KEY
    }
  });
  var text = await res.text();
  if (!res.ok) throw new Error("supabase " + res.status + ": " + text);
  try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
}

exports.handler = async function(event) {
  var token = (event.queryStringParameters && event.queryStringParameters.t) || "";
  if (!token || token.length < 16) {
    return { statusCode: 400, body: "Missing token" };
  }

  try {
    var rows = await sbRest("box_orders?qr_token=eq." + encodeURIComponent(token) +
      "&select=id,status,tickets_issued_at");
    var order = rows && rows[0];

    // No QR until paid in full, and none at all for a cancelled booking. The
    // endpoint refuses rather than drawing a code that wouldn't scan — a
    // half-paid table has nothing to show at the door, by design.
    if (!order || !order.tickets_issued_at ||
        order.status === "cancelled" || order.status === "refunded") {
      return { statusCode: 404, body: "No ticket issued for that code" };
    }

    var png = await QRCode.toBuffer(SITE_ORIGIN + "/my-ticket/" + token, {
      type: "png",
      errorCorrectionLevel: "M",   // survives a creased printout and a fingerprint
      margin: 2,
      width: 640,                  // big enough to scan off a dim phone screen
      color: { dark: "#2d2a25", light: "#ffffff" }
    });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "image/png",
        // The code for a token never changes, so mail clients and phones may
        // keep it for as long as they like.
        "Cache-Control": "public, max-age=31536000, immutable"
      },
      body: png.toString("base64"),
      isBase64Encoded: true
    };

  } catch (err) {
    console.error("ticket-qr error:", err);
    return { statusCode: 500, body: "Could not draw that code" };
  }
};
