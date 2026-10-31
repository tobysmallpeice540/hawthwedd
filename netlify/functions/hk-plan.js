// netlify/functions/hk-plan.js
//
// The changeover plan page behind the button on the weekly changeover summary
// WhatsApp (31 Oct, Toby): the next 10 days (PAGE_DAYS — the WhatsApp itself
// covers 7), busy days only, one line per
// check-out, check-in and Grain Store event, with times, extra cleans, no-exit
// cleans, arrival times the guests gave and the notes to housekeepers. Read
// live, so a change made after the WhatsApp went shows here.
//
//   https://hawthbushfarm.netlify.app/plan/<day sent>-<key>
//   (netlify.toml rewrites that to ?s=<day sent>-<key>)
//
// No sign-in — the housekeepers open it straight from WhatsApp — so the key
// is an HMAC of the day it was sent with HBF_ADMIN_TOKEN (templates.js
// planKey), and the link stops working PLAN_LINK_DAYS after that day: it
// carries guests' surnames and the notes to housekeepers. Everything shown is
// escaped; the page runs no script.
//
// Required env vars: SUPABASE_SERVICE_KEY, HBF_ADMIN_TOKEN

"use strict";

const T = require("./whatsapp-reminders/templates.js");
const P = require("./whatsapp-reminders/plan.js");
const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
// The page looks further ahead than the WhatsApp's 7 days (Toby, 31 Oct).
const PAGE_DAYS = 10;

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
};

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

const STYLE = "body{margin:0;background:#f6f4ef;color:#1f2a1c;font:16px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}" +
  "main{max-width:640px;margin:0 auto;padding:16px}h1{font-size:22px;margin:4px 0 2px}.sub{color:#5d6657;font-size:14px;margin-bottom:16px}" +
  ".day{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08);padding:12px 14px;margin-bottom:12px}" +
  ".day h2{font-size:17px;margin:0 0 6px}.it{display:flex;gap:10px;padding:7px 0;border-top:1px solid #eee}.it:first-of-type{border-top:0}" +
  ".tm{flex:0 0 58px;color:#5d6657;font-size:14px;padding-top:1px}.bd{flex:1 1 auto;min-width:0}" +
  ".k{display:inline-block;font-size:12px;font-weight:700;border-radius:5px;padding:1px 6px;margin-right:6px;vertical-align:1px}" +
  ".out{background:#fde2e1;color:#9b1c1c}.in{background:#dcf2dc;color:#1d6b2a}.gs{background:#e3e9fb;color:#2a4a9b}" +
  ".fl{display:inline-block;font-size:12px;background:#fff3c4;color:#7a5a00;border-radius:5px;padding:1px 6px;margin:3px 4px 0 0}" +
  ".note{background:#fff8dc;border-left:3px solid #e0b100;border-radius:4px;padding:5px 8px;margin-top:5px;font-size:14px;white-space:pre-wrap}" +
  ".quiet{color:#5d6657;font-size:14px;margin:4px 2px 16px}.foot{color:#5d6657;font-size:13px;margin-top:20px}" +
  ".foot a{color:inherit}";

function page(title, body) {
  return "<!doctype html><html lang=\"en-GB\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<meta name=\"robots\" content=\"noindex,nofollow\"><title>" + esc(title) + "</title><style>" + STYLE + "</style></head><body><main>" + body + "</main></body></html>";
}
function message(status, text) {
  return { statusCode: status, headers: HEADERS, body: page("Changeover plan", "<h1>Changeover plan</h1><p>" + esc(text) + "</p>" +
    "<p class=\"foot\">Hawthbush Farm · <a href=\"tel:+441825212020\">01825 212020</a></p>") };
}

const KIND_LABEL = { out: ["Out", "out"], in: ["In", "in"], event: ["Grain Store", "gs"], box: ["Grain Store", "gs"] };

// The page for a week of summaryItems() days (exported for the tests).
function render(days, nowLabel) {
  const busy = days.filter(function (d) { return d.items.length; });
  const quiet = days.filter(function (d) { return !d.items.length; });
  let h = "<h1>Changeover plan</h1><div class=\"sub\">" + esc(P.dayLong(days[0].day)) + " to " + esc(P.dayLong(days[days.length - 1].day)) +
    " · as of " + esc(nowLabel) + "</div>";
  if (!busy.length) h += "<div class=\"day\">Nothing booked in these " + days.length + " days.</div>";
  busy.forEach(function (d) {
    h += "<section class=\"day\"><h2>" + esc(P.dayLong(d.day)) + "</h2>";
    d.items.forEach(function (it) {
      const k = KIND_LABEL[it.kind] || ["", "gs"];
      h += "<div class=\"it\"><div class=\"tm\">" + esc(it.time || "") + "</div><div class=\"bd\">" +
        "<span class=\"k " + k[1] + "\">" + esc(k[0]) + "</span>" + esc(it.text);
      const flags = (it.flags || []).slice();
      if (it.eta) flags.push("arriving " + it.eta);
      if (flags.length) h += "<div>" + flags.map(function (f) { return "<span class=\"fl\">" + esc(f) + "</span>"; }).join("") + "</div>";
      if (it.note) h += "<div class=\"note\">" + esc(it.note) + "</div>";
      h += "</div></div>";
    });
    h += "</section>";
  });
  if (busy.length && quiet.length) {
    h += "<div class=\"quiet\">Nothing booked: " + esc(quiet.map(function (d) { return P.dayShort(d.day); }).join(", ")) + ".</div>";
  }
  h += "<p class=\"foot\">Times are the standard check-out and check-in times unless the booking says otherwise. " +
    "Sign off cleans in the housekeeping app as usual. Questions? <a href=\"tel:+441825212020\">01825 212020</a></p>";
  return h;
}

async function appData(key) {
  const sk = process.env.SUPABASE_SERVICE_KEY;
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data?key=eq." + encodeURIComponent(key) + "&select=value",
    { headers: { "apikey": sk, "Authorization": "Bearer " + sk } });
  if (!res.ok) throw new Error(key + " " + res.status);
  const rows = await res.json();
  return rows && rows[0] ? rows[0].value : null;
}

exports.handler = async function (event) {
  const q = (event && event.queryStringParameters) || {};
  const secret = process.env.HBF_ADMIN_TOKEN;
  const sent = T.planLinkDay(String(q.s || ""), secret);
  if (!sent) return message(404, "This link isn't right. Please use the button on the latest changeover WhatsApp.");
  const now = new Date();
  const today = P.londonDate(now);
  if (today > P.addDays(sent, T.PLAN_LINK_DAYS)) return message(410, "This link has expired. Please use the button on the latest changeover WhatsApp.");
  if (!process.env.SUPABASE_SERVICE_KEY) return message(503, "Please try again in a moment.");
  try {
    const sk = process.env.SUPABASE_SERVICE_KEY;
    const until = new Date(now.getTime() + (PAGE_DAYS + 1) * 864e5).toISOString();
    const bx = await fetch(SUPABASE_URL + "/rest/v1/box_events?status=neq.draft&starts_at=gte." + today +
      "&starts_at=lte." + encodeURIComponent(until) + "&select=id,name,status,starts_at",
      { headers: { "apikey": sk, "Authorization": "Bearer " + sk } });
    if (!bx.ok) throw new Error("box_events " + bx.status);
    const input = {
      accom: (await appData("hbf_accom_v1")) || [],
      properties: (await appData("hbf_properties_v1")) || [],
      events: (await appData("hawthbush_bookings_v6")) || [],
      setups: (await appData("hbf_setup_cleans_v1")) || [],
      boxEvents: await bx.json()
    };
    const days = P.summaryItems(input, today, PAGE_DAYS);
    const lp = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", minute: "2-digit", hour12: true, weekday: "short" }).format(now);
    return { statusCode: 200, headers: HEADERS, body: page("Changeover plan", render(days, lp)) };
  } catch (e) {
    console.error("[hk-plan] " + (e && e.message));
    // Never a short plan that looks complete: a failed read is an error.
    return message(503, "The plan couldn't be loaded just now. Please try again in a moment.");
  }
};

exports._test = { render: render, page: page, PAGE_DAYS: PAGE_DAYS };
