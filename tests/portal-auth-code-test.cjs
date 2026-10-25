// tests/portal-auth-code-test.cjs
//
// Sign-in emails carry a typed code as well as the link (netlify/functions/
// portal-auth.js), for the installed planner on an iPhone, where a link in an
// email opens in Safari instead. Against a fake Supabase and a fake Resend:
//   · the email has the link (our own /portal#t=…) AND the code;
//   · neither the code nor the token is written to the email log, which every
//     member of staff can read;
//   · an address without portal access gets nothing, and the answer is the
//     same either way;
//   · an odd email_otp (missing, not digits) sends the link without a code.
//     node tests/portal-auth-code-test.cjs

const fs = require("fs"), path = require("path"), Module = require("module");
process.env.SUPABASE_SERVICE_KEY = "SERVICE";
process.env.RESEND_API_KEY = "re_test";

const FN = path.join(__dirname, "..", "netlify", "functions", "portal-auth.js");
const mod = new Module(FN, null); mod.filename = FN; mod.paths = Module._nodeModulePaths(path.dirname(FN));
mod._compile(fs.readFileSync(FN, "utf8"), FN);
const handler = mod.exports.handler;

let passes = 0; const fails = [];
const check = (n, ok, d) => { if (ok) passes++; else fails.push(n + (d ? ": " + d : "")); };

function fake(o) {
  const calls = [];
  global.fetch = async (url, opt) => {
    const body = opt && opt.body ? JSON.parse(opt.body) : null;
    calls.push({ url, body, method: (opt && opt.method) || "GET" });
    const j = (s, b) => ({ ok: s < 300, status: s, text: async () => JSON.stringify(b), json: async () => b });
    if (url.endsWith("/rpc/wp_may_send_link")) return j(200, o.allowed === false ? { ok: false, reason: "not_invited" } : { ok: true, event_id: 222 });
    if (url.endsWith("/auth/v1/admin/users")) return j(422, { msg: "exists" });
    if (url.endsWith("/auth/v1/admin/generate_link")) return j(200, { properties: Object.assign({ hashed_token: "HASHTOKEN123", action_link: "https://x.supabase.co/verify?token=zzz" }, o.otp === undefined ? { email_otp: "482913" } : o.otp === null ? {} : { email_otp: o.otp }) });
    if (url.includes("app_data?key=eq.hbf_portal_email_templates_v1")) return j(200, [{ value: [] }]);
    if (url.includes("app_data?key=eq.hbf_email_log_v1")) return j(200, [{ value: [] }]);
    if (url.endsWith("/rest/v1/app_data")) return j(201, {});
    if (url.includes("api.resend.com")) return j(200, { id: "em" });
    return j(404, {});
  };
  return calls;
}
const req = (b) => ({ httpMethod: "POST", headers: {}, body: JSON.stringify(b) });

(async () => {
  let calls = fake({});
  let r = await handler(req({ action: "request-link", email: "Sam@X.test" }));
  const mail = calls.find((c) => c.url.includes("api.resend.com"));
  check("C1 answered", r.statusCode === 200 && JSON.parse(r.body).sent === true);
  check("C2 the email carries our own link", mail && mail.body.html.includes("https://hawthbushfarm.netlify.app/portal#t=HASHTOKEN123"));
  check("C3 and never Supabase's action_link", mail && !mail.body.html.includes("supabase.co/verify"));
  check("C4 and the code, explained", mail && mail.body.html.includes(">482913<") && /planner app on your phone/.test(mail.body.html));
  const log = calls.find((c) => c.url.endsWith("/rest/v1/app_data") && c.body && c.body.key === "hbf_email_log_v1");
  const logged = log ? JSON.stringify(log.body.value) : "";
  check("C5 logged to Recent Automated Emails", !!log && /sign-in/i.test(logged));
  check("C6 neither the code nor the token is in the log", logged.indexOf("482913") === -1 && logged.indexOf("HASHTOKEN123") === -1, logged.slice(0, 200));

  calls = fake({ allowed: false });
  r = await handler(req({ action: "request-link", email: "stranger@x.test" }));
  check("C7 no access: same answer, nothing sent", r.statusCode === 200 && JSON.parse(r.body).sent === true && !calls.some((c) => c.url.includes("api.resend.com") || c.url.includes("generate_link")));

  for (const odd of [null, "abc123", ""]) {
    calls = fake({ otp: odd });
    await handler(req({ action: "request-link", email: "sam@x.test" }));
    const m = calls.find((c) => c.url.includes("api.resend.com"));
    check("C8 odd code (" + JSON.stringify(odd) + "): link only", m && m.body.html.includes("#t=HASHTOKEN123") && !/planner app on your phone/.test(m.body.html));
  }

  calls = fake({});
  r = await handler(req({ action: "invite", email: "sam@x.test" }));
  check("C9 an invite still needs an admin", r.statusCode === 403 && !calls.some((c) => c.url.includes("api.resend.com")));

  if (fails.length) { console.log(passes + " passed, FAILED:\n  " + fails.join("\n  ")); process.exit(1); }
  console.log("ALL " + passes + " ASSERTIONS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
