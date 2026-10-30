// The WhatsApp webhook: numbers, matching, and the whole POST with fetch faked.
// node tests/whatsapp-webhook-test.cjs
const assert = require("assert");
const crypto = require("crypto");
process.env.SUPABASE_SERVICE_KEY = "svc"; process.env.RESEND_API_KEY = "rk";
process.env.WHATSAPP_VERIFY_TOKEN = "vt"; process.env.WHATSAPP_APP_SECRET = "sec";
const fn = require("../netlify/functions/whatsapp-webhook.js");
const t = fn._test;

// Numbers as they are typed in the records.
assert.strictEqual(t.normaliseNumber("07415 740704"), "447415740704");
assert.strictEqual(t.normaliseNumber("+44 7415 740704"), "447415740704");
assert.strictEqual(t.normaliseNumber("7415740704"), "447415740704");
assert.strictEqual(t.normaliseNumber("Becky 07415 740704."), "447415740704");
assert.strictEqual(t.normaliseNumber("0044 7415 740704"), "447415740704");
assert.strictEqual(t.normaliseNumber("someone@gmail.com"), "");
assert.strictEqual(t.normaliseNumber("447415740704"), "447415740704");

const lists = {
  accom: [{ id: "a1", guestName: "Emma Juner", phone: "07415 740704" }, { id: "a2", phone: "" }],
  event: [{ id: 7, couple: "Smith", phone: "+44 7415 740704" }],
  enquiry: [{ id: "q", name: "Nobody", phone: "01825 000000" }]
};
const found = t.findRecords(lists, "447415740704");
assert.deepStrictEqual(found.map(function (r) { return r.kind + ":" + r.id; }), ["accom:a1", "event:7"]);
assert.strictEqual(found[0].name, "Emma Juner letting");

assert.strictEqual(t.messageText({ type: "text", text: { body: "Hi" } }), "Hi");
assert.strictEqual(t.messageText({ type: "image", image: { caption: "the gate" } }), "the gate");
assert.strictEqual(t.messageText({ type: "audio", audio: {} }), "");

const em = t.buildEmail({ number: "447415740704", profile_name: "<b>Em</b>", msg_type: "text", body: "Hello <script>",
  at: "2026-10-29T18:00:00Z", record_name: "Emma Juner letting" });
assert.ok(em.subject === "WhatsApp from Emma Juner letting");
assert.ok(em.html.includes("&lt;script&gt;") && !em.html.includes("<script>"), "message text escaped");
assert.ok(em.html.includes("07415 740704"));

// The whole POST, fetch faked.
const db = {}; const emails = []; let failEmail = false;
global.fetch = async function (url, opts) {
  opts = opts || {};
  const ok = function (b) { return { ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) }; };
  if (url.includes("/app_data?key=eq.hbf_accom_v1")) return ok([{ value: lists.accom }]);
  if (url.includes("/app_data?key=eq.hawthbush_bookings_v6")) return ok([{ value: lists.event }]);
  if (url.includes("/app_data?key=eq.hbf_enquiries_v1")) return ok([{ value: lists.enquiry }]);
  if (url.includes("/wa_messages?on_conflict=id")) { JSON.parse(opts.body).forEach(function (r) { if (!db[r.id]) db[r.id] = Object.assign({ emailed_at: null }, r); }); return ok(null); }
  if (url.includes("/wa_messages?select=*")) return ok(Object.values(db).filter(function (r) { return !r.emailed_at; }));
  if (url.includes("/wa_messages?id=eq.")) { const id = decodeURIComponent(url.split("id=eq.")[1]); db[id].emailed_at = "now"; return ok(null); }
  if (url.includes("/wa_messages?direction=eq.out")) return ok(null);
  if (url.includes("api.resend.com")) { if (failEmail) return { ok: false, status: 500, json: async () => ({}) }; emails.push(JSON.parse(opts.body)); return ok({}); }
  throw new Error("unexpected fetch " + url);
};
function post(payload) {
  const body = JSON.stringify(payload);
  const sig = "sha256=" + crypto.createHmac("sha256", "sec").update(body).digest("hex");
  return fn.handler({ httpMethod: "POST", body: body, headers: { "x-hub-signature-256": sig } });
}
const delivery = { entry: [{ changes: [{ value: {
  contacts: [{ wa_id: "447415740704", profile: { name: "Em" } }],
  messages: [{ id: "wamid.1", from: "447415740704", timestamp: "1761760000", type: "text", text: { body: "What time is check-in?" } }]
} }] }] };

(async function () {
  // A failed email answers 500 and keeps the row; Meta's retry sends it once.
  failEmail = true;
  assert.strictEqual((await post(delivery)).statusCode, 500);
  assert.ok(db["wamid.1"] && db["wamid.1"].emailed_at === null);
  assert.strictEqual(db["wamid.1"].record_kind, "accom");
  failEmail = false;
  assert.strictEqual((await post(delivery)).statusCode, 200);
  assert.strictEqual(emails.length, 1);
  assert.strictEqual(emails[0].to, "hawthbushfarm@gmail.com");
  // A third delivery of the same message: no second email.
  assert.strictEqual((await post(delivery)).statusCode, 200);
  assert.strictEqual(emails.length, 1);
  // A bad signature is refused.
  const r = await fn.handler({ httpMethod: "POST", body: JSON.stringify(delivery), headers: { "x-hub-signature-256": "sha256=00" } });
  assert.strictEqual(r.statusCode, 401);
  console.log("whatsapp-webhook: all tests passed");
})().catch(function (e) { console.error(e); process.exit(1); });

// Photos and files: fetched from Meta and attached to the email (30 Oct).
(async function () {
  await new Promise(function (r) { setTimeout(r, 200); });
  process.env.WHATSAPP_TOKEN = "tok";
  delete require.cache[require.resolve("../netlify/functions/whatsapp-webhook.js")];
  const fn2 = require("../netlify/functions/whatsapp-webhook.js");
  assert.deepStrictEqual(fn2._test.mediaOf({ type: "image", image: { id: "m1", mime_type: "image/jpeg" } }), { type: "image", id: "m1", mime: "image/jpeg", name: "" });
  assert.strictEqual(fn2._test.mediaOf({ type: "text", text: { body: "x" } }), null);
  assert.strictEqual(fn2._test.fileName({ type: "audio", mime: "audio/ogg; codecs=opus" }), "whatsapp-voice-note.ogg");
  assert.strictEqual(fn2._test.fileName({ type: "document", name: 'menu "v2"/final.pdf' }), "menu _v2__final.pdf");
  const db2 = {}; const mails = []; let big = false;
  global.fetch = async function (url, opts) {
    opts = opts || {};
    const ok = function (b) { return { ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) }; };
    if (url.includes("/app_data?key=eq.")) return ok([{ value: [] }]);
    if (url.includes("/wa_messages?on_conflict=id")) { JSON.parse(opts.body).forEach(function (r) { if (!db2[r.id]) db2[r.id] = Object.assign({ emailed_at: null }, r); }); return ok(null); }
    if (url.includes("/wa_messages?select=*")) return ok(Object.values(db2).filter(function (r) { return !r.emailed_at; }));
    if (url.includes("/wa_messages?id=eq.")) { db2[decodeURIComponent(url.split("id=eq.")[1])].emailed_at = "now"; return ok(null); }
    if (url === "https://graph.facebook.com/v23.0/media1") return ok({ url: "https://lookaside.example/media1", mime_type: "image/jpeg", file_size: big ? 50 * 1048576 : 3 });
    if (url === "https://lookaside.example/media1") return { ok: true, status: 200, arrayBuffer: async () => Buffer.from("abc") };
    if (url.includes("api.resend.com")) { mails.push(JSON.parse(opts.body)); return ok({}); }
    throw new Error("unexpected " + url);
  };
  const photo = function (id) { return { entry: [{ changes: [{ value: { contacts: [{ wa_id: "447700900001", profile: { name: "Sam" } }],
    messages: [{ id: id, from: "447700900001", timestamp: "1761760000", type: "image", image: { id: "media1", mime_type: "image/jpeg", caption: "the gate" } }] } }] }] }; };
  const crypto2 = require("crypto");
  const post2 = function (payload) {
    const body = JSON.stringify(payload);
    return fn2.handler({ httpMethod: "POST", body: body, headers: { "x-hub-signature-256": "sha256=" + crypto2.createHmac("sha256", "sec").update(body).digest("hex") } });
  };
  assert.strictEqual((await post2(photo("wamid.p1"))).statusCode, 200);
  assert.strictEqual(mails.length, 1);
  assert.deepStrictEqual(mails[0].attachments, [{ filename: "whatsapp-photo.jpg", content: Buffer.from("abc").toString("base64") }]);
  assert.ok(mails[0].html.includes("it is attached") && mails[0].html.includes("the gate"));
  big = true;
  assert.strictEqual((await post2(photo("wamid.p2"))).statusCode, 200, "a photo too big still delivers the email");
  assert.strictEqual(mails[1].attachments, undefined);
  assert.ok(mails[1].html.includes("too big to attach"));
  console.log("whatsapp-webhook media: all tests passed");
})().catch(function (e) { console.error(e); process.exit(1); });


// Arrival times: a tapped button is saved on the booking (30 Oct).
(async function () {
  await new Promise(function (r) { setTimeout(r, 600); });
  delete require.cache[require.resolve("../netlify/functions/whatsapp-webhook.js")];
  const fn3 = require("../netlify/functions/whatsapp-webhook.js");
  assert.deepStrictEqual(fn3._test.etaOf({ type: "button", button: { payload: "eta|A1@2026-10-31|1", text: "6pm to 9pm" } }),
    { bookingId: "A1", date: "2026-10-31", text: "6pm to 9pm" });
  assert.strictEqual(fn3._test.etaOf({ type: "button", button: { payload: "something else", text: "x" } }), null);
  let lettings = [{ id: "A1", guestName: "Emma Juner", phone: "", stays: [] }, { id: "A2", guestName: "Other" }];
  let version = "2026-10-30T10:00:00Z", clashOnce = true;
  const db3 = {}; const mails3 = [];
  global.fetch = async function (url, opts) {
    opts = opts || {};
    const ok = function (b) { return { ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) }; };
    if (url.includes("/app_data?key=eq.hbf_accom_v1&select=value,updated_at")) return ok([{ value: JSON.parse(JSON.stringify(lettings)), updated_at: version }]);
    if (url.includes("/app_data?key=eq.hbf_accom_v1&updated_at=eq.")) {
      if (clashOnce) { clashOnce = false; version = "2026-10-30T10:00:01Z"; return ok([]); }   // someone saved in between
      if (decodeURIComponent(url.split("updated_at=eq.")[1]) !== version) return ok([]);
      lettings = JSON.parse(opts.body).value; version = "later"; return ok([{ key: "hbf_accom_v1" }]);
    }
    if (url.includes("/app_data?key=eq.hbf_accom_v1")) return ok([{ value: lettings }]);
    if (url.includes("/app_data?key=eq.")) return ok([{ value: [] }]);
    if (url.includes("/wa_messages?on_conflict=id")) { JSON.parse(opts.body).forEach(function (r) { if (!db3[r.id]) db3[r.id] = Object.assign({ emailed_at: null }, r); }); return ok(null); }
    if (url.includes("/wa_messages?select=*")) return ok(Object.values(db3).filter(function (r) { return !r.emailed_at; }));
    if (url.includes("/wa_messages?id=eq.")) { db3[decodeURIComponent(url.split("id=eq.")[1])].emailed_at = "now"; return ok(null); }
    if (url.includes("api.resend.com")) { mails3.push(JSON.parse(opts.body)); return ok({}); }
    throw new Error("unexpected " + url);
  };
  const crypto3 = require("crypto");
  const tap = { entry: [{ changes: [{ value: { contacts: [{ wa_id: "447700900009", profile: { name: "Em" } }],
    messages: [{ id: "wamid.t1", from: "447700900009", timestamp: "1761818000", type: "button", context: { id: "wamid.out1" },
      button: { payload: "eta|A1@2026-10-31|1", text: "6pm to 9pm" } }] } }] }] };
  const body = JSON.stringify(tap);
  const r = await fn3.handler({ httpMethod: "POST", body: body, headers: { "x-hub-signature-256": "sha256=" + crypto3.createHmac("sha256", "sec").update(body).digest("hex") } });
  assert.strictEqual(r.statusCode, 200);
  const a1 = lettings.filter(function (x) { return x.id === "A1"; })[0];
  assert.deepStrictEqual({ text: a1.arrivalEta.text, date: a1.arrivalEta.date, via: a1.arrivalEta.via }, { text: "6pm to 9pm", date: "2026-10-31", via: "whatsapp" }, "saved after one clash");
  assert.strictEqual(lettings.filter(function (x) { return x.id === "A2"; })[0].arrivalEta, undefined, "no other booking touched");
  assert.strictEqual(db3["wamid.t1"].record_id, "A1", "matched by the payload, not the phone");
  assert.ok(/^Arrival time from Emma Juner letting: 6pm to 9pm$/.test(mails3[0].subject), mails3[0].subject);
  assert.ok(mails3[0].html.includes("saved on the booking"));
  console.log("whatsapp-webhook arrival times: all tests passed");
})().catch(function (e) { console.error(e); process.exit(1); });
