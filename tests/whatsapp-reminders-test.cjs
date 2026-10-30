// WhatsApp checklist reminders: the plan (who, when, what it says).
// node tests/whatsapp-reminders-test.cjs
const assert = require("assert");
const { planReminders, cleanParam, dueWords } = require("../netlify/functions/whatsapp-reminders/plan.js");

const T = "2450dade-861f-4cba-af54-391282894028", R = "df4f70ec-1a92-4476-abfc-4db71954452d", L = "116492da-d0ab-4528-99b0-fdf28311deed";
const people = { [T]: { name: "Toby", mobile: "447900683355", active: true },
                 [R]: { name: "Rosanna Greenwood", mobile: "447000000001", active: true },
                 [L]: { name: "Lisa", mobile: null, active: true } };
const due = "2026-10-30T15:00:00Z";          // 3pm London (GMT from 25 Oct)
const runs = [{ id: "run1", title: "Arrival", context: "Emma Juner letting", status: "open" },
              { id: "run2", title: "Closed one", status: "done" }];
const items = [
  { run_id: "run1", title: "Heating on", who: "person:" + T, due_at: due, position: 2, state: "open" },
  { run_id: "run1", title: "Welcome hamper", who: "person:" + T, due_at: "2026-10-30T14:00:00Z", position: 1, state: "open" },
  { run_id: "run1", title: "Done already", who: "person:" + T, due_at: "2026-10-30T13:00:00Z", position: 0, state: "done" },
  { run_id: "run1", title: "Bar float", who: "role:bar", due_at: due, position: 3, state: "open" },
  { run_id: "run1", title: "Anyone thing", who: "anyone", due_at: due, position: 4, state: "open" },
  { run_id: "run1", title: "Rosanna's", who: "person:" + R, due_at: due, position: 5, state: "open" },
  { run_id: "run1", title: "Lisa's", who: "person:" + L, due_at: due, position: 6, state: "open" },
  { run_id: "run2", title: "On a done list", who: "person:" + T, due_at: due, position: 0, state: "open" }
];
const at = function (iso) { return new Date(iso); };
const plan = function (now, extra) { return planReminders(Object.assign({ runs, items, people, sent: new Set(), settings: { leadMin: 60 }, now: at(now) }, extra || {})); };

// Toby's first open item is due 14:00 (2pm). 60 minutes lead: from 13:00 until 14:00.
let p = plan("2026-10-30T12:50:00Z");
assert.strictEqual(p.send.filter(function (x) { return x.person === T; }).length, 0, "not yet");
p = plan("2026-10-30T13:05:00Z");
const toby = p.send.filter(function (x) { return x.person === T; });
assert.strictEqual(toby.length, 1, "one per person per list");
assert.deepStrictEqual(toby[0].params, ["Toby", "2 items", "Arrival – Emma Juner letting", "2:00pm today", "Welcome hamper · Heating on"]);
assert.strictEqual(toby[0].to, "447900683355");
// Never after the first item is due.
p = plan("2026-10-30T14:00:00Z");
assert.strictEqual(p.send.filter(function (x) { return x.person === T; }).length, 0, "never after it is due");
// Role / anyone items never; a done list never.
p = plan("2026-10-30T14:30:00Z");
assert.ok(p.send.every(function (x) { return x.person !== T; }));
assert.ok(p.send.every(function (x) { return x.run_id === "run1"; }));
// Rosanna: first name only. Lisa: no mobile, reported.
const ros = p.send.filter(function (x) { return x.person === R; })[0];
assert.strictEqual(ros.params[0], "Rosanna");
assert.strictEqual(ros.params[1], "1 item");
assert.deepStrictEqual(p.noMobile.map(function (x) { return x.name; }), ["Lisa"]);
// Already sent: nothing.
p = plan("2026-10-30T13:05:00Z", { sent: new Set(["run1|" + T]) });
assert.strictEqual(p.send.filter(function (x) { return x.person === T; }).length, 0);
// Lead under 15 minutes is treated as 15 (the job runs every 15 minutes).
p = plan("2026-10-30T13:50:00Z", { settings: { leadMin: 0 } });
assert.strictEqual(p.send.filter(function (x) { return x.person === T; }).length, 1);
// A switched-off login gets nothing.
p = planReminders({ runs, items, people: Object.assign({}, people, { [T]: { name: "Toby", mobile: "44", active: false } }),
  sent: new Set(), settings: { leadMin: 60 }, now: at("2026-10-30T13:05:00Z") });
assert.strictEqual(p.send.filter(function (x) { return x.person === T; }).length, 0);

// Values WhatsApp would refuse are cleaned.
assert.strictEqual(cleanParam("a\nb\t c     d"), "a b c d");
assert.strictEqual(cleanParam(""), "—");
// Due words, London time (BST before 25 Oct).
assert.strictEqual(dueWords(at("2026-10-31T09:30:00Z"), at("2026-10-30T13:00:00Z")), "9:30am tomorrow");
assert.strictEqual(dueWords(at("2026-11-03T15:00:00Z"), at("2026-10-30T13:00:00Z")), "3:00pm Tue 3 Nov");
assert.strictEqual(dueWords(at("2026-10-20T14:00:00Z"), at("2026-10-20T08:00:00Z")), "3:00pm today");
// A long list is cut with "and N more".
const many = Array.from({ length: 40 }, function (_, i) { return { run_id: "run1", title: "Task number " + i + " with words", who: "person:" + R, due_at: due, position: i, state: "open" }; });
p = planReminders({ runs, items: many, people, sent: new Set(), settings: { leadMin: 60 }, now: at("2026-10-30T14:30:00Z") });
assert.ok(/and \d+ more$/.test(p.send[0].params[4]) && p.send[0].params[4].length <= 520, p.send[0].params[4]);
console.log("whatsapp-reminders plan: all tests passed");

// The run, fetch faked: marks before sending, unmarks on refusal, stops on 132001.
(async function () {
  process.env.SUPABASE_SERVICE_KEY = "svc"; process.env.WHATSAPP_TOKEN = "tok";
  const { _test } = require("../netlify/functions/whatsapp-reminders/whatsapp-reminders.js");
  const marks = new Set(); let refuse = false; const sentTo = [];
  global.fetch = async function (url, o) {
    o = o || {};
    const ok = function (b) { return { ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) }; };
    if (url.includes("app_data?key=eq.hbf_whatsapp_settings_v1")) return ok([{ value: { checklistReminders: { on: true, leadMin: 60 } } }]);
    if (url.includes("/chk_runs?")) return ok([runs[0]]);
    if (url.includes("/chk_run_items?")) return ok(items.filter(function (i) { return i.run_id === "run1"; }));
    if (url.includes("/wa_reminders_sent?kind=eq.checklist&run_id=in.")) return ok([...marks].map(function (k) { const p = k.split("|"); return { run_id: p[0], person: p[1] }; }));
    if (url.includes("/profiles?")) return ok(Object.keys(people).map(function (id) { return Object.assign({ id: id }, people[id]); }));
    if (url.includes("/wa_reminders_sent?on_conflict")) {
      const r = JSON.parse(o.body)[0]; const k = r.run_id + "|" + r.person;
      if (marks.has(k)) return ok([]); marks.add(k); return ok([r]);
    }
    if (url.includes("/wa_reminders_sent?kind=eq.checklist&run_id=eq.")) {
      if (o.method === "DELETE") { const m = /run_id=eq\.([^&]+)&person=eq\.(.+)$/.exec(url); marks.delete(m[1] + "|" + m[2]); }
      return ok(null);
    }
    if (url.includes("/wa_messages")) return ok(null);
    if (url.includes("graph.facebook.com")) {
      if (refuse) return { ok: false, status: 404, json: async () => ({ error: { code: 132001, message: "(#132001) Template name does not exist" } }) };
      sentTo.push(JSON.parse(o.body).to); return ok({ messages: [{ id: "wamid." + sentTo.length }] });
    }
    throw new Error("unexpected " + url);
  };
  refuse = true;
  let r = await _test.runOnce(at("2026-10-30T13:05:00Z"));
  assert.ok(r.templateMissing && r.sent === 0 && marks.size === 0, "refused: unmarked, stopped");
  refuse = false;
  r = await _test.runOnce(at("2026-10-30T13:05:00Z"));
  assert.strictEqual(r.sent, 1); assert.deepStrictEqual(sentTo, ["447900683355"]);
  r = await _test.runOnce(at("2026-10-30T13:20:00Z"));
  assert.strictEqual(r.sent, 0, "never twice");
  r = await _test.runOnce(at("2026-10-30T14:30:00Z"));
  assert.strictEqual(r.sent, 1); assert.deepStrictEqual(r.noMobile, ["Lisa"]);
  console.log("whatsapp-reminders run: all tests passed");
})().catch(function (e) { console.error(e); process.exit(1); });
