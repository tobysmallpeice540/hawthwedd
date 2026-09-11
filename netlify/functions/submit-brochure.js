// netlify/functions/submit-brochure.js
//
// Brochure requests from the website.
//
//   POST /.netlify/functions/submit-brochure
//   Body: { email, name?, guests, years:[…], types:[…], website? }
//
//     · records the request in hbf_brochure_requests_v1
//     · creates (or updates) an enquiry in hbf_enquiries_v1 at temperature
//       "brochure"
//     · emails the requester the brochure link plus month-by-month
//       availability for exactly the years and types they ticked
//     · logs that email to hbf_email_log_v1, so it shows in Recent Automated
//       Emails like every other automated send
//     · notifies the office
//
//   GET /.netlify/functions/submit-brochure?preview=1&years=2027&types=peak_weekend
//     Renders the same email without sending, writing or recording anything.
//     This is what the Settings preview shows — one implementation of the
//     availability rules, not two.
//
// Required env vars: SUPABASE_SERVICE_KEY, RESEND_API_KEY

const SUPABASE_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
// The service key, not the anon key. Server-side code has no business holding
// the same credential the public pages carry, and app_data has row level
// security with no policies. No fallback: a missing variable should fail
// loudly rather than quietly reopen what that closes.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;

const REQUESTS_KEY  = "hbf_brochure_requests_v1";
const SETTINGS_KEY  = "hbf_brochure_settings_v1";
const ENQUIRIES_KEY = "hbf_enquiries_v1";
const EVENTS_KEY    = "hawthbush_bookings_v6";
const EMAIL_LOG_KEY = "hbf_email_log_v1";
const TERMS_KEY     = "hbf_terms_v1";

const FROM_EMAIL   = "hello@hawthbushfarm.co.uk";
// What the recipient sees in their inbox. Without a display name, mail clients
// fall back to the local part of the address — so everything arrived from
// "hello", which tells nobody anything. FROM_EMAIL itself stays a bare address
// because the footer uses it for a mailto: link.
const FROM_HEADER  = "Hawthbush Farm <" + FROM_EMAIL + ">";
const SITE_ORIGIN  = "https://hawthbushfarm.netlify.app";
// Returned with every response so the app can show which version of this
// function actually answered — the quickest way to tell a code problem from a
// "not deployed yet" problem.
const FN_BUILD     = "2026-09-11a";

// Two different people filling the form in at once is normal. The same address
// twice inside this window is a double-click or a refresh, and a second email
// saying the same thing helps nobody.
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Content-Type": "application/json",
};

// ─── What the form offers ────────────────────────────────────────────────────
// The ids are what the browser posts; the labels are what the office and the
// requester read. Anything not in here is refused rather than stored, so a
// tampered form can't write arbitrary text into the enquiry list.
const GUEST_BANDS = {
  "under60":  "Under 60 guests",
  "60to120":  "60–120 guests",
  "over120":  "Over 120 guests",
};
const TYPES = {
  peak_weekend: { label: "Peak weekend", season: "peak",    slots: "weekend" },
  peak_midweek: { label: "Peak midweek", season: "peak",    slots: "midweek" },
  off_peak:     { label: "Off peak",     season: "offpeak", slots: null      },  // slots from settings
};
const TYPE_ORDER = ["peak_weekend", "peak_midweek", "off_peak"];

// Statuses that release the date again. Everything else — "Confirmed",
// "Holding", and any status added later that nobody remembered to list here —
// takes it. "Holding" counting is the point: a date under offer is not a date
// to advertise, and the cost of being wrong this way is an enquiry told a
// month is full when it isn't. The cost the other way is two couples chasing
// one Saturday.
const FREE_STATUSES = ["cancelled", "declined", "lost"];

const DEFAULT_SETTINGS = {
  enabled: true,
  brochureUrl: "https://www.hawthbushfarm.co.uk/brochure",
  notifyEmail: "hello@hawthbushfarm.co.uk",
  subject: "Your Hawthbush Farm brochure",
  body:
    "Hello {{name}},\n\n" +
    "Thank you for getting in touch — it is lovely to hear from you.\n\n" +
    "Our brochure is here: {{brochureUrl}}\n\n" +
    "{{availability}}\n\n" +
    "Dates move quickly, so if a month above looks right do say and we will pencil it in while you come and see us.\n\n" +
    "Just reply to this email and we will find a time to show you around.\n\n" +
    "With very best wishes,\nHawthbush Farm",
  peakStart: 5,             // May
  peakEnd: 9,               // September — inclusive. Everything else is off peak.
  hideWithinMonths: 3,      // Nothing sooner than this is shown at all.
  goodThreshold: 3,         // This many free or more reads as good availability.
  offPeakSlots: "weekend",  // "weekend" | "both" — what an off-peak month counts.
};

const MONTH_NAMES = ["January","February","March","April","May","June",
                     "July","August","September","October","November","December"];

// ─── Supabase ────────────────────────────────────────────────────────────────
async function sbGet(key) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data?key=eq." + key + "&select=value", {
    headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY }
  });
  if (!res.ok) throw new Error("sbGet " + key + " failed: " + res.status);
  const rows = await res.json();
  return (Array.isArray(rows) && rows[0]) ? rows[0].value : null;
}

async function sbSet(key, value) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/app_data", {
    method: "POST",
    headers: {
      "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates"
    },
    body: JSON.stringify({ key: key, value: value }),
  });
  if (!res.ok) throw new Error("sbSet " + key + " failed: " + await res.text());
}

// Re-read immediately before writing, and append to what is actually there.
// Writing an array back from a snapshot taken earlier in the request is how
// records have been lost in this codebase before — see CLAUDE.md.
async function sbAppend(key, change) {
  const current = (await sbGet(key)) || [];
  const list = Array.isArray(current) ? current : [];
  await sbSet(key, change(list).list);
}

async function logEmail(subject, to, type, refId, bodyText) {
  try {
    const log = (await sbGet(EMAIL_LOG_KEY)) || [];
    log.push({
      id: "el" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      sentAt: new Date().toISOString(),
      subject: subject, to: to, template: type, bookingId: refId,
      body: String(bodyText || "").slice(0, 8000)
    });
    await sbSet(EMAIL_LOG_KEY, log.slice(-500));
  } catch (e) { console.error("logEmail failed:", e.message); }
}

// ─── Small helpers ───────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeHtmlBr(s) { return escapeHtml(s).replace(/\n/g, "<br>"); }

function ymd(d) {
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

function fillTemplate(str, tokens) {
  return String(str || "").replace(/\{\{(\w+)\}\}/g, function (m, key) {
    return (tokens[key] !== undefined && tokens[key] !== null) ? String(tokens[key]) : "";
  });
}

function settingsWith(saved) {
  const s = Object.assign({}, DEFAULT_SETTINGS, saved || {});
  // A setting saved as a string ("3" from a number input) must not turn a
  // comparison into string comparison further down.
  s.peakStart        = Math.min(12, Math.max(1, Number(s.peakStart) || DEFAULT_SETTINGS.peakStart));
  s.peakEnd          = Math.min(12, Math.max(1, Number(s.peakEnd)   || DEFAULT_SETTINGS.peakEnd));
  s.hideWithinMonths = Math.max(0, Number(s.hideWithinMonths) || 0);
  s.goodThreshold    = Math.max(1, Number(s.goodThreshold) || DEFAULT_SETTINGS.goodThreshold);
  if (s.offPeakSlots !== "both") s.offPeakSlots = "weekend";
  return s;
}

// Peak runs peakStart..peakEnd inclusive, and wraps if somebody ever sets it
// to, say, November–February. Everything outside it is off peak.
function isPeakMonth(m1, s) {
  if (s.peakStart <= s.peakEnd) return m1 >= s.peakStart && m1 <= s.peakEnd;
  return m1 >= s.peakStart || m1 <= s.peakEnd;
}

// ─── Availability ────────────────────────────────────────────────────────────
//
// Two kinds of slot, one of each per week:
//
//   weekend — Friday, Saturday and Sunday, named by its Saturday. A wedding on
//             any of the three takes the weekend; there is only one set of
//             barns and one team.
//   midweek — Monday to Thursday, named by its Monday. Same rule: one midweek
//             wedding per week, so a booked Wednesday takes the week.
//
// A slot belongs to the month its Saturday (or Monday) falls in, so a weekend
// straddling the turn of a month is counted once, not twice.

function weekendSlots(year, monthIdx) {
  const slots = [];
  const d = new Date(year, monthIdx, 1);
  while (d.getDay() !== 6) d.setDate(d.getDate() + 1);          // first Saturday
  while (d.getMonth() === monthIdx) {
    const fri = new Date(d); fri.setDate(d.getDate() - 1);
    const sun = new Date(d); sun.setDate(d.getDate() + 1);
    slots.push([ymd(fri), ymd(d), ymd(sun)]);
    d.setDate(d.getDate() + 7);
  }
  return slots;
}

function midweekSlots(year, monthIdx) {
  const slots = [];
  const d = new Date(year, monthIdx, 1);
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1);          // first Monday
  while (d.getMonth() === monthIdx) {
    const days = [];
    for (let i = 0; i < 4; i++) {                                // Mon–Thu
      const x = new Date(d); x.setDate(d.getDate() + i);
      days.push(ymd(x));
    }
    slots.push(days);
    d.setDate(d.getDate() + 7);
  }
  return slots;
}

// Every date an event occupies. An event with an endDate occupies the whole
// span; everything else is its single date.
function bookedDateSet(events) {
  const taken = new Set();
  (events || []).forEach(function (ev) {
    if (!ev || !ev.date) return;
    const status = String(ev.status || "confirmed").trim().toLowerCase();
    if (FREE_STATUSES.indexOf(status) !== -1) return;
    const start = String(ev.date).slice(0, 10);
    const end   = ev.endDate ? String(ev.endDate).slice(0, 10) : start;
    const d = new Date(start + "T00:00:00");
    const last = new Date((end >= start ? end : start) + "T00:00:00");
    if (isNaN(d) || isNaN(last)) return;
    let guard = 0;
    while (d <= last && guard++ < 400) {
      taken.add(ymd(d));
      d.setDate(d.getDate() + 1);
    }
  });
  return taken;
}

// Months to show for one year and one type, oldest first, with anything inside
// the blackout window left out entirely.
function monthsFor(year, typeId, s, now) {
  const type = TYPES[typeId];
  if (!type) return [];

  // First day of the first month we are willing to talk about.
  const cutoff = new Date(now.getFullYear(), now.getMonth() + s.hideWithinMonths, 1);

  const out = [];
  for (let m = 0; m < 12; m++) {
    const peak = isPeakMonth(m + 1, s);
    if (type.season === "peak" && !peak) continue;
    if (type.season === "offpeak" && peak) continue;
    if (new Date(year, m, 1) < cutoff) continue;
    out.push(m);
  }
  return out;
}

function monthAvailability(year, monthIdx, typeId, s, taken) {
  const type = TYPES[typeId];
  const kinds = type.slots
    ? [type.slots]
    : (s.offPeakSlots === "both" ? ["weekend", "midweek"] : ["weekend"]);

  let total = 0, free = 0;
  kinds.forEach(function (kind) {
    const slots = kind === "weekend" ? weekendSlots(year, monthIdx) : midweekSlots(year, monthIdx);
    slots.forEach(function (days) {
      total++;
      const busy = days.some(function (ds) { return taken.has(ds); });
      if (!busy) free++;
    });
  });

  const state = free === 0 ? "booked" : (free < s.goodThreshold ? "limited" : "good");
  return { month: monthIdx, name: MONTH_NAMES[monthIdx], free: free, total: total, state: state };
}

function buildAvailability(years, types, s, events, now) {
  const taken = bookedDateSet(events);
  const blocks = [];
  years.slice().sort().forEach(function (year) {
    types.forEach(function (typeId) {
      const months = monthsFor(year, typeId, s, now).map(function (m) {
        return monthAvailability(year, m, typeId, s, taken);
      });
      blocks.push({ year: year, typeId: typeId, label: TYPES[typeId].label, months: months });
    });
  });
  return blocks;
}

// ─── Email ───────────────────────────────────────────────────────────────────
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

const STATE_STYLE = {
  good:    { bg:"#e8f3ec", border:"#b6d8c3", text:"#22613e", word:"Good availability" },
  limited: { bg:"#fdf3e3", border:"#eed9ae", text:"#8a6114", word:"Limited" },
  booked:  { bg:"#f3f1ee", border:"#e0dad1", text:"#8b8279", word:"Booked" },
};

// The availability block, as a table. Not a grid, not flexbox: Outlook
// supports neither, and this is the part of the email people actually read.
function availabilityHtml(blocks) {
  const live = blocks.filter(function (b) { return b.months.length; });
  if (!live.length) {
    return '<p style="margin:0 0 15px;font-size:15px;line-height:1.65;color:' + BRAND.text + '">' +
      'We have nothing left in the dates you asked about — do reply and we will tell you what else is open.</p>';
  }

  let html = "";
  live.forEach(function (b) {
    html += '<div style="margin:0 0 18px">' +
      '<p style="margin:0 0 8px;font-family:Helvetica,Arial,sans-serif;font-size:12px;letter-spacing:1.4px;' +
      'text-transform:uppercase;font-weight:bold;color:' + BRAND.muted + '">' +
      escapeHtml(b.year + " · " + b.label) + '</p>' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%">';

    b.months.forEach(function (m) {
      const st = STATE_STYLE[m.state];
      html += '<tr><td style="padding:0 0 5px">' +
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;' +
        'background:' + st.bg + ';border:1px solid ' + st.border + ';border-radius:8px">' +
        '<tr>' +
        '<td style="padding:9px 14px;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:' + BRAND.text + '">' +
        escapeHtml(m.name) + '</td>' +
        '<td align="right" style="padding:9px 14px;font-family:Helvetica,Arial,sans-serif;font-size:13px;' +
        'font-weight:bold;color:' + st.text + '">' + st.word + '</td>' +
        '</tr></table></td></tr>';
    });

    html += '</table></div>';
  });

  html += '<p style="margin:0 0 15px;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:' +
    BRAND.muted + '">Availability as at ' +
    new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) +
    '. Dates held for other couples are shown as booked.</p>';
  return html;
}

// Turn the plain-text template body into email HTML: blank lines become
// paragraphs, and any bare URL becomes a link. {{availability}} has already
// been swapped for a marker, because the block it stands for is HTML and the
// rest of the body is escaped — it cannot be substituted in beforehand without
// being escaped along with everything else.
//
// The marker uses control characters nobody can type into the settings box, so
// a template that happens to use the word "availability" is left alone.
const AVAIL_MARKER = "\u0001HBF-AVAILABILITY\u0001";

function linkify(text) {
  return escapeHtmlBr(text).replace(/(https?:\/\/[^\s<]+)/g, function (url) {
    return '<a href="' + url + '" style="color:' + BRAND.text + ';text-decoration:underline">' + url + '</a>';
  });
}

function para(text) {
  return '<p style="margin:0 0 15px;font-size:15px;line-height:1.65;color:' + BRAND.text + '">' +
    linkify(text) + '</p>';
}

function bodyToHtml(bodyText, availHtml) {
  const paras = String(bodyText || "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  return paras.map(function (p) {
    const trimmed = p.trim();
    if (trimmed.indexOf(AVAIL_MARKER) === -1) return trimmed ? para(trimmed) : "";
    // Written mid-paragraph rather than alone on its own line: keep the prose
    // either side and put the block between them, instead of letting the
    // marker itself leak into the email as gibberish.
    return trimmed.split(AVAIL_MARKER).map(function (part, i) {
      return (i === 0 ? "" : availHtml) + (part.trim() ? para(part.trim()) : "");
    }).join("");
  }).join("");
}

function buildEmailHtml(bodyText, availHtml, opts) {
  const o = opts || {};
  let inner = bodyToHtml(bodyText, availHtml);

  if (o.buttonUrl) {
    inner += '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 6px">' +
      '<tr><td align="center" bgcolor="' + BRAND.text + '" style="border-radius:8px">' +
      '<a href="' + o.buttonUrl + '" style="display:inline-block;padding:13px 30px;font-family:Helvetica,Arial,sans-serif;' +
      'font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px">' +
      escapeHtml(o.buttonLabel || "Read the brochure") + '</a></td></tr></table>';
  }

  let terms = "";
  if (o.termsUrl) {
    terms = '<p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:' + BRAND.muted + '">' +
      'Bookings are subject to our <a href="' + o.termsUrl + '" style="color:' + BRAND.muted + '">Terms &amp; Conditions</a>.' +
      '</p>';
  }

  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Hawthbush Farm</title></head>' +
    '<body style="margin:0;padding:0;background:' + BRAND.bg + ';">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + BRAND.bg + ';padding:26px 12px">' +
    '<tr><td align="center">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%">' +
    '<tr><td align="center" style="padding:0 0 20px">' +
    '<a href="' + BRAND.site + '"><img src="' + BRAND.logo + '" alt="Hawthbush Farm" width="110" ' +
    'style="display:block;border:0;width:110px;height:auto"></a>' +
    '</td></tr>' +
    '<tr><td style="background:' + BRAND.panel + ';border:1px solid ' + BRAND.border + ';border-radius:14px;padding:30px 34px;' +
    'font-family:Helvetica,Arial,sans-serif">' + inner + '</td></tr>' +
    '<tr><td align="center" style="padding:20px 16px 0;font-family:Helvetica,Arial,sans-serif">' +
    terms +
    '<p style="margin:0 0 4px;font-size:12px;line-height:1.6;color:' + BRAND.muted + '">' +
    'Hawthbush Farm, Gun Hill, Heathfield, East Sussex &middot; ' +
    '<a href="mailto:' + FROM_EMAIL + '" style="color:' + BRAND.muted + '">' + FROM_EMAIL + '</a></p>' +
    '<p style="margin:0;font-size:12px;color:' + BRAND.muted + '">' +
    '<a href="' + BRAND.site + '" style="color:' + BRAND.muted + '">hawthbushfarm.co.uk</a></p>' +
    '</td></tr></table></td></tr></table></body></html>';
}

// The plain-text twin, which is also what gets stored in the email log so the
// send can be read back in the app.
function availabilityText(blocks) {
  const live = blocks.filter(function (b) { return b.months.length; });
  if (!live.length) return "We have nothing left in the dates you asked about — do reply and we will tell you what else is open.";
  return live.map(function (b) {
    return b.year + " · " + b.label + "\n" + b.months.map(function (m) {
      return "  " + m.name + " — " + STATE_STYLE[m.state].word;
    }).join("\n");
  }).join("\n\n");
}

// The T&C link is only included when terms have actually been written, so a
// blank setting doesn't produce a link to an empty page.
async function getTermsUrl() {
  try {
    const t = await sbGet(TERMS_KEY);
    if (t && String(t.text || "").trim()) return SITE_ORIGIN + "/terms.html";
  } catch (e) { /* a missing T&C must never stop an email going out */ }
  return "";
}

// ─── Input ───────────────────────────────────────────────────────────────────
// Deliberately strict: ids that aren't offered by the form are dropped rather
// than stored, and the years are bounded. Nothing here reaches the enquiry
// list as free text except the name.
function cleanInput(body) {
  const email = String(body.email || "").trim().toLowerCase();
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 200;
  if (!ok) return { error: "Please enter a valid email address." };

  const guests = GUEST_BANDS[body.guests] ? body.guests : "";
  if (!guests) return { error: "Please tell us roughly how many guests you expect." };

  const thisYear = new Date().getFullYear();
  const years = Array.from(new Set((Array.isArray(body.years) ? body.years : [])
    .map(function (y) { return parseInt(y, 10); })
    .filter(function (y) { return y >= thisYear && y <= thisYear + 10; })));
  if (!years.length) return { error: "Please choose at least one year." };

  const types = TYPE_ORDER.filter(function (t) {
    return (Array.isArray(body.types) ? body.types : []).indexOf(t) !== -1;
  });
  if (!types.length) return { error: "Please choose at least one kind of wedding." };

  return {
    email: email,
    name: String(body.name || "").trim().slice(0, 120),
    guests: guests,
    years: years.sort(),
    types: types,
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────
exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };

  // ── Preview (GET) — renders, never writes, never sends ──────────────────
  if (event.httpMethod === "GET") {
    const q = event.queryStringParameters || {};
    if (!q.preview) {
      return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Method not allowed", build: FN_BUILD }) };
    }
    try {
      const s = settingsWith(await sbGet(SETTINGS_KEY));
      const events = (await sbGet(EVENTS_KEY)) || [];
      const thisYear = new Date().getFullYear();
      const years = String(q.years || (thisYear + 1)).split(",")
        .map(function (y) { return parseInt(y, 10); })
        .filter(function (y) { return y >= thisYear && y <= thisYear + 10; });
      const types = TYPE_ORDER.filter(function (t) {
        return String(q.types || "peak_weekend").split(",").indexOf(t) !== -1;
      });
      const rendered = render(s, {
        name: q.name || "",
        email: q.email || "someone@example.com",
        guests: GUEST_BANDS[q.guests] ? q.guests : "60to120",
        years: years.length ? years : [thisYear + 1],
        types: types.length ? types : ["peak_weekend"],
      }, events, new Date(), await getTermsUrl());
      return { statusCode: 200, headers: cors, body: JSON.stringify({
        ok: true, build: FN_BUILD, subject: rendered.subject, html: rendered.html, text: rendered.text
      }) };
    } catch (e) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: String(e.message || e), build: FN_BUILD }) };
    }
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Method not allowed", build: FN_BUILD }) };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Invalid JSON", build: FN_BUILD }) }; }

  // Honeypot. A real person never fills this in because it isn't on screen;
  // a bot fills in everything it finds. Answer 200 so it learns nothing.
  if (String(body.website || "").trim()) {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, build: FN_BUILD }) };
  }

  const input = cleanInput(body);
  if (input.error) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: input.error, build: FN_BUILD }) };
  }

  let settings, events;
  try {
    settings = settingsWith(await sbGet(SETTINGS_KEY));
    events   = (await sbGet(EVENTS_KEY)) || [];
  } catch (e) {
    console.error("Brochure request: read failed:", e.message);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Could not reach the diary just now. Please try again shortly.", build: FN_BUILD }) };
  }

  const now = new Date();
  const request = {
    id: "br_" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
    email: input.email,
    name: input.name,
    guests: input.guests,
    guestsLabel: GUEST_BANDS[input.guests],
    years: input.years,
    types: input.types,
    typeLabels: input.types.map(function (t) { return TYPES[t].label; }),
    source: String(body.source || "Website brochure request").slice(0, 80),
    submittedAt: now.toISOString(),
    emailSent: false,
  };

  // ── Record the request ─────────────────────────────────────────────────
  // Re-read and append, never write back a snapshot. A repeat inside the
  // duplicate window is recorded and then stops here: the office still sees
  // that they asked twice, and nobody gets the same email twice.
  let duplicate = false;
  try {
    await sbAppend(REQUESTS_KEY, function (list) {
      duplicate = list.some(function (r) {
        return r && String(r.email || "").toLowerCase() === input.email &&
          r.submittedAt && (now - new Date(r.submittedAt)) < DUPLICATE_WINDOW_MS;
      });
      request.duplicate = duplicate || undefined;
      return { list: list.concat([request]).slice(-2000) };
    });
  } catch (e) {
    console.error("Brochure request: save failed:", e.message);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Could not save your request. Please try again.", build: FN_BUILD }) };
  }

  if (duplicate) {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, id: request.id, duplicate: true, build: FN_BUILD }) };
  }

  // ── The enquiry ────────────────────────────────────────────────────────
  // An address we already know keeps the enquiry it has — dropping a warm
  // couple back to "brochure" because they asked for the PDF would lose real
  // information. It gains a contact line instead, which is what moves it up
  // the "last contact" column.
  const summary = "Brochure requested — " + GUEST_BANDS[input.guests] + " · " +
    input.years.join(", ") + " · " + request.typeLabels.join(", ");

  let enquiryId = null, enquiryIsNew = false;
  try {
    await sbAppend(ENQUIRIES_KEY, function (list) {
      const idx = list.findIndex(function (e) {
        return e && String(e.email || "").trim().toLowerCase() === input.email;
      });
      if (idx !== -1) {
        const existing = list[idx];
        enquiryId = existing.id;
        const updated = Object.assign({}, existing, {
          contacts: (existing.contacts || []).concat([{
            date: ymd(now), method: "email", note: summary
          }]),
          brochureRequests: (existing.brochureRequests || []).concat([request.id]),
        });
        const copy = list.slice();
        copy[idx] = updated;
        return { list: copy };
      }
      enquiryIsNew = true;
      enquiryId = "enq_" + Date.now();
      return { list: list.concat([{
        id: enquiryId,
        name: input.name || input.email,
        email: input.email,
        phone: "",
        eventType: "Wedding",
        numbers: GUEST_BANDS[input.guests],
        datePreference: input.years.join(", ") + " · " + request.typeLabels.join(", "),
        source: request.source,
        notes: summary,
        temperature: "brochure",
        outcome: "undecided",
        contacts: [{ date: ymd(now), method: "email", note: summary }],
        viewings: [],
        brochureRequests: [request.id],
      }]) };
    });
  } catch (e) {
    // The request is already recorded and the email is still worth sending.
    // Losing the enquiry row is bad; losing the reply as well is worse.
    console.error("Brochure request: enquiry write failed:", e.message);
  }

  // ── The email ──────────────────────────────────────────────────────────
  const termsUrl = await getTermsUrl();
  const rendered = render(settings, input, events, now, termsUrl);

  let sent = false, sendError = "";
  if (settings.enabled === false) {
    sendError = "Brochure emails are switched off in Settings.";
  } else if (!RESEND_KEY) {
    sendError = "RESEND_API_KEY is not set.";
  } else {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM_HEADER, to: input.email, reply_to: FROM_EMAIL,
          subject: rendered.subject, html: rendered.html, text: rendered.text,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      sent = true;
    } catch (e) {
      sendError = String(e.message || e);
      console.error("Brochure email failed:", sendError);
    }
  }

  if (sent) {
    await logEmail(rendered.subject, input.email, "brochure_request", enquiryId, rendered.text);
    // Mark the request as emailed. Re-read again: the enquiry write above may
    // have taken a while and somebody else may have submitted in between.
    try {
      await sbAppend(REQUESTS_KEY, function (list) {
        const copy = list.map(function (r) {
          return (r && r.id === request.id) ? Object.assign({}, r, { emailSent: true, emailSentAt: new Date().toISOString() }) : r;
        });
        return { list: copy };
      });
    } catch (e) { console.error("Brochure request: could not mark as emailed:", e.message); }
  }

  // ── Tell the office ────────────────────────────────────────────────────
  // A write that records something does not tell anyone about it, so this is
  // its own step — and it says plainly whether the requester's email went, so
  // "the row landed but the email did not" never reads as success.
  if (RESEND_KEY && settings.notifyEmail) {
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM_HEADER, to: settings.notifyEmail,
        subject: "Brochure request — " + (input.name || input.email),
        html:
          "<h2 style=\"font-family:Helvetica,Arial,sans-serif\">Brochure request</h2>" +
          "<p><b>Name:</b> " + escapeHtml(input.name || "not given") + "</p>" +
          "<p><b>Email:</b> " + escapeHtml(input.email) + "</p>" +
          "<p><b>Guests:</b> " + escapeHtml(GUEST_BANDS[input.guests]) + "</p>" +
          "<p><b>Years:</b> " + escapeHtml(input.years.join(", ")) + "</p>" +
          "<p><b>Type:</b> " + escapeHtml(request.typeLabels.join(", ")) + "</p>" +
          "<p><b>Enquiry:</b> " + (enquiryIsNew ? "new enquiry created" : "added to the existing enquiry") + "</p>" +
          "<p><b>Brochure email:</b> " + (sent ? "sent" : "NOT SENT — " + escapeHtml(sendError)) + "</p>" +
          "<p><a href=\"" + SITE_ORIGIN + "\" style=\"background:#1e3a2f;color:#fff;padding:10px 20px;border-radius:6px;" +
          "text-decoration:none;font-weight:600;display:inline-block;margin-top:10px;font-family:Helvetica,Arial,sans-serif\">Open the app</a></p>",
      }),
    }).catch(function (e) { console.error("Office notification failed:", e.message); });
  }

  return {
    statusCode: 200,
    headers: cors,
    body: JSON.stringify({ ok: true, id: request.id, emailSent: sent, build: FN_BUILD }),
  };
};

// Subject, HTML and text for one request. Shared by the send and the preview,
// which is the point: the preview in Settings is the email, not a drawing of
// one.
function render(settings, input, events, now, termsUrl) {
  const blocks = buildAvailability(input.years, input.types, settings, events, now);
  const typeLabels = input.types.map(function (t) { return TYPES[t].label; }).join(", ");

  const tokens = {
    name: input.name || "there",
    email: input.email,
    brochureUrl: settings.brochureUrl,
    guests: GUEST_BANDS[input.guests] || "",
    years: input.years.join(", "),
    types: typeLabels,
    availability: AVAIL_MARKER,
  };

  const bodyText = fillTemplate(settings.body, tokens);
  const subject  = fillTemplate(settings.subject, tokens);

  return {
    subject: subject,
    html: buildEmailHtml(bodyText, availabilityHtml(blocks), {
      termsUrl: termsUrl,
      buttonUrl: settings.brochureUrl,
      buttonLabel: "Read the brochure",
    }),
    text: bodyText.split(AVAIL_MARKER).join(availabilityText(blocks)),
    blocks: blocks,
  };
}

// Exported for the test suite. Nothing else imports these.
exports._internals = {
  weekendSlots: weekendSlots,
  midweekSlots: midweekSlots,
  bookedDateSet: bookedDateSet,
  monthsFor: monthsFor,
  monthAvailability: monthAvailability,
  buildAvailability: buildAvailability,
  settingsWith: settingsWith,
  cleanInput: cleanInput,
  render: render,
  DEFAULT_SETTINGS: DEFAULT_SETTINGS,
  TYPES: TYPES,
  GUEST_BANDS: GUEST_BANDS,
};
