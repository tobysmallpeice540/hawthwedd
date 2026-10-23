// tests/brevo-optout-test.cjs
//
// A client who unticks "keep in touch" in the portal must be left out of every
// Brevo list AND unsubscribed in Brevo. And if reading the opt-outs fails for
// any reason other than "the column is not there yet", the sync must stop
// rather than import everybody.
//
// Runs the real netlify/functions/brevo-sync.js against a fake fetch.
//     node tests/brevo-optout-test.cjs

const fs = require("fs");
const path = require("path");
const Module = require("module");

process.env.BREVO_API_KEY = "test-brevo";
process.env.SUPABASE_SERVICE_KEY = "test-service";
process.env.HBF_ADMIN_TOKEN = "test-admin";

const FN_PATH = path.join(__dirname, "..", "netlify", "functions", "brevo-sync.js");
function load() {
  const mod = new Module(FN_PATH, null);
  mod.filename = FN_PATH;
  mod.paths = Module._nodeModulePaths(path.dirname(FN_PATH));
  mod._compile(fs.readFileSync(FN_PATH, "utf8"), FN_PATH);
  return mod.exports;
}

let passes = 0; const fails = [];
function check(name, ok, detail) { if (ok) passes++; else fails.push(name + (detail ? ": " + detail : "")); }

function fakeFetch(optOutResponse) {
  const calls = [];
  global.fetch = async function(url, opts) {
    calls.push({ url, opts });
    const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (url.includes("/rest/v1/wp_access")) return optOutResponse();
    if (url.includes("/rest/v1/box_orders")) return json(200, [{ email: "buyer@x.test", first_name: "B", last_name: "Y", created_at: "2026-01-01" }]);
    if (url.includes("app_data?key=eq.hawthbush_bookings_v6")) return json(200, [{ value: [
      { status: "Confirmed", couple: "Ada & Grace", email: "ada@x.test", email2: "OUT@x.test", date: "2027-05-15" }] }]);
    if (url.includes("app_data?key=eq.hbf_enquiries_v1")) return json(200, [{ value: [{ id: "enq_1700000000000", name: "Out Person", email: "out@x.test" }] }]);
    if (url.includes("app_data?key=eq.hbf_accom_v1")) return json(200, [{ value: [] }]);
    if (url.includes("/contacts/attributes/")) return json(400, {});
    if (url.includes("/contacts/import")) return json(202, { processId: 1 });
    if (/\/contacts\/[^/]+$/.test(url) && opts.method === "PUT") return { ok: true, status: 204, text: async () => "" };
    return json(404, {});
  };
  return calls;
}

(async () => {
  const fn = load();
  const ev = { headers: { "x-admin-token": "test-admin" } };

  // 1-3  opted-out address is in no import, and is unsubscribed
  let calls = fakeFetch(() => ({ ok: true, status: 200, text: async () => JSON.stringify([{ email: "Out@x.test" }]) }));
  let r = await fn.handler(ev);
  check("1 sync ran", r.statusCode === 200, r.body);
  const imports = calls.filter((c) => c.url.includes("/contacts/import")).map((c) => c.opts.body).join("\n");
  check("2 opted-out address not imported anywhere", !/out@x\.test/i.test(imports), imports);
  check("2b everyone else still imported", /ada@x\.test/.test(imports) && /buyer@x\.test/.test(imports));
  const puts = calls.filter((c) => c.opts && c.opts.method === "PUT");
  check("3 unsubscribed in Brevo", puts.length === 1 && puts[0].url.endsWith("/contacts/out%40x.test")
    && JSON.parse(puts[0].opts.body).emailBlacklisted === true, JSON.stringify(puts.map((p) => p.url)));

  // 4  the column not existing yet (migration not applied) is survivable
  calls = fakeFetch(() => ({ ok: false, status: 400, text: async () => '{"code":"42703","message":"column wp_access.marketing_ok does not exist"}' }));
  r = await fn.handler(ev);
  check("4 missing column tolerated", r.statusCode === 200, r.body);

  // 5  any OTHER failure stops the sync before anything is imported
  calls = fakeFetch(() => ({ ok: false, status: 500, text: async () => "boom" }));
  r = await fn.handler(ev);
  const imported = calls.filter((c) => c.url.includes("/contacts/import")).length;
  check("5 other failure stops the sync", r.statusCode === 500 && imported === 0, r.statusCode + " / " + imported + " imports");

  if (fails.length) { console.error(passes + " passed / FAILURES:\n  " + fails.join("\n  ")); process.exit(1); }
  console.log("ALL " + passes + " ASSERTIONS PASSED");
})();
