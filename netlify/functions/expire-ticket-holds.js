// netlify/functions/expire-ticket-holds.js
// Scheduled tidy-up of abandoned checkouts (see netlify.toml).
//
// Worth being clear about what this is and isn't. The correctness lives in
// box_reserve_order(), which counts a pending order as sold only for fifteen
// minutes — so seats release themselves whether or not this ever runs, and
// nothing breaks if a deploy takes the schedule away.
//
// This is hygiene: an abandoned checkout is a real person's name, email and
// phone number, and there's no reason to keep it once it can't become a sale.
//
// Required env vars: SUPABASE_SERVICE_KEY

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;

exports.handler = async function() {
  try {
    var res = await fetch(SUPABASE_URL + "/rest/v1/rpc/box_expire_holds", {
      method: "POST",
      headers: {
        "apikey": SERVICE_KEY,
        "Authorization": "Bearer " + SERVICE_KEY,
        "Content-Type": "application/json"
      },
      body: "{}"
    });
    var text = await res.text();
    if (!res.ok) throw new Error("supabase " + res.status + ": " + text);
    console.log("[expire-ticket-holds] removed " + text + " abandoned checkouts");
    return { statusCode: 200, body: JSON.stringify({ ok: true, removed: Number(text) || 0 }) };
  } catch (err) {
    console.error("expire-ticket-holds error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
