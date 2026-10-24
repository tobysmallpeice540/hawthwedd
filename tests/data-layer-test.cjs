// The shared-array save path, pinned. 24 October 2026 (from the code review).
//
//   · mergeById applies only what THIS screen changed (added, edited, removed)
//     to a fresh server copy, so a record someone else added in the meantime
//     survives, and a record this screen never touched keeps the server's
//     version.
//   · A failed read never becomes an empty list written back: sbGetStrict
//     throws, and the write does not happen.
//   · sbSet throws on a failed write, refuses while the tab is a stale build,
//     and refuses a key holding example data.
//   · Two saves of one key in flight together run one after the other, so the
//     second does not drop the first one's change.
//   · mergeByKey does the same for the till's product map.
//
// The functions are lifted out of App.jsx verbatim (as pencil-test.cjs does):
// a retyped copy would prove nothing.
const fs = require("fs");
const path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "src", "App.jsx"), "utf8");

function braceEnd(from) {
  let i = SRC.indexOf("{", from), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error("Unbalanced braces");
}
function lift(name) {
  const start = SRC.indexOf("function " + name + "(");
  if (start === -1) throw new Error("Could not find function " + name);
  return SRC.slice(start, braceEnd(start));
}
function liftArrow(name) {
  const start = SRC.indexOf("const " + name + " = async");
  if (start === -1) throw new Error("Could not find const " + name);
  const arrow = SRC.indexOf("=>", start);
  return SRC.slice(start, braceEnd(arrow)) + ";";
}

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; } else { fail++; console.log("FAIL: " + label); } }
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), label + "\n   got " + JSON.stringify(a) + "\n  want " + JSON.stringify(b)); }

// A fake app_data table behind fetch.
const db = {};
let failNext = null;        // "read" | "write" | null
let readDelay = 0;
const calls = [];
const events = [];
const env = {
  SUPABASE_URL: "https://x.supabase.co",
  sbAuthHeaders: function() { return {}; },
  window: { dispatchEvent: function(e) { events.push(e.detail); } },
  CustomEvent: function(type, init) { this.type = type; this.detail = init.detail; },
  fetch: async function(url, opts) {
    const isWrite = opts && opts.method === "POST";
    calls.push(isWrite ? "write" : "read");
    if (!isWrite && readDelay) await new Promise(function(r) { setTimeout(r, readDelay); });
    if (failNext === (isWrite ? "write" : "read")) {
      failNext = null;
      return { ok: false, status: 503, text: async function() { return "unavailable"; }, json: async function() { return null; } };
    }
    if (isWrite) {
      const body = JSON.parse(opts.body);
      db[body.key] = JSON.parse(JSON.stringify(body.value));
      return { ok: true, status: 201, text: async function() { return ""; }, json: async function() { return null; } };
    }
    const key = decodeURIComponent(/key=eq\.([^&]+)/.exec(url)[1]);
    const rows = key in db ? [{ value: JSON.parse(JSON.stringify(db[key])) }] : [];
    return { ok: true, status: 200, text: async function() { return ""; }, json: async function() { return rows; } };
  },
};

const code = [
  "const SEED_FALLBACK = {};",
  "const READ_FAILED = {};",
  lift("noteDataFailure"),
  "let STALE_BUILD_SEEN = null;",
  lift("noteStaleBuild"),
  lift("noteRefusedWrite"),
  liftArrow("sbSet"),
  liftArrow("sbGetStrict"),
  lift("mergeById"),
  lift("mergeByKey"),
  "const SAVE_CHAIN = {};",
  lift("queueSave"),
  lift("saveObjectMerged"),
  lift("saveArrayMerged"),
  "return { mergeById, mergeByKey, saveArrayMerged, saveObjectMerged, sbSet, sbGetStrict, noteStaleBuild, SEED_FALLBACK, READ_FAILED };",
].join("\n");
const F = new Function("SUPABASE_URL", "sbAuthHeaders", "window", "CustomEvent", "fetch", "console", code)(
  env.SUPABASE_URL, env.sbAuthHeaders, env.window, env.CustomEvent, env.fetch, { error: function() {}, warn: function() {}, log: console.log });

const r = function(id, v) { return { id: id, v: v }; };

(async function() {
  // ── mergeById ────────────────────────────────────────────────────────────
  const before = [r(1, "a"), r(2, "b"), r(3, "c")];

  // Nobody else changed anything: after is taken as it stands (order too).
  eq(F.mergeById(before, before, [r(3, "c"), r(1, "a"), r(2, "B")]),
     [r(3, "c"), r(1, "a"), r(2, "B")], "no outside change: after kept, reorder kept");

  // Someone else added 4 while this screen edited 2: both survive.
  eq(F.mergeById([r(1, "a"), r(2, "b"), r(3, "c"), r(4, "web")], before, [r(1, "a"), r(2, "B"), r(3, "c")]),
     [r(1, "a"), r(2, "B"), r(3, "c"), r(4, "web")], "outside addition survives an edit here");

  // This screen deleted 1 and added 5; someone else added 4.
  eq(F.mergeById([r(1, "a"), r(2, "b"), r(3, "c"), r(4, "web")], before, [r(2, "b"), r(3, "c"), r(5, "new")]),
     [r(2, "b"), r(3, "c"), r(4, "web"), r(5, "new")], "delete and add here, addition elsewhere");

  // A record this screen did not touch keeps the server's newer version.
  eq(F.mergeById([r(1, "a"), r(2, "b"), r(3, "C-server")], before, [r(1, "A"), r(2, "b"), r(3, "c")]),
     [r(1, "A"), r(2, "b"), r(3, "C-server")], "untouched record keeps the server's version");

  // Someone else deleted 3, which this screen did not touch: stays deleted.
  eq(F.mergeById([r(1, "a"), r(2, "b")], before, [r(1, "A"), r(2, "b"), r(3, "c")]),
     [r(1, "A"), r(2, "b")], "outside delete of an untouched record stays deleted");

  // A screen whose start-up read failed (before = []) adding one record does
  // not wipe the list.
  eq(F.mergeById([r(1, "a"), r(2, "b")], [], [r(9, "new")]),
     [r(1, "a"), r(2, "b"), r(9, "new")], "empty before (failed load): add does not wipe");

  // An addition already on the server (a retried save) is not doubled.
  eq(F.mergeById([r(1, "a"), r(9, "new")], [r(1, "a")], [r(1, "a"), r(9, "new")]),
     [r(1, "a"), r(9, "new")], "retried addition not doubled");

  // ids compared as strings.
  eq(F.mergeById([{ id: 1, v: "a" }, { id: 2, v: "x" }], [{ id: "1", v: "a" }], [{ id: "1", v: "A" }]),
     [{ id: "1", v: "A" }, { id: 2, v: "x" }], "numeric and string ids match");

  // A record without an id: the list is saved as it stands (old behaviour).
  eq(F.mergeById([r(1, "a"), r(2, "b")], [r(1, "a")], [r(1, "a"), { v: "no id" }]),
     [r(1, "a"), { v: "no id" }], "id-less record falls back to after");

  // ── mergeByKey ───────────────────────────────────────────────────────────
  eq(F.mergeByKey({ a: 1, b: 2, c: 3 }, { a: 1, b: 2 }, { a: 10, d: 4 }),
     { a: 10, c: 3, d: 4 }, "map: edit, delete, add here; outside key c kept");
  eq(F.mergeByKey({ a: 1, b: 99 }, { a: 1, b: 2 }, { a: 5, b: 2 }),
     { a: 5, b: 99 }, "map: untouched key keeps the server's value");

  // ── saveArrayMerged against the fake table ───────────────────────────────
  db.k = [r(1, "a"), r(2, "b"), r(3, "web")];
  let out = await F.saveArrayMerged("k", [r(1, "a"), r(2, "b")], [r(1, "A"), r(2, "b")]);
  eq(db.k, [r(1, "A"), r(2, "b"), r(3, "web")], "saveArrayMerged writes the merge");
  eq(out, db.k, "saveArrayMerged returns what it wrote");

  // A failed read: nothing is written, the error says so.
  db.k = [r(1, "a"), r(2, "b")];
  calls.length = 0; failNext = "read";
  let threw = null;
  try { await F.saveArrayMerged("k", [r(1, "a"), r(2, "b")], [r(1, "a")]); } catch (e) { threw = e; }
  ok(threw && /nothing was saved/.test(threw.message), "failed read throws 'nothing was saved'");
  eq(calls, ["read"], "failed read: no write attempted");
  eq(db.k, [r(1, "a"), r(2, "b")], "failed read: data untouched");
  ok(F.READ_FAILED.k === true, "failed read marks READ_FAILED");
  await F.sbGetStrict("k");
  ok(!F.READ_FAILED.k, "a good read clears READ_FAILED");

  // sbGetStrict reads a missing key as null (not an error).
  eq(await F.sbGetStrict("missing"), null, "missing key reads as null");

  // A failed write throws.
  failNext = "write"; threw = null;
  try { await F.sbSet("k", []); } catch (e) { threw = e; }
  ok(threw && /Saving failed \(503\)/.test(threw.message), "failed write throws");
  eq(db.k, [r(1, "a"), r(2, "b")], "failed write: data untouched");

  // Example data refused, with a banner.
  F.SEED_FALLBACK.seeded = true; threw = null; events.length = 0; calls.length = 0;
  try { await F.sbSet("seeded", [r(1, "example")]); } catch (e) { threw = e; }
  ok(threw && /example data/.test(threw.message), "seed fallback refuses the write");
  ok(calls.length === 0, "seed fallback: nothing sent");
  ok(events.length === 1 && events[0].title === "Nothing was saved", "seed fallback: banner raised");

  // Two saves in flight together: the second waits for the first.
  db.q = [r(1, "a")];
  readDelay = 20;
  const p1 = F.saveArrayMerged("q", [r(1, "a")], [r(1, "a"), r(2, "first")]);
  const p2 = F.saveArrayMerged("q", [r(1, "a"), r(2, "first")], [r(1, "a"), r(2, "first"), r(3, "second")]);
  await Promise.all([p1, p2]);
  readDelay = 0;
  eq(db.q, [r(1, "a"), r(2, "first"), r(3, "second")], "queued saves: both changes kept");

  // A failed save does not block the next one in the queue.
  db.q = [r(1, "a")];
  failNext = "read";
  const f1 = F.saveArrayMerged("q", [r(1, "a")], [r(1, "x")]).catch(function() { return "failed"; });
  const f2 = F.saveArrayMerged("q", [r(1, "a")], [r(1, "a"), r(2, "y")]);
  eq(await f1, "failed", "first queued save fails");
  await f2;
  eq(db.q, [r(1, "a"), r(2, "y")], "queue carries on after a failure");

  // Object save.
  db.m = { a: 1, b: 2, outside: 3 };
  await F.saveObjectMerged("m", { a: 1, b: 2 }, { a: 1, b: 20 });
  eq(db.m, { a: 1, b: 20, outside: 3 }, "saveObjectMerged keeps outside keys");

  // Stale build: every write refused except the build marker itself.
  F.noteStaleBuild("2099-01-01a"); threw = null; calls.length = 0;
  try { await F.sbSet("k", []); } catch (e) { threw = e; }
  ok(threw && /old version/.test(threw.message), "stale build refuses writes");
  ok(calls.length === 0, "stale build: nothing sent");
  await F.sbSet("hbf_app_build_v1", { build: "x" });
  eq(calls, ["write"], "stale build: the build marker still writes");

  // ── The screens use it ───────────────────────────────────────────────────
  // Pinned so a later edit cannot quietly put a whole-array write back.
  [
    ["EnquiriesView", "useMergedSave(ENQUIRIES_STORAGE, enquiries, setEnquiriesBoth)"],
    ["App enquiries", "useMergedSave(ENQUIRIES_STORAGE, enquiries, setEnquiries)"],
    ["staff", "useMergedSave(STAFF_STORAGE, staff, setStaff)"],
    ["invoice records", "useMergedSave(EVENT_INVOICES_STORAGE, invoiceRecords, setInvoiceRecords)"],
    ["bar products", "useMergedSave(BAR_PRODUCTS_KEY, products, setProducts)"],
    ["bar events", "useMergedSave(BAR_EVENTS_KEY,   events,   setEvents)"],
    ["till map", "useMergedSave(BAR_POS_MAP_KEY, map, setMap, \"object\")"],
    ["viewing requests", "useMergedSave(VR_STORAGE, requests, setRequests)"],
    ["viewing blocks", "useMergedSave(VB_STORAGE, blocks, setBlocks)"],
    ["properties", "saveArrayMerged(PROPERTIES_STORAGE, propsSavedRef.current, properties)"],
  ].forEach(function(p) { ok(SRC.indexOf(p[1]) > -1, p[0] + " saves through the merge"); });
  [
    "sbSet(ENQUIRIES_STORAGE", "sbSet(STAFF_STORAGE", "sbSet(EVENT_INVOICES_STORAGE",
    "sbSet(BAR_PRODUCTS_KEY", "sbSet(BAR_EVENTS_KEY", "sbSet(BAR_POS_MAP_KEY",
    "sbSet(VR_STORAGE", "sbSet(VB_STORAGE", "sbSet(PROPERTIES_STORAGE, props", "sbSet(PROPERTIES_STORAGE, properties",
    "sbSet(ACCOM_STORAGE, imported",
  ].forEach(function(s) { ok(SRC.indexOf(s) === -1, "no whole-array write left: " + s); });

  console.log((fail ? "FAILED " + fail + " of " : "ALL ") + (pass + fail) + " ASSERTIONS " + (fail ? "" : "PASSED"));
  process.exit(fail ? 1 : 0);
})().catch(function(e) { console.error(e); process.exit(1); });
