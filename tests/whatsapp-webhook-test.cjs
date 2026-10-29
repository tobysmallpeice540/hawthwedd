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
