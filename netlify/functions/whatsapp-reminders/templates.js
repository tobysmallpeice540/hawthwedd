// netlify/functions/whatsapp-reminders/templates.js
//
// The WhatsApp templates the app sends, in one place: whatsapp-send.js
// submits them to Meta and lists them on Settings → WhatsApp, and
// whatsapp-reminders.js sends them. Pure — no fetch.
//
// Wording is written with NAMED merge fields ({{guestName}}), which is what
// the office edits on the WhatsApp page. Meta only knows numbered ones
// ({{1}}, {{2}}…), so on submission the named fields are numbered in the order
// they first appear, and that order is stored with what was submitted
// (app_data hbf_whatsapp_submitted_v1). Sending always fills the numbers in
// the order of the version Meta has — never of text edited since, which Meta
// has not seen.
//
// Meta's rules this enforces: a body of at most 1,024 characters; it may not
// start or end with a merge field; every field must be one this template
// knows. Values sent later may not contain line breaks (cleanParam).
//
// The footer and button are fixed per template: the footer (Toby, 29 Oct) says
// replies go to email; 31 Oct, plus a number to ring if urgent. Meta allows a
// footer of 60 characters at most, so Toby's fuller wording is shortened
// (his choice of the two short versions).

"use strict";

const FOOTER = "Replies read in office hours. Urgent? Call 01825 212020";
const APP_URL = "https://hawthbushfarm.netlify.app/";

// The plan page behind the changeover summary's button (hk-plan.js):
//   https://hawthbushfarm.netlify.app/plan/<from day>-<key>
// key = HMAC("hk-plan:<from day>", HBF_ADMIN_TOKEN), 16 characters, so the
// link can't be guessed, and it stops working PLAN_LINK_DAYS after the day it
// was sent — it carries guests' surnames and the notes to housekeepers.
const PLAN_LINK_DAYS = 14;
function planKey(from, secret) {
  return require("crypto").createHmac("sha256", String(secret || "")).update("hk-plan:" + from).digest("base64url").slice(0, 16);
}
function planSuffix(from, secret) { return from + "-" + planKey(from, secret); }
function planUrl(from, secret) { return APP_URL + "plan/" + planSuffix(from, secret); }
// The day a link was sent, if its key is right; else null.
function planLinkDay(suffix, secret) {
  const m = /^(\d{4}-\d{2}-\d{2})-([A-Za-z0-9_-]{16})$/.exec(String(suffix || ""));
  if (!m || !secret) return null;
  const want = Buffer.from(planKey(m[1], secret)), got = Buffer.from(m[2]);
  return want.length === got.length && require("crypto").timingSafeEqual(want, got) ? m[1] : null;
}

const TEMPLATES = {
  checklist_live: {
    label: "Checklist is live",
    audience: "Staff (named on a checklist item)",
    when: "When a checklist opens that has items for a named person — one per person per list.",
    category: "UTILITY", language: "en_GB",
    fields: [
      { key: "name", label: "Their first name", example: "Rosanna" },
      { key: "list", label: "The checklist", example: "Arrival – Emma Juner letting" },
      { key: "count", label: "How many items", example: "3 items" },
      { key: "due", label: "When the first is due", example: "3:00pm today" },
      { key: "items", label: "Their items", example: "Welcome hamper · Heating on · Lights on" }
    ],
    // No list of items (31 Oct, Toby): they log in to see them.
    body: "Hi {{name}}, the {{list}} checklist is now live in the Hawthbush Farm app. You have {{count}} on it, the first due by {{due}}. Please log in to see them, and tick them off as you go.",
    button: { text: "Open the app", url: APP_URL }
  },
  checklist_overdue: {
    label: "Checklist items overdue",
    audience: "Staff (named on a checklist item)",
    when: "When a named person's items on a list go past their due time — one per person per list.",
    category: "UTILITY", language: "en_GB",
    fields: [
      { key: "name", label: "Their first name", example: "Rosanna" },
      { key: "list", label: "The checklist", example: "Arrival – Emma Juner letting" },
      { key: "count", label: "How many are overdue", example: "2 items" },
      { key: "items", label: "The overdue items", example: "Welcome hamper · Heating on" }
    ],
    body: "Hi {{name}}, {{count}} on the {{list}} checklist are now overdue: {{items}}. Please tick them off in the Hawthbush Farm app once done.",
    button: { text: "Open the app", url: APP_URL }
  },
  changeover_summary: {
    label: "Weekly changeover summary",
    audience: "Housekeepers (the numbers set below)",
    when: "Once a week, on the day and hour set below: the next 7 days of check-outs, check-ins and events (busy days only), and a button to the full plan for 10 days, with times and notes.",
    category: "UTILITY", language: "en_GB",
    // One field for the whole week (31 Oct, Toby): a merge field can't hold a
    // line break, and ten day fields left quiet days in and risked Meta
    // refusing a template so thick with fields. The button opens the plan
    // page (hk-plan.js), laid out properly, one line per thing.
    fields: [
      { key: "name", label: "Their first name", example: "Karina" },
      { key: "week", label: "The week, busy days only", example: "Sun 1 Nov – Smith out of Hamlet; Jones into Hamlet (cot please); Grain Store: Smith wedding | Mon 2 Nov – Jones out of Amly | Thu 5 Nov – Patel into Glamping (extra clean) | Sat 7 Nov – Grain Store: Supper club 7:30pm" }
    ],
    body: "Hi {{name}}, here is the Hawthbush Farm changeover plan for the next 7 days.\n\n{{week}}\n\nTap the button below for the full plan for the next 10 days, with times and notes. It updates if anything changes.",
    // The link ends in a per-send suffix (planSuffix): Meta's {{1}} on a URL
    // button, filled at send time.
    button: { text: "View the plan", url: APP_URL + "plan/{{1}}", example: APP_URL + "plan/2026-11-01-AbCdEfGh12345678" }
  },
  pre_arrival: {
    label: "Pre-arrival (guests)",
    audience: "Lettings guests who agreed to WhatsApp",
    when: "On the day and at the hour set on the Setup tab (standard: 9am on the arrival day). The guest taps a button to say roughly when they will arrive; the answer is saved on the booking.",
    category: "UTILITY", language: "en_GB",
    fields: [
      { key: "guestName", label: "Guest's first name", example: "Emma" },
      { key: "property", label: "Where they are staying", example: "The Hamlet" },
      { key: "gateCode", label: "Gate code (Setup tab)", example: "1234" },
      { key: "arrivalPack", label: "Arrival pack link (Setup tab, per property)", example: "https://www.hawthbushfarm.co.uk/hamlet-arrival" },
      { key: "checkInTime", label: "Check-in time", example: "4:00pm" },
      { key: "checkOutDate", label: "Check-out day", example: "Monday 2 November" },
      { key: "checkOutTime", label: "Check-out time", example: "10:00am" },
      { key: "nights", label: "Nights", example: "3 nights" },
      { key: "bookingRef", label: "Booking reference", example: "A12345" }
    ],
    // Toby's wording, 30 Oct; a line break after the name, 31 Oct. WhatsApp
    // always puts buttons at the very bottom, so the sign-off comes before
    // the question and the question sits right above the buttons (31 Oct).
    body: "Hi {{guestName}},\nWe're looking forward to seeing you at {{property}} later today. The gate code is {{gateCode}} — please give it to everyone in your group. Your arrival pack is here: {{arrivalPack}}\n\n" +
      "All the best,\nRosanna\n\n" +
      "It would be great if you could let us know roughly when the first of your party will arrive — just tap a button below.",
    // Its own footer (31 Oct, Toby): a tap is saved on the booking at once,
    // so "replies read in office hours" would mislead right above the buttons.
    footer: "Urgent? Call 01825 212020",
    button: null,
    // Tap-to-answer buttons (at most 25 characters each). Their order is what
    // the webhook reads back, so a change here is a change of meaning: add at
    // the end, never reorder.
    quickReplies: ["Before 6pm", "6pm to 9pm", "After 9pm"]
  }
};

const FIELD_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

// Check a body against its template. Returns { ok, error, order } — order is
// the field keys in first-appearance order.
function checkBody(name, body) {
  const def = TEMPLATES[name];
  if (!def) return { ok: false, error: "Unknown template." };
  const text = String(body || "");
  if (!text.trim()) return { ok: false, error: "The message is empty." };
  if (text.length > 1024) return { ok: false, error: "WhatsApp allows 1,024 characters; this is " + text.length + "." };
  const known = {};
  def.fields.forEach(function (f) { known[f.key] = true; });
  const order = [];
  let m, bad = null;
  FIELD_RE.lastIndex = 0;
  while ((m = FIELD_RE.exec(text))) {
    if (!known[m[1]]) { bad = m[1]; break; }
    if (order.indexOf(m[1]) === -1) order.push(m[1]);
  }
  if (bad) return { ok: false, error: "{{" + bad + "}} isn't a merge field this message knows." };
  if (/^\s*\{\{/.test(text)) return { ok: false, error: "WhatsApp won't accept a message that starts with a merge field." };
  if (/\}\}\s*[.!?]?\s*$/.test(text)) return { ok: false, error: "WhatsApp won't accept a message that ends with a merge field — add a few words after it." };
  if (/\{\{[^}]*\}\}\s*\{\{/.test(text)) return { ok: false, error: "Two merge fields side by side need some words between them." };
  return { ok: true, order: order };
}

// Named → numbered, for Meta.
function toNumbered(body, order) {
  return String(body).replace(FIELD_RE, function (all, key) { return "{{" + (order.indexOf(key) + 1) + "}}"; });
}

// The components Meta wants, for a body that has passed checkBody.
function components(name, body) {
  const def = TEMPLATES[name];
  const chk = checkBody(name, body);
  if (!chk.ok) throw new Error(chk.error);
  const examples = chk.order.map(function (k) {
    return def.fields.filter(function (f) { return f.key === k; })[0].example;
  });
  const bodyComp = { type: "BODY", text: toNumbered(body, chk.order) };
  if (examples.length) bodyComp.example = { body_text: [examples] };
  const out = [bodyComp, { type: "FOOTER", text: footerOf(name) }];
  const buttons = [];
  if (def.button) {
    const b = { type: "URL", text: def.button.text, url: def.button.url };
    if (def.button.example) b.example = [def.button.example];
    buttons.push(b);
  }
  (def.quickReplies || []).forEach(function (t) { buttons.push({ type: "QUICK_REPLY", text: t }); });
  if (buttons.length) out.push({ type: "BUTTONS", buttons: buttons });
  return { components: out, order: chk.order };
}

// The footer a template carries: its own, else the shared one.
function footerOf(name) {
  const def = TEMPLATES[name];
  return (def && def.footer) || FOOTER;
}

// WhatsApp refuses values with a line break, a tab or more than four spaces
// in a row; it also refuses an empty value.
function cleanParam(s, max) {
  let t = String(s == null ? "" : s).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  if (max && t.length > max) t = t.slice(0, max - 1).trimEnd() + "…";
  return t || "—";
}

// What the recipient reads: the submitted wording with the values in.
function render(body, values) {
  return String(body || "").replace(FIELD_RE, function (all, key) { return values[key] != null ? String(values[key]) : all; });
}

// The order to send values in: the submitted version's, else the default
// wording's (a template made on Meta by hand before this existed).
function sendOrder(name, submitted) {
  if (submitted && Array.isArray(submitted.order) && submitted.order.length) return submitted.order;
  const chk = checkBody(name, TEMPLATES[name].body);
  return chk.order || [];
}

// The buttons as the guest sees them, for the page's preview.
function buttonLabels(name) {
  const def = TEMPLATES[name];
  return (def.button ? [def.button.text] : []).concat(def.quickReplies || []);
}

// A tapped quick reply comes back with the payload we sent:
// "eta|<booking id>@<arrival day>|<button index>".
function parseEtaPayload(payload) {
  const m = /^eta\|(.+)@(\d{4}-\d{2}-\d{2})\|(\d+)$/.exec(String(payload || ""));
  if (!m) return null;
  const label = (TEMPLATES.pre_arrival.quickReplies || [])[Number(m[3])];
  return label ? { bookingId: m[1], date: m[2], index: Number(m[3]), label: label } : null;
}

// The fixed link to the arrival pack attached to a lettings email template
// (served by arrival-pack.js). The key is an HMAC of the template id (and the
// property, for a property's own pack) with HBF_ADMIN_TOKEN: unguessable, and
// unchanged until that token is rotated.
//   /pack/<template>/<key>             the pack for every property
//   /pack/<template>/<key>/<property>  that property's pack (31 Oct, Toby:
//                                      Hamlet, Amly and Glamping each have one)
const SITE_ORIGIN = "https://hawthbushfarm.netlify.app";
function packKey(templateId, secret, propertyId) {
  const what = "arrival-pack:" + templateId + (propertyId ? "/" + propertyId : "");
  return require("crypto").createHmac("sha256", String(secret || "")).update(what).digest("base64url").slice(0, 16);
}
function packUrl(templateId, secret, propertyId) {
  return SITE_ORIGIN + "/pack/" + encodeURIComponent(templateId) + "/" + packKey(templateId, secret, propertyId)
    + (propertyId ? "/" + encodeURIComponent(propertyId) : "");
}

// An email template's attachments can each be marked for one kind of booking
// (`for`; blank = every booking): a property id ("hamlet", "amly",
// "glamping"), or on the Wedding/Event template a kind of event
// ("event-wedding", "event-party", "event-celebration", "event-other").
// A booking gets the unmarked ones plus those marked for any of its tags.
function attachmentsFor(tmpl, tags) {
  const ids = (tags || []).map(String);
  return ((tmpl && tmpl.attachments) || []).filter(function (a) {
    return a && (!a.for || ids.indexOf(String(a.for)) >= 0);
  });
}
// Which attachment a hosted link serves: the one marked for that tag, else
// the first for everyone. With no tag: the first for everyone, else none.
function packAttachment(tmpl, tag) {
  const atts = ((tmpl && tmpl.attachments) || []).filter(Boolean);
  const own = tag ? atts.filter(function (a) { return String(a.for || "") === String(tag); })[0] : null;
  return own || atts.filter(function (a) { return !a.for; })[0] || null;
}

// The kinds of event, as the checklists group them (checklists/plan.js).
const EVENT_KINDS = [["wedding", "Weddings"], ["party", "Parties"], ["celebration", "Celebrations of life"], ["other", "Other events"]];
function eventKindOf(ev) {
  const t = String((ev && ev.eventType) || "");
  if (/wedding/i.test(t)) return "wedding";
  if (/party/i.test(t)) return "party";
  if (/wake|celebration|funeral|memorial/i.test(t)) return "celebration";
  return "other";
}
// A letting gets the Wedding/Event arrival email when it is a Wedding booking
// or linked to a farm event (the same test as the wedding check-in times).
function usesEventTemplate(b) {
  return !!(b && (b.bookingType === "Wedding" || b.linkedEventId));
}
// A booking's tags for choosing attachments and packs: its event's kind (the
// linked farm event's type; a Wedding booking with no link is a wedding),
// then its properties. `stays` defaults to every stay.
function packTags(b, events, stays) {
  const tags = [];
  if (usesEventTemplate(b)) {
    const ev = b.linkedEventId ? (events || []).filter(function (e) { return e && String(e.id) === String(b.linkedEventId); })[0] : null;
    tags.push("event-" + (ev ? eventKindOf(ev) : "wedding"));
  }
  const ss = stays || ((b && b.stays && b.stays.length) ? b.stays : [b || {}]);
  ss.forEach(function (s) { const p = s && s.propertyId; if (p && tags.indexOf(String(p)) < 0) tags.push(String(p)); });
  return tags;
}

const ARRIVAL_TEMPLATES = ["arrival_general", "arrival_event"];
// The hosted links for the two arrival email templates:
//   { arrival_general: { "": url, hamlet: url, … }, arrival_event: { "": url } }
// "" is there only when the template has a pack for every property.
function hostedPacks(emailTemplates, secret) {
  const out = {};
  if (!secret) return out;
  (emailTemplates || []).forEach(function (t) {
    if (!t || ARRIVAL_TEMPLATES.indexOf(t.id) < 0) return;
    const links = {};
    (t.attachments || []).forEach(function (a) {
      if (!a) return;
      const p = String(a.for || "");
      if (!(p in links)) links[p] = packUrl(t.id, secret, p || undefined);
    });
    if (Object.keys(links).length) out[t.id] = links;
  });
  return out;
}
// The hosted pack for a booking: the arrival template that booking's email
// uses (Wedding/Event for weddings and event-linked lets), its pack for the
// first of the booking's tags that has one, else its pack for everyone; then
// the other template likewise.
function pickHostedPack(hosted, useEvent, tags) {
  const order = useEvent ? ["arrival_event", "arrival_general"] : ["arrival_general", "arrival_event"];
  for (let i = 0; i < order.length; i++) {
    const links = (hosted || {})[order[i]];
    if (!links) continue;
    for (let j = 0; j < (tags || []).length; j++) if (links[tags[j]]) return links[tags[j]];
    if (links[""]) return links[""];
  }
  return "";
}

module.exports = { TEMPLATES, FOOTER, footerOf, PLAN_LINK_DAYS, planKey, planSuffix, planUrl, planLinkDay, buttonLabels, parseEtaPayload, packKey, packUrl, hostedPacks, pickHostedPack, attachmentsFor, packAttachment, ARRIVAL_TEMPLATES, EVENT_KINDS, eventKindOf, usesEventTemplate, packTags, checkBody, toNumbered, components, cleanParam, render, sendOrder };
