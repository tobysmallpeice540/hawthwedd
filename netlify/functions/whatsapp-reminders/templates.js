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
// replies go to email.

"use strict";

const FOOTER = "Replies go to our email, read in office hours";
const APP_URL = "https://hawthbushfarm.netlify.app/";

const DAY_FIELDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (n) {
  return { key: "day" + n, label: "Day " + n, example: n === 1 ? "Sun 1 Nov: Hamlet out, in Jones (cot please) · Grain St: Smith wedding" : "Mon 2 Nov: nothing booked" };
});

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
    body: "Hi {{name}}, the {{list}} checklist is now live in the Hawthbush Farm app. You have {{count}} on it, the first due by {{due}}: {{items}}. Please tick them off as you go.",
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
    when: "Once a week, on the day and hour set below: the next 10 days of check-outs, check-ins and events, with housekeeping notes.",
    category: "UTILITY", language: "en_GB",
    fields: [{ key: "name", label: "Their first name", example: "Karina" }].concat(DAY_FIELDS),
    body: "Hi {{name}}, here is the Hawthbush Farm changeover plan for the next 10 days.\n\n" +
      DAY_FIELDS.map(function (f) { return "• {{" + f.key + "}}"; }).join("\n") +
      "\n\nTimes, full notes and any changes are in the housekeeping app.",
    button: { text: "Open the app", url: APP_URL }
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
    // Toby's wording, 30 Oct.
    body: "Hi {{guestName}}, we're looking forward to seeing you at {{property}} later today. The gate code is {{gateCode}} — please give it to everyone in your group. Your arrival pack is here: {{arrivalPack}}\n\n" +
      "It would be great if you could let us know roughly when the first of your party will arrive — just tap a button below.\n\nAll the best,\nRosanna",
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
  const out = [bodyComp, { type: "FOOTER", text: FOOTER }];
  const buttons = [];
  if (def.button) buttons.push({ type: "URL", text: def.button.text, url: def.button.url });
  (def.quickReplies || []).forEach(function (t) { buttons.push({ type: "QUICK_REPLY", text: t }); });
  if (buttons.length) out.push({ type: "BUTTONS", buttons: buttons });
  return { components: out, order: chk.order };
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

module.exports = { TEMPLATES, FOOTER, buttonLabels, parseEtaPayload, checkBody, toNumbered, components, cleanParam, render, sendOrder };
