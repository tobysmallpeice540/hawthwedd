// tests/portal-upload-test.cjs
//
// netlify/functions/portal-upload.js against a fake Supabase. The rules:
//   - the permission question is asked with the PERSON's token, never the service key
//   - the path signed is the one the database chose, never one from the caller
//   - "finish" marks a row ready only if the stored object is really there
//   - a refusal from the database is never treated as a yes
//     node tests/portal-upload-test.cjs

const fs = require("fs"), path = require("path"), Module = require("module");
process.env.SUPABASE_SERVICE_KEY = "SERVICE";
const FN = path.join(__dirname, "..", "netlify", "functions", "portal-upload.js");
const mod = new Module(FN, null); mod.filename = FN; mod.paths = Module._nodeModulePaths(path.dirname(FN));
mod._compile(fs.readFileSync(FN, "utf8"), FN);
const handler = mod.exports.handler;

let passes = 0; const fails = [];
const check = (n, ok, d) => { if (ok) passes++; else fails.push(n + (d ? ": " + d : "")); };
const ID = "11111111-2222-4333-8444-555555555555";

function fake(opts) {
  const calls = [];
  global.fetch = async (url, o) => {
    const auth = (o.headers || {}).Authorization;
    calls.push({ url, method: o.method, auth, body: o.body });
    const j = (s, b, h) => ({ ok: s < 300, status: s, text: async () => JSON.stringify(b), headers: new Map(Object.entries(h || {})) });
    if (url.endsWith("/rpc/wp_upload_slot")) return opts.slot ? j(200, opts.slot) : j(401, {});
    if (url.endsWith("/rpc/wp_upload_path")) return j(200, opts.who || { ok: true, path: "101/" + ID + ".jpg" });
    if (url.endsWith("/rpc/wp_upload_confirm") || url.endsWith("/rpc/wp_upload_forget")) return j(200, { ok: true });
    if (url.includes("/object/upload/sign/")) return j(200, { url: "/object/upload/sign/portal-uploads/101/x.jpg?token=TOK" });
    if (o.method === "HEAD") return opts.exists ? j(200, {}, { "content-length": "1234" }) : j(404, {});
    if (url.includes("/object/sign/")) return j(200, { signedURL: "/object/sign/portal-uploads/101/x.jpg?token=V" });
    if (o.method === "DELETE") return j(200, {});
    return j(404, {});
  };
  return calls;
}
const ev = (b) => ({ httpMethod: "POST", headers: { authorization: "Bearer USERJWT" }, body: JSON.stringify(b) });

(async () => {
  // 1  start: asked as the person; signs the database's path, not the caller's
  let calls = fake({ slot: { ok: true, id: ID, path: "101/" + ID + ".jpg" } });
  let r = await handler(ev({ action: "start", name: "mum.jpg", size: 1000, type: "image/jpeg", path: "202/evil.jpg" }));
  const b = JSON.parse(r.body);
  check("1 start ok", r.statusCode === 200 && b.token === "TOK" && b.path === "101/" + ID + ".jpg", r.body);
  check("1b permission asked as the person", calls.find((c) => c.url.endsWith("wp_upload_slot")).auth === "Bearer USERJWT");
  check("1c signed the database's path", calls.some((c) => c.url.includes("/upload/sign/portal-uploads/101/" + ID)) && !calls.some((c) => c.url.includes("202")));

  // 2  a database refusal is a refusal
  fake({ slot: { ok: false, error: "bad_type" } });
  r = await handler(ev({ action: "start", name: "x.exe", size: 1, type: "application/x" }));
  check("2 refusal passed on", r.statusCode === 400 && JSON.parse(r.body).code === "bad_type", r.body);

  // 3  an expired token is a sign-in problem, not a yes
  fake({});
  r = await handler(ev({ action: "start", name: "a.jpg", size: 1, type: "image/jpeg" }));
  check("3 expired token", r.statusCode === 401, r.statusCode + " " + r.body);

  // 4  finish only confirms if the object exists
  calls = fake({ exists: false });
  r = await handler(ev({ action: "finish", id: ID }));
  check("4 missing file not confirmed", r.statusCode === 409 && !calls.some((c) => c.url.endsWith("wp_upload_confirm")), r.body);
  calls = fake({ exists: true });
  r = await handler(ev({ action: "finish", id: ID }));
  const conf = calls.find((c) => c.url.endsWith("wp_upload_confirm"));
  check("4b present file confirmed with the SERVICE key and real size",
    r.statusCode === 200 && conf && conf.auth === "Bearer SERVICE" && JSON.parse(conf.body).p_size === 1234, r.body);

  // 5  view of somebody else's file is refused before anything is signed
  calls = fake({ who: { ok: false, error: "not_found" } });
  r = await handler(ev({ action: "view", id: ID }));
  check("5 other's file refused", r.statusCode === 403 && !calls.some((c) => c.url.includes("/object/sign/")), r.body);

  // 6  delete removes the file, then the row
  calls = fake({});
  r = await handler(ev({ action: "delete", id: ID }));
  const iDel = calls.findIndex((c) => c.method === "DELETE"), iForget = calls.findIndex((c) => c.url.endsWith("wp_upload_forget"));
  check("6 file then row", r.statusCode === 200 && iDel >= 0 && iForget > iDel, r.body);

  if (fails.length) { console.error(passes + " passed / FAILURES:\n  " + fails.join("\n  ")); process.exit(1); }
  console.log("ALL " + passes + " ASSERTIONS PASSED");
})();
