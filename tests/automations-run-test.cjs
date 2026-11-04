// tests/automations-run-test.cjs
//
// The daily follow-up run end to end (netlify/functions/automations.js), with
// Supabase, Google and Resend faked at fetch:
//   · it looks in the farm Gmail (the Airbnb-mail connection's sealed token)
//     for the enquiries it may act on, so nobody has to open Enquiries first;
//   · an enquiry Gmail shows a reply from is not emailed; one with nothing is;
//   · "mark Freezing" sets that one enquiry's temperature, written only if
//     the list is unchanged since it was read;
//   · if the farm Gmail cannot be reached it falls back to the app's cache —
//     and an address that cache never checked is not emailed;
//   · each email sent (through Resend) is filed in the farm Gmail's Sent with
//     the Message-ID Resend gave it (4 Nov 2026), when the connection may
//     insert; a copy that fails never fails, unmarks or re-sends the email.
//
//   node tests/automations-run-test.cjs

const crypto = require("crypto");
process.env.SUPABASE_SERVICE_KEY = "svc";
process.env.RESEND_API_KEY = "re_test";
process.env.HBF_ADMIN_TOKEN = "office-token";
process.env.GOOGLE_CLIENT_SECRET = "google-secret";
process.env.HBF_TEST_FAST = "1";
const fn = require("../netlify/functions/automations.js");
const GmailCopy = require("../netlify/functions/mail-lib/gmail-copy.js");

let pass = 0, fail = 0;
function ok(label, cond, detail) { if (cond) { pass++; console.log("  ok   " + label); } else { fail++; console.log("  FAIL " + label + (detail ? "  " + detail : "")); } }

function seal(plain) {
  const key = crypto.createHash("sha256").update("office-token|airbnb-gmail-refresh-token").digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
const plus = (n) => new Date(Date.parse(today + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const enq = (id, arrived, extra) => Object.assign({ id: "enq_" + Date.parse(arrived + "T10:00:00Z") + id, name: id + " Person",
  email: id + "@example.com", outcome: "undecided", temperature: "cold", contacts: [{ date: arrived, method: "email" }], viewings: [] }, extra || {});

function world(opts) {
  const o = opts || {};
  const E1 = enq("quiet", plus(-3));                               // nothing since: first follow-up
  const E2 = enq("replied", plus(-3));                             // they emailed yesterday (only Gmail knows)
  const E3 = enq("frozen", plus(-60), { contacts: [{ date: plus(-60) }] }); // second went 10 days ago
  const db = {
    hbf_automations_v1: { followup: { on: true, days: 3 }, second: { on: true, days: 21, freezeOn: true, freezeDays: 7 } },
    hbf_enquiries_v1: [E1, E2, E3],
    hawthbush_bookings_v6: [],
    hbf_enquiry_email_seen_v1: {},                                 // the app's cache has looked at nobody
    hbf_automation_sent_v1: { ["enq:" + E3.id]: { followup: plus(-57) + "T09:00:00Z", second: plus(-10) + "T09:00:00Z" } },
    hbf_email_log_v1: []
  };
  GmailCopy._reset();
  const calls = { gmailQ: [], sends: [], copies: [], patches: [], token: 0 };
  global.fetch = async (url, init) => {
    const method = (init && init.method) || "GET";
    const json = (v, status) => ({ ok: (status || 200) < 300, status: status || 200, json: async () => v, text: async () => JSON.stringify(v) });
    let m;
    if ((m = /\/rest\/v1\/app_data\?key=eq\.(\w+)&select=value,updated_at$/.exec(url))) return json([{ value: db[m[1]], updated_at: "2026-01-01T00:00:00Z" }]);
    if ((m = /\/rest\/v1\/app_data\?key=eq\.(\w+)&select=value$/.exec(url))) return json(db[m[1]] === undefined ? [] : [{ value: db[m[1]] }]);
    if (/\/rest\/v1\/app_data\?key=eq\.hbf_enquiries_v1&updated_at=eq\./.test(url) && method === "PATCH") {
      const body = JSON.parse(init.body); calls.patches.push(url); db.hbf_enquiries_v1 = body.value; return json([{}]);
    }
    if (/\/rest\/v1\/app_data$/.test(url) && method === "POST") { const b = JSON.parse(init.body); db[b.key] = b.value; return json({}, 201); }
    if (/airbnb_mail_state/.test(url)) return json(o.noGmail ? [] : [{ token_enc: seal("refresh-123"), account_email: "hawthbushfarm@gmail.com" }]);
    if (/oauth2\.googleapis\.com\/token/.test(url)) {
      calls.token++;
      const p = new URLSearchParams(init.body);
      return p.get("refresh_token") === "refresh-123"
        ? json({ access_token: "acc", scope: "https://www.googleapis.com/auth/gmail.readonly" + (o.canFile ? " https://www.googleapis.com/auth/gmail.insert" : "") })
        : json({ error: "invalid_grant" }, 400);
    }
    if ((m = /gmail\/v1\/users\/me\/messages\?maxResults=1&q=(.*)$/.exec(url))) {
      const q = decodeURIComponent(m[1]); calls.gmailQ.push(q);
      return json(/replied@example\.com/.test(q) ? { messages: [{ id: "m2" }] } : {});
    }
    if (/gmail\/v1\/users\/me\/messages\/m2\?format=minimal/.test(url)) return json({ internalDate: String(Date.parse(plus(-1) + "T12:00:00Z")) });
    if (/upload\/gmail\/v1\/users\/me\/messages\?uploadType=multipart/.test(url) && method === "POST") {
      calls.copies.push({ url: url, body: init.body, type: init.headers["Content-Type"] });
      if (o.copyStatus) return json({ error: { code: o.copyStatus } }, o.copyStatus);
      return json({ id: "g" + calls.copies.length });
    }
    if ((m = /api\.resend\.com\/emails\/(r\d+)$/.exec(url)) && method === "GET") return json({ id: m[1], message_id: "<" + m[1] + "@eu-west-1.amazonses.com>" });
    if (/api\.resend\.com\/emails$/.test(url) && method === "POST") { calls.sends.push(JSON.parse(init.body)); return json({ id: "r" + calls.sends.length }); }
    throw new Error("unexpected fetch " + method + " " + url);
  };
  return { db, calls, E1, E2, E3 };
}
const run = () => fn.handler({ httpMethod: "POST", headers: { "x-admin-token": "office-token" }, body: "{}" });

(async () => {
  console.log("with the farm Gmail");
  {
    const w = world();
    const res = await run();
    const body = JSON.parse(res.body);
    ok("ran cleanly", res.statusCode === 200, res.body);
    ok("used the farm Gmail", body.gmail && body.gmail.source === "farm" && body.gmail.account === "hawthbushfarm@gmail.com", JSON.stringify(body.gmail));
    ok("asked Gmail about each address it might act on", ["quiet@", "replied@", "frozen@"].every((a) => w.calls.gmailQ.some((q) => q.indexOf(a) !== -1)), JSON.stringify(w.calls.gmailQ));
    ok("emailed the one with nothing since", w.calls.sends.length === 1 && w.calls.sends[0].to[0] === "quiet@example.com", JSON.stringify(w.calls.sends.map((s) => s.to)));
    ok("not the one Gmail shows replied", !w.calls.sends.some((s) => s.to[0] === "replied@example.com"));
    const fz = w.db.hbf_enquiries_v1.find((e) => e.id === w.E3.id);
    ok("marked Freezing after the second", fz.temperature === "freezing" && fz.autoFrozenAfter === "second" && fz.autoFrozenAt === today, JSON.stringify(fz));
    ok("the others untouched", w.db.hbf_enquiries_v1.filter((e) => e.id !== w.E3.id).every((e) => e.temperature === "cold" && !e.autoFrozenAt));
    ok("written only if unchanged since read", w.calls.patches.length === 1 && /updated_at=eq\./.test(w.calls.patches[0]));
    const marks = w.db.hbf_automation_sent_v1;
    ok("recorded: first follow-up and the freeze", marks["enq:" + w.E1.id].followup && marks["enq:" + w.E3.id].frozen && marks["enq:" + w.E3.id].frozen_after === "second", JSON.stringify(marks));
    ok("frozen reported", body.frozen === 1);

    // the next morning: nothing again
    w.calls.sends.length = 0;
    const again = JSON.parse((await run()).body);
    ok("next run: nothing twice", w.calls.sends.length === 0 && !again.frozen, JSON.stringify(again));
  }

  console.log("farm Gmail not connected: the app's cache");
  {
    const w = world({ noGmail: true });
    const res = await run();
    const body = JSON.parse(res.body);
    ok("says it fell back", body.gmail && body.gmail.source === "app" && /not connected/.test(body.gmail.error || ""), JSON.stringify(body.gmail));
    ok("an address the cache never checked is not emailed", w.calls.sends.length === 0);
    ok("nor frozen", w.db.hbf_enquiries_v1.every((e) => e.temperature === "cold"));
  }

  console.log("a copy in the farm Gmail's Sent");
  {
    const w = world({ canFile: true });
    const res = await run();
    const body = JSON.parse(res.body);
    ok("ran cleanly", res.statusCode === 200, res.body);
    ok("sent by Resend, as before", w.calls.sends.length === 1 && w.calls.sends[0].to[0] === "quiet@example.com", JSON.stringify(w.calls.sends));
    ok("and filed once in Gmail", w.calls.copies.length === 1, JSON.stringify(w.calls.copies.map((c) => c.url)));
    const c = w.calls.copies[0] || { body: "" };
    ok("filed in Sent, dated by its own Date header", /"labelIds":\["SENT"\]/.test(c.body) && /internalDateSource=dateHeader/.test(c.url) && /multipart\/related/.test(c.type));
    const head = c.body.split("Content-Type: message/rfc822\r\n\r\n")[1].split("\r\n\r\n")[0];
    ok("from hello@, to the enquirer", /^From: Hawthbush Farm <hello@hawthbushfarm\.co\.uk>$/m.test(head) && /^To: quiet@example\.com$/m.test(head), head);
    ok("the SAME Message-ID Resend gave it, so the reply threads", /^Message-ID: <r1@eu-west-1\.amazonses\.com>$/m.test(head), head);
    const subj = (/^Subject: (.*)$/m.exec(head) || [])[1] || "";
    const dec = /^=\?UTF-8\?B\?(.*)\?=$/.exec(subj);
    ok("subject survives its dash", (dec ? Buffer.from(dec[1], "base64").toString("utf8") : subj) === "Following up on your enquiry — Hawthbush Farm", subj);
    ok("text and HTML both", /Content-Type: text\/plain; charset=UTF-8/.test(c.body) && /Content-Type: text\/html; charset=UTF-8/.test(c.body));
    ok("never marked unread or put in the inbox", !/UNREAD|INBOX/.test(c.body.split("\r\n\r\n")[1] || ""));
    const log = w.db.hbf_email_log_v1;
    ok("logged with its Gmail id, so the archive does not copy it twice", log.length === 1 && log[0].gmailId === "g1", JSON.stringify(log));
    ok("reported as copied", body.sent[0].copied === true && !body.copyMisses, JSON.stringify(body));
  }
  {
    const w = world();                                             // connected without the insert permission
    const body = JSON.parse((await run()).body);
    ok("no permission to file: sent all the same, nothing filed", w.calls.sends.length === 1 && w.calls.copies.length === 0);
    ok("…and the log entry has no Gmail id, so the archive copies it as before", !w.db.hbf_email_log_v1[0].gmailId);
    ok("…and says why", body.copyMisses && /permission/.test(body.copyMisses[0]), JSON.stringify(body.copyMisses));
  }
  {
    const w = world({ canFile: true, copyStatus: 500 });
    const res = await run();
    const body = JSON.parse(res.body);
    ok("Gmail refuses the copy: the email still counts as sent", res.statusCode === 200 && body.sent.length === 1 && !body.failed.length, res.body);
    const marks = w.db.hbf_automation_sent_v1["enq:" + w.E1.id];
    ok("…stays marked (never re-sent tomorrow)", marks && marks.followup, JSON.stringify(marks));
    ok("…and is logged without a Gmail id", w.db.hbf_email_log_v1.length === 1 && !w.db.hbf_email_log_v1[0].gmailId);
  }

  console.log("dry run (the Settings preview)");
  {
    const w = world();
    global.fetch = ((inner) => async (url, init) => {
      if (/\/auth\/v1\/user/.test(url)) return { ok: true, json: async () => ({ id: "u1" }) };
      if (/\/rest\/v1\/profiles/.test(url)) return { ok: true, json: async () => [{ role: "admin", active: true }] };
      return inner(url, init);
    })(global.fetch);
    const res = await fn.handler({ httpMethod: "POST", headers: { authorization: "Bearer admin-jwt" }, body: JSON.stringify({ dryRun: true }) });
    const body = JSON.parse(res.body);
    ok("preview lists the email and the freeze", body.due.length === 1 && body.freeze.length === 1 && body.freeze[0].after === "second", res.body.slice(0, 400));
    ok("preview sends and writes nothing", w.calls.sends.length === 0 && w.calls.patches.length === 0);
    ok("preview says Gmail was checked", body.gmail && body.gmail.source === "farm");
    ok("preview says whether copies would be filed", body.sentCopy && body.sentCopy.ok === false && /not allowed/.test(body.sentCopy.why), JSON.stringify(body.sentCopy));
    ok("preview files nothing", w.calls.copies.length === 0);
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
