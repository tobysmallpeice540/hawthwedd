// tests/checklists-run-test.cjs
//
// One run of netlify/functions/checklists/checklists.js with fetch faked:
// who may call it, that it reads only what the switched-on templates need,
// hands the plan to chk_worker_apply, and that a failed read cancels nothing.
//
//   node tests/checklists-run-test.cjs

const assert = require("assert");
process.env.SUPABASE_SERVICE_KEY = "svc";
process.env.HBF_ADMIN_TOKEN = "tok";

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + e.message); }
}

function fake(o) {
  const calls = [];
  global.fetch = async function(url, init) {
    const u = String(url), body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url: u, body: body });
    const reply = function(status, v) { return { ok: status < 300, status: status, json: async function() { return v; }, text: async function() { return JSON.stringify(v); } }; };
    if (u.indexOf("/rpc/chk_worker_state") !== -1) return reply(200, o.state);
    if (u.indexOf("/rpc/chk_worker_apply") !== -1) return reply(200, { ok: true, fired: (body.p.fire || []).length });
    const m = /app_data\?key=eq\.([^&]+)/.exec(u);
    if (m) {
      const k = decodeURIComponent(m[1]);
      if (o.fail && o.fail[k]) return reply(500, { message: "boom" });
      return reply(200, k in (o.appData || {}) ? [{ value: o.appData[k] }] : []);
    }
    if (u.indexOf("/rest/v1/wp_drinks") !== -1) return reply(200, o.drinks || []);
    if (u.indexOf("/rest/v1/box_events") !== -1) return reply(200, o.box || []);
    if (u.indexOf("/auth/v1/user") !== -1) return o.user ? reply(200, o.user) : reply(401, {});
    if (u.indexOf("/rest/v1/profiles") !== -1) return reply(200, [{ role: o.role || "admin", active: true }]);
    return reply(404, {});
  };
  return calls;
}
const fn = require("../netlify/functions/checklists/checklists.js");
const now = new Date();
const today = now.toISOString().slice(0, 10);
const tplIn = { id: "T1", title: "Arrival", trig: { kind: "checkin", offset_min: -1440 }, fire_from: "2026-01-01T00:00:00Z" };
const accom = [{ id: "A1", guestName: "Smith", status: "confirmed", stays: [{ propertyId: "hamlet", checkIn: today, checkOut: today }] }];

(async function() {
  await t("refused without the cron token or an admin", async function() {
    fake({ state: { templates: [] } });
    const r = await fn.handler({ httpMethod: "POST", headers: {} });
    assert.equal(r.statusCode, 403);
  });
  await t("a bar login cannot run it", async function() {
    fake({ state: { templates: [] }, user: { id: "u" }, role: "bar" });
    const r = await fn.handler({ httpMethod: "POST", headers: { authorization: "Bearer x" } });
    assert.equal(r.statusCode, 403);
  });
  await t("no templates: nothing read, nothing applied", async function() {
    const calls = fake({ state: { templates: [], open_runs: [] } });
    const r = await fn.handler({ httpMethod: "POST", headers: { "x-admin-token": "tok" } });
    assert.equal(r.statusCode, 200);
    assert.equal(calls.length, 1);
  });
  await t("a check-in template reads lettings and properties only, and fires today's arrival", async function() {
    const calls = fake({ state: { templates: [tplIn], open_runs: [] }, appData: { hbf_accom_v1: accom, hbf_properties_v1: [] } });
    const r = await fn.handler({ httpMethod: "POST", headers: { "x-admin-token": "tok" } });
    assert.equal(r.statusCode, 200, r.body);
    const read = calls.filter(function(c) { return c.url.indexOf("app_data") !== -1; }).map(function(c) { return /key=eq\.([^&]+)/.exec(c.url)[1]; }).sort();
    assert.deepEqual(read, ["hbf_accom_v1", "hbf_properties_v1"]);
    const apply = calls.find(function(c) { return c.url.indexOf("chk_worker_apply") !== -1; });
    assert.equal(apply.body.p.fire.length, 1);
    assert.equal(apply.body.p.fire[0].anchor_key, "in:A1:hamlet");
  });
  await t("an admin's Check now runs it too", async function() {
    fake({ state: { templates: [], open_runs: [] }, user: { id: "u" }, role: "admin" });
    const r = await fn.handler({ httpMethod: "POST", headers: { authorization: "Bearer x" } });
    assert.equal(r.statusCode, 200);
  });
  await t("lettings read fails: the open list is not cancelled", async function() {
    const calls = fake({ state: { templates: [tplIn], open_runs: [{ id: "R1", template_id: "T1", anchor_key: "in:GONE:hamlet", anchor_at: now.toISOString(), touched: false }] },
                         appData: { hbf_properties_v1: [] }, fail: { hbf_accom_v1: true } });
    const r = await fn.handler({ httpMethod: "POST", headers: { "x-admin-token": "tok" } });
    assert.equal(r.statusCode, 200);
    assert.equal(calls.filter(function(c) { return c.url.indexOf("chk_worker_apply") !== -1; }).length, 0);
  });
  await t("lettings read fine: the vanished booking's list is cancelled", async function() {
    const calls = fake({ state: { templates: [tplIn], open_runs: [{ id: "R1", template_id: "T1", anchor_key: "in:GONE:hamlet", anchor_at: now.toISOString(), touched: false }] },
                         appData: { hbf_accom_v1: accom, hbf_properties_v1: [] } });
    await fn.handler({ httpMethod: "POST", headers: { "x-admin-token": "tok" } });
    const apply = calls.find(function(c) { return c.url.indexOf("chk_worker_apply") !== -1; });
    assert.deepEqual(apply.body.p.cancel, ["R1"]);
  });
  await t("a pay bar template reads events, settings, drinks and ticketed events", async function() {
    const calls = fake({ state: { templates: [{ id: "T2", title: "Bar open", trig: { kind: "event", event_type: "paybar" }, fire_from: "2026-01-01" }], open_runs: [] },
                         appData: { hawthbush_bookings_v6: [], hbf_checklist_settings_v1: { startTimes: {} } } });
    await fn.handler({ httpMethod: "POST", headers: { "x-admin-token": "tok" } });
    assert.ok(calls.some(function(c) { return c.url.indexOf("/rest/v1/wp_drinks") !== -1; }));
    assert.ok(calls.some(function(c) { return c.url.indexOf("/rest/v1/box_events?status=neq.draft") !== -1; }));
  });
  console.log("\n" + pass + " passed, " + fail + " failed\n");
  process.exit(fail ? 1 : 0);
})();
