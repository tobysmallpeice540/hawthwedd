// Arrival packs by property and by kind of event (31 Oct): an attachment on a
// lettings email template can be marked for one property, or (on the
// Wedding/Event template) one kind of event. The emails attach only the right
// ones, the hosted links serve the right one, the WhatsApp links to it.
// No network: fetch is faked. Run: node tests/arrival-packs-test.cjs
const assert = require("assert");
const path = require("path");
process.env.HBF_ADMIN_TOKEN = "adm";
process.env.SUPABASE_SERVICE_KEY = "svc";
process.env.RESEND_API_KEY = "re_test";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_dummy";
const T = require("../netlify/functions/whatsapp-reminders/templates.js");
const P = require("../netlify/functions/whatsapp-reminders/plan.js");

let n = 0;
const ok = (label, cond, more) => { assert.ok(cond, label + (more ? " — " + more : "")); n++; console.log("  ok   " + label); };

const b64 = (s) => "data:application/pdf;base64," + Buffer.from(s).toString("base64");
const TEMPLATES = [
  { id: "booking_confirmed", subject: "Booked", body: "Hi", attachments: [] },
  { id: "arrival_general", subject: "Arriving {{checkIn}}", body: "Pack: {{arrivalPack}}", triggerDays: 28, triggerDays2: 0, attachments: [
    { name: "general.pdf", dataUrl: b64("GENERAL") },
    { name: "hamlet.pdf", for: "hamlet", dataUrl: b64("HAMLET") },
    { name: "amly.pdf", for: "amly", dataUrl: b64("AMLY") },
    { name: "glamping.pdf", for: "glamping", dataUrl: b64("GLAMPING") }] },
  { id: "arrival_event", subject: "Your event {{checkIn}}", body: "Pack: {{arrivalPack}}", triggerDays: 28, triggerDays2: 0, attachments: [
    { name: "wedding.pdf", for: "event-wedding", dataUrl: b64("WEDDING") },
    { name: "party.pdf", for: "event-party", dataUrl: b64("PARTY") },
    { name: "col.pdf", for: "event-celebration", dataUrl: b64("COL") }] }
];
const EVENTS = [{ id: 7, eventType: "Party" }, { id: 8, eventType: "Celebration of Life" }, { id: 9, eventType: "Wedding (Peak)" }];
const names = (atts) => atts.map((a) => a.name);

console.log("— which attachments a booking gets —");
const tags = (b) => T.packTags(b, EVENTS);
ok("a Hamlet let: the file for everyone and the Hamlet pack",
  JSON.stringify(names(T.attachmentsFor(TEMPLATES[1], tags({ stays: [{ propertyId: "hamlet" }] })))) === '["general.pdf","hamlet.pdf"]');
ok("a let across Amly and Glamping gets both",
  JSON.stringify(names(T.attachmentsFor(TEMPLATES[1], tags({ stays: [{ propertyId: "amly" }, { propertyId: "glamping" }] })))) === '["general.pdf","amly.pdf","glamping.pdf"]');
ok("a let linked to a party: the party pack only", JSON.stringify(names(T.attachmentsFor(TEMPLATES[2], tags({ linkedEventId: 7, stays: [{ propertyId: "hamlet" }] })))) === '["party.pdf"]');
ok("a celebration of life", JSON.stringify(tags({ linkedEventId: 8, propertyId: "amly" })) === '["event-celebration","amly"]');
ok("a Wedding booking with no link counts as a wedding", JSON.stringify(tags({ bookingType: "Wedding", stays: [{ propertyId: "hamlet" }] })) === '["event-wedding","hamlet"]');
ok("a linked event that has gone falls back to a wedding", tags({ linkedEventId: 99 })[0] === "event-wedding");
ok("a standard let has no event tag", JSON.stringify(tags({ stays: [{ propertyId: "glamping" }] })) === '["glamping"]');
ok("event-linked lets use the Wedding/Event template", T.usesEventTemplate({ linkedEventId: 7 }) && T.usesEventTemplate({ bookingType: "Wedding" }) && !T.usesEventTemplate({ bookingType: "" }));
ok("unmarked attachments still go to everyone (older templates)", names(T.attachmentsFor({ attachments: [{ name: "x" }] }, [])).join() === "x");

console.log("— hosted links —");
const hp = T.hostedPacks(TEMPLATES, "adm");
ok("one link per template and tag", JSON.stringify(Object.keys(hp.arrival_general)) === '["","hamlet","amly","glamping"]'
  && JSON.stringify(Object.keys(hp.arrival_event)) === '["event-wedding","event-party","event-celebration"]');
ok("the link for everyone keeps its old address", hp.arrival_general[""] === T.packUrl("arrival_general", "adm") && !/\/pack\/arrival_general\/[^/]+\//.test(hp.arrival_general[""]));
ok("a property's link has the property on the end", /\/pack\/arrival_general\/[\w-]{16}\/hamlet$/.test(hp.arrival_general.hamlet));
ok("keys differ per property", T.packKey("arrival_general", "adm", "hamlet") !== T.packKey("arrival_general", "adm", "amly") && T.packKey("arrival_general", "adm", "hamlet") !== T.packKey("arrival_general", "adm"));
ok("Glamping guest → the Glamping link", T.pickHostedPack(hp, false, ["glamping"]) === hp.arrival_general.glamping);
ok("party guest → the party link", T.pickHostedPack(hp, true, ["event-party", "hamlet"]) === hp.arrival_event["event-party"]);
ok("an 'other' event with no pack of its own and no pack for everyone falls to the General template",
  T.pickHostedPack(hp, true, ["event-other", "amly"]) === hp.arrival_general.amly);
ok("no attachments, no links", JSON.stringify(T.hostedPacks([{ id: "arrival_general", attachments: [] }], "adm")) === "{}");

console.log("— the WhatsApp links to the right pack —");
const day = "2026-11-05";
const props = { hamlet: { id: "hamlet", name: "The Hamlet" }, glamping: { id: "glamping", name: "Glamping" } };
const msgG = P.arrivalMessage({ id: "G1", guestName: "Gina Glamp", phone: "07700900001", stays: [{ propertyId: "glamping", checkIn: day, checkOut: "2026-11-07" }] }, day, props, {}, hp, EVENTS);
ok("Glamping let", msgG.values.arrivalPack === hp.arrival_general.glamping, msgG.values.arrivalPack);
const msgP = P.arrivalMessage({ id: "P1", guestName: "Pat Party", phone: "07700900002", linkedEventId: 7, stays: [{ propertyId: "hamlet", checkIn: day, checkOut: "2026-11-07" }] }, day, props, {}, hp, EVENTS);
ok("a let for a party", msgP.values.arrivalPack === hp.arrival_event["event-party"], msgP.values.arrivalPack);
const msgOwn = P.arrivalMessage({ id: "G2", guestName: "Gina", phone: "07700900001", stays: [{ propertyId: "glamping", checkIn: day, checkOut: "2026-11-07" }] }, day, props, { packs: { glamping: "https://example.com/g.pdf" } }, hp, EVENTS);
ok("a property's own link on the WhatsApp page still wins", msgOwn.values.arrivalPack === "https://example.com/g.pdf");

// A fake Supabase + Resend for the functions.
function fakeNet(store) {
  const sent = [];
  global.fetch = async function (url, o) {
    o = o || {};
    const res = (b, st) => ({ ok: (st || 200) < 400, status: st || 200, json: async () => b, text: async () => JSON.stringify(b) });
    if (url.indexOf("/auth/v1/user") >= 0) return res({ id: "u1" });
    if (url.indexOf("/profiles?") >= 0) return res([{ role: "admin", active: true, name: "Rosanna" }]);
    if (url.indexOf("api.resend.com") >= 0) { sent.push(JSON.parse(o.body)); return res({ id: "re1" }); }
    const k = (/app_data\?key=eq\.([^&]+)/.exec(url) || [])[1];
    if (k && (!o.method || o.method === "GET")) return res(store[k] !== undefined ? [{ value: store[k], updated_at: "2026-10-30T00:00:00Z" }] : []);
    if (url.indexOf("/rest/v1/app_data") >= 0 && (o.method === "POST" || o.method === "PATCH")) {
      const b = JSON.parse(o.body); if (b.key) store[b.key] = b.value; else if (k) store[k] = b.value; return res(null);
    }
    throw new Error("unexpected " + (o.method || "GET") + " " + url);
  };
  return sent;
}

(async function () {
  console.log("— arrival-pack.js serves the right file —");
  const fn = require("../netlify/functions/arrival-pack.js");
  fakeNet({ hbf_email_templates_v1: TEMPLATES });
  const get = async (t, p, k) => fn.handler({ queryStringParameters: { t: t, k: k || T.packKey(t, "adm", p), p: p } });
  const body = (r) => Buffer.from(r.body, "base64").toString();
  let r = await get("arrival_general", "amly"); ok("Amly link → Amly pack", r.statusCode === 200 && body(r) === "AMLY");
  r = await get("arrival_general", undefined); ok("old link → the pack for everyone", r.statusCode === 200 && body(r) === "GENERAL");
  r = await get("arrival_event", "event-celebration"); ok("celebration of life link", body(r) === "COL");
  r = await get("arrival_event", undefined); ok("the event template has no pack for everyone: nothing", r.statusCode === 404);
  r = await get("arrival_general", "amly", T.packKey("arrival_general", "adm", "hamlet")); ok("another property's key is refused", r.statusCode === 404);
  r = await get("arrival_general", "AMLY/../x"); ok("an odd tag is refused", r.statusCode === 404);
  // A pack marked for a property that the link then loses: falls back to everyone's.
  r = await get("arrival_general", "barn"); ok("a property with no pack of its own gets the one for everyone", body(r) === "GENERAL");

  console.log("— the automatic arrival email attaches only the right pack —");
  delete require.cache[require.resolve("../netlify/functions/send-accom-reminders.js")];
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const inDays = (k) => { const d = new Date(today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };
  const store = {
    hbf_email_templates_v1: TEMPLATES, hawthbush_bookings_v6: EVENTS,
    hbf_properties_v1: [{ id: "hamlet", name: "The Hamlet" }, { id: "amly", name: "Amly Barn" }, { id: "glamping", name: "Glamping" }],
    hbf_accom_v1: [
      { id: "L1", guestName: "Gina", email: "g@x", status: "confirmed", stays: [{ propertyId: "glamping", checkIn: inDays(10), checkOut: inDays(12) }] },
      { id: "L2", guestName: "Pat", email: "p@x", status: "confirmed", linkedEventId: 7, stays: [{ propertyId: "hamlet", checkIn: inDays(10), checkOut: inDays(12) }] }
    ]
  };
  const sent = fakeNet(store);
  const rem = require("../netlify/functions/send-accom-reminders.js");
  await rem.handler({});
  const to = (e) => sent.filter((m) => [].concat(m.to).indexOf(e) >= 0)[0];
  const g = to("g@x"), p = to("p@x");
  ok("Glamping guest got an arrival email with the general and Glamping packs",
    g && JSON.stringify((g.attachments || []).map((a) => a.filename)) === '["general.pdf","glamping.pdf"]', g && JSON.stringify(g.attachments && g.attachments.map((a) => a.filename)));
  ok("…and the file content", g && Buffer.from(g.attachments[1].content, "base64").toString() === "GLAMPING");
  ok("…and the Glamping link in the text", g && g.html.indexOf(hp.arrival_general.glamping) >= 0);
  ok("a let linked to a party got the Wedding/Event email with the party pack",
    p && /Your event/.test(p.subject) && JSON.stringify(p.attachments.map((a) => a.filename)) === '["party.pdf"]', p && p.subject);

  console.log("— sending an email by hand —");
  delete require.cache[require.resolve("../netlify/functions/send-accom-email.js")];
  const sent2 = fakeNet(Object.assign({}, store, { hbf_accom_v1: [{ id: "L3", guestName: "Hal", email: "h@x", status: "confirmed", stays: [{ propertyId: "hamlet", checkIn: inDays(10), checkOut: inDays(12) }] }] }));
  const one = require("../netlify/functions/send-accom-email.js");
  const resp = await one.handler({ httpMethod: "POST", headers: { authorization: "Bearer j" }, body: JSON.stringify({ bookingId: "L3", emailType: "arrival_general" }) });
  const h = sent2[0];
  ok("a Hamlet guest sent the General arrival email gets the general and Hamlet packs",
    h && JSON.stringify(h.attachments.map((a) => a.filename)) === '["general.pdf","hamlet.pdf"]', resp.statusCode + " " + resp.body);

  console.log("arrival-packs-test: " + n + " passed");
})().catch((e) => { console.error(e); process.exit(1); });
