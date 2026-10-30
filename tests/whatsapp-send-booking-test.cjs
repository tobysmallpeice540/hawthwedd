// whatsapp-send: the pre-arrival message for one booking, by hand (30 Oct).
// node tests/whatsapp-send-booking-test.cjs
const assert = require("assert");
process.env.SUPABASE_SERVICE_KEY = "svc"; process.env.WHATSAPP_TOKEN = "tok"; process.env.HBF_ADMIN_TOKEN = "adm";
const fn = require("../netlify/functions/whatsapp-send.js");
const T = require("../netlify/functions/whatsapp-reminders/templates.js");
const day = function (n) { const d = new Date(); d.setUTCHours(12); d.setUTCDate(d.getUTCDate() + n); return d.toLocaleDateString("en-CA", { timeZone: "Europe/London" }); };
const IN = day(3);
const accom = [
  { id: "A1", guestName: "Emma Juner", phone: "07700 900001", status: "confirmed", source: "direct", bookingType: "Wedding",
    stays: [{ propertyId: "hamlet", checkIn: IN, checkOut: day(5), checkInTime: "15:00" }] },
  { id: "A2", guestName: "Said No", phone: "07700 900002", waConsent: false, status: "confirmed", stays: [{ propertyId: "amly", checkIn: IN, checkOut: day(5) }] }
];
const marks = {}; let sent = null; let status = "APPROVED"; const logged = [];
global.fetch = async function (url, o) {
  o = o || {};
  const ok = function (b) { return { ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) }; };
  if (url.includes("/auth/v1/user")) return ok({ id: "u1" });
  if (url.includes("/profiles?id=eq.")) return ok([{ role: "admin", active: true, name: "Rosanna" }]);
  const k = (/app_data\?key=eq\.([^&]+)/.exec(url) || [])[1];
  if (k === "hbf_accom_v1") return ok([{ value: accom }]);
  if (k === "hbf_properties_v1") return ok([{ value: [{ id: "hamlet", name: "The Hamlet" }, { id: "amly", name: "Amly Barn" }] }]);
  if (k === "hbf_whatsapp_settings_v1") return ok([{ value: { arrival: { gateCode: "4321" } } }]);
  if (k === "hbf_email_templates_v1") return ok([{ value: [{ id: "arrival_general", attachments: [{ name: "g.pdf" }] }, { id: "arrival_event", attachments: [{ name: "w.pdf" }] }] }]);
  if (k === "hbf_whatsapp_submitted_v1") return ok([{ value: {} }]);
  if (url.includes("/message_templates?name=pre_arrival")) return ok({ data: [{ name: "pre_arrival", status: status }] });
  if (url.includes("/wa_sent_marks?kind=eq.arrival&ref=eq.") && (!o.method || o.method === "GET")) {
    const ref = decodeURIComponent(url.split("ref=eq.")[1].split("&")[0]);
    return ok(marks[ref] ? [{ sent_at: marks[ref] }] : []);
  }
  if (url.includes("/wa_sent_marks?on_conflict")) { const r = JSON.parse(o.body)[0]; marks[r.ref] = r.sent_at; return ok(null); }
  if (url.includes("/wa_sent_marks?kind=eq.arrival&ref=eq.")) { if (o.method === "DELETE") delete marks[decodeURIComponent(url.split("ref=eq.")[1])]; return ok(null); }
  if (url.includes("/wa_messages")) { logged.push(JSON.parse(o.body)); return ok(null); }
  if (url.includes("/messages")) { sent = JSON.parse(o.body); return ok({ messages: [{ id: "wamid.hand1" }] }); }
  throw new Error("unexpected " + url);
};
const call = function (b) { return fn.handler({ httpMethod: "POST", headers: { authorization: "Bearer j" }, body: JSON.stringify(b) }).then(function (r) { return { code: r.statusCode, body: JSON.parse(r.body) }; }); };

(async function () {
  let r = await call({ action: "bookingPreview", bookingId: "A1" });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.to, "447700900001");
  assert.strictEqual(r.body.day, IN);
  assert.ok(r.body.text.indexOf("The gate code is 4321") !== -1, r.body.text);
  assert.ok(r.body.text.indexOf(T.packUrl("arrival_event", "adm")) !== -1, "a wedding gets the Wedding/Event pack link");
  assert.strictEqual(r.body.alreadySent, null);
  r = await call({ action: "bookingPreview", bookingId: "A2" });
  assert.strictEqual(r.body.skip, "not agreed");
  r = await call({ action: "sendBooking", bookingId: "A2" });
  assert.strictEqual(r.code, 400, "no consent, no send");
  r = await call({ action: "sendBooking", bookingId: "A1" });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  assert.strictEqual(sent.template.name, "pre_arrival");
  assert.strictEqual(sent.template.components[0].parameters[2].text, "4321");
  assert.strictEqual(sent.template.components[1].parameters[0].payload, "eta|A1@" + IN + "|0");
  assert.ok(marks["A1|" + IN], "marked, so the automatic one won't send it again");
  assert.ok(/sent by hand by Rosanna/.test(logged[0].body));
  r = await call({ action: "sendBooking", bookingId: "A1" });
  assert.strictEqual(r.code, 409, "a second send asks first");
  r = await call({ action: "sendBooking", bookingId: "A1", force: true });
  assert.strictEqual(r.code, 200);
  r = await call({ action: "bookingPreview", bookingId: "nope" });
  assert.strictEqual(r.code, 400);
  console.log("whatsapp-send booking: all tests passed");
})().catch(function (e) { console.error(e); process.exit(1); });
