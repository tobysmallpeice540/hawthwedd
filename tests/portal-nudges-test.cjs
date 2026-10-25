// tests/portal-nudges-test.cjs
//
// The weekly deadline reminder (netlify/functions/portal-nudges.js) against a
// fake Supabase and a fake Resend:
//   · the email: groups, wording, the list wherever the template puts it (or
//     added if the template lost it), names escaped, the button to /portal and
//     never a sign-in link;
//   · who may run it: the clock sends; an admin may only preview;
//   · off means nothing is sent; a week already marked is skipped; a failed
//     send gives the week back; a failed read sends nothing.
//     node tests/portal-nudges-test.cjs

const fs = require("fs"), path = require("path"), Module = require("module");
process.env.SUPABASE_SERVICE_KEY = "SERVICE";
process.env.RESEND_API_KEY = "re_test";
process.env.HBF_ADMIN_TOKEN = "tok";

const FN = path.join(__dirname, "..", "netlify", "functions", "portal-nudges.js");
const mod = new Module(FN, null); mod.filename = FN; mod.paths = Module._nodeModulePaths(path.dirname(FN));
mod._compile(fs.readFileSync(FN, "utf8"), FN);
const { handler, _test: T } = mod.exports;

let passes = 0; const fails = [];
const check = (n, ok, d) => { if (ok) passes++; else fails.push(n + (d ? ": " + d : "")); };

const PLAN = [{
  event_id: 228, event_date: "2027-05-22", couple: "Sam <b>Jones</b> & Alex Smith", client1: "Sam Jones", client2: "Alex Smith",
  emails: ["sam@x.test", "alex@x.test"],
  items: [
    { kind: "payment", label: "Final balance", due: "2027-04-24", amount: 5692.5, overdue: false },
    { kind: "task", label: "Confirm your final numbers", due: "2027-04-10", overdue: true },
    { kind: "drinks", label: "Your drinks order closes", due: "2027-04-24", overdue: false },
    { kind: "section", section: "timeline" }, { kind: "section", section: "layout" }, { kind: "section", section: "nope" }
  ]
}];

// ── the email ───────────────────────────────────────────────────────────────
const tpl = T.mergeTemplate([]);
check("E0 off unless switched on", tpl.on === false);
let m = T.planEmails(PLAN, tpl)[0];
check("E1 to every login", m.to.join(",") === "sam@x.test,alex@x.test");
check("E2 first names", /Hello Sam and Alex,/.test(m.text), m.text.slice(0, 60));
check("E3 overdue first, under its own heading", m.text.indexOf("Still to do:\n• Confirm your final numbers — was due Saturday 10 April") !== -1, m.text);
check("E4 payment with amount and day", m.text.indexOf("• Final balance: £5,692.50 — due Saturday 24 April") !== -1);
check("E5 drinks closing", m.text.indexOf("• Your drinks order closes on Saturday 24 April") !== -1);
check("E6 pages to finish, unknown keys dropped", m.text.indexOf("Still to mark as done: your timeline and your table plan") !== -1);
check("E7 event date in the opening", m.text.indexOf("on 22 May 2027") !== -1);
check("E8 names escaped in the HTML", m.html.indexOf("<b>Jones</b>") === -1 && m.html.indexOf("&lt;b&gt;Jones&lt;/b&gt;") !== -1);
check("E9 list rendered as a list in HTML", /<ul[^>]*>.*<li>Confirm your final numbers/.test(m.html));
check("E10 button to the portal, no token", m.html.indexOf('href="https://hawthbushfarm.netlify.app/portal"') !== -1 && m.html.indexOf("#t=") === -1);
check("E11 no overdue payment, no paid-recently note", m.text.indexOf("paid recently") === -1);

let m2 = T.planEmails([Object.assign({}, PLAN[0], { items: [{ kind: "payment", label: "Second payment", due: "2026-12-01", amount: 100, overdue: true }] })], tpl)[0];
check("E12 overdue payment gets the paid-recently note", m2.text.indexOf("If you have paid recently") !== -1);

const custom = T.mergeTemplate([{ id: "nudge", on: true, subject: "Nudge for {event}", body: "Hi {firstName}.\n\nNo list here, oops." }]);
m = T.planEmails(PLAN, custom)[0];
check("E13 custom template switched on and used", custom.on === true && /^Nudge for Sam/.test(m.subject));
check("E14 a template without {list} still carries the list", m.text.indexOf("Final balance") !== -1 && m.html.indexOf("<li>") !== -1);
check("E15 an event with nothing listable sends nothing",
  T.planEmails([Object.assign({}, PLAN[0], { items: [{ kind: "section", section: "nope" }] })], tpl).length === 0);
check("E16 week key is the Monday", T.weekOf("2026-10-25") === "2026-10-19" && T.weekOf("2026-10-26") === "2026-10-26" && T.weekOf("2027-01-03") === "2026-12-28");

// ── the handler ─────────────────────────────────────────────────────────────
function fake(o) {
  const calls = [];
  global.fetch = async (url, opt) => {
    const body = opt && opt.body ? JSON.parse(opt.body) : null;
    calls.push({ url, body, headers: (opt && opt.headers) || {} });
    const j = (s, b) => ({ ok: s < 300, status: s, text: async () => JSON.stringify(b), json: async () => b });
    if (url.endsWith("/auth/v1/user")) return o.user ? j(200, { id: "u1" }) : j(401, {});
    if (url.includes("/profiles?")) return j(200, [{ role: o.role || "admin", active: true }]);
    const r = url.match(/\/rpc\/(\w+)$/);
    if (r) {
      if (r[1] === "wp_nudge_plan") return o.planFails ? j(500, { message: "db down" }) : j(200, PLAN);
      if (r[1] === "wp_nudge_mark") return j(200, o.mark === undefined ? true : o.mark);
      if (r[1] === "wp_nudge_unmark") return j(200, null);
      return j(404, {});
    }
    if (url.includes("api.resend.com")) return o.resendFails ? j(500, { message: "nope" }) : j(200, { id: "em" });
    if (url.includes("app_data?key=eq.hbf_portal_email_templates_v1")) return j(200, [{ value: o.templates || [] }]);
    if (url.includes("app_data?key=eq.hbf_email_log_v1")) return j(200, [{ value: [] }]);
    if (url.endsWith("/rest/v1/app_data")) return j(201, {});
    return j(404, {});
  };
  return calls;
}
const ON = [{ id: "nudge", on: true }];
const clock = { httpMethod: "POST", headers: { "x-admin-token": "tok" }, body: "{}" };

(async () => {
  let calls = fake({});
  let r = await handler({ httpMethod: "POST", headers: {}, body: "{}" });
  check("H1 nobody may send", r.statusCode === 403 && !calls.some((c) => c.url.includes("resend")));

  calls = fake({ user: false });
  r = await handler({ httpMethod: "POST", headers: { authorization: "Bearer x" }, body: JSON.stringify({ dryRun: true }) });
  check("H2 preview needs an admin", r.statusCode === 403);

  calls = fake({ user: true, role: "bar" });
  r = await handler({ httpMethod: "POST", headers: { authorization: "Bearer x" }, body: JSON.stringify({ dryRun: true }) });
  check("H3 a bar login may not preview", r.statusCode === 403);

  calls = fake({ user: true });
  r = await handler({ httpMethod: "POST", headers: { authorization: "Bearer x" }, body: JSON.stringify({ dryRun: true, today: "2027-04-12" }) });
  let b = JSON.parse(r.body);
  const planCall = calls.find((c) => c.url.endsWith("wp_nudge_plan"));
  check("H4 admin preview: lists, sends nothing, marks nothing", r.statusCode === 200 && b.due.length === 1 && b.on === false &&
    !calls.some((c) => c.url.includes("resend") || c.url.endsWith("wp_nudge_mark")), r.body.slice(0, 200));
  check("H5 preview can be asked about another day", planCall && planCall.body.p_today === "2027-04-12" && b.week === "2027-04-12");

  calls = fake({});
  r = await handler(clock);
  b = JSON.parse(r.body);
  check("H6 switched off: nothing sent", r.statusCode === 200 && b.off === true && !calls.some((c) => c.url.includes("resend")));

  calls = fake({ templates: ON });
  r = await handler(clock);
  b = JSON.parse(r.body);
  const markIdx = calls.findIndex((c) => c.url.endsWith("wp_nudge_mark"));
  const sendIdx = calls.findIndex((c) => c.url.includes("resend"));
  check("H7 on: marked BEFORE sent, then sent once", r.statusCode === 200 && b.sent.length === 1 && markIdx !== -1 && sendIdx > markIdx, r.body);
  const sendBody = calls[sendIdx] && calls[sendIdx].body;
  check("H8 sent to the couple, reply to the office", sendBody && sendBody.to.join(",") === "sam@x.test,alex@x.test" && sendBody.reply_to === "hello@hawthbushfarm.co.uk");
  const logWrite = calls.find((c) => c.url.endsWith("/rest/v1/app_data") && c.body && c.body.key === "hbf_email_log_v1");
  check("H9 logged to Recent Automated Emails", logWrite && logWrite.body.value.length === 1 && logWrite.body.value[0].template === "portal_nudge");
  check("H10 the mark carries the week (a Monday)", /^\d{4}-\d{2}-\d{2}$/.test(calls[markIdx].body.p_week) &&
    new Date(calls[markIdx].body.p_week + "T12:00:00Z").getUTCDay() === 1);

  calls = fake({ templates: ON, mark: false });
  r = await handler(clock);
  b = JSON.parse(r.body);
  check("H11 already sent this week: skipped, not sent", b.skipped.length === 1 && !calls.some((c) => c.url.includes("resend")));

  calls = fake({ templates: ON, resendFails: true });
  r = await handler(clock);
  b = JSON.parse(r.body);
  check("H12 a failed send gives the week back", r.statusCode === 207 && b.failed.length === 1 && calls.some((c) => c.url.endsWith("wp_nudge_unmark")));

  calls = fake({ templates: ON, planFails: true });
  r = await handler(clock);
  check("H13 a failed read sends nothing", r.statusCode === 500 && !calls.some((c) => c.url.includes("resend")));

  if (fails.length) { console.log(passes + " passed, FAILED:\n  " + fails.join("\n  ")); process.exit(1); }
  console.log("ALL " + passes + " ASSERTIONS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
