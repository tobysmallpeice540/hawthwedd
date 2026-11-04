// tests/gmail-copy-test.cjs
//
// netlify/functions/mail-lib/gmail-copy.js — filing a copy of each automated
// customer email in the farm Gmail's Sent (4 Nov 2026), Google and Resend
// faked at fetch:
//   · the copy is a proper email (text + HTML, attachments, non-ASCII safe),
//     labelled SENT only, with the Message-ID Resend gave the delivered email;
//   · without Resend's id it still files, under an id of our own;
//   · it NEVER throws — every failure comes back as { ok: false, why };
//   · without the insert permission nothing is attempted;
//   · it gives up within its budget;
//   · which senders call it: never the sign-in emails, the contract invite,
//     the box office tickets or the office's own copies.
//
//   node tests/gmail-copy-test.cjs

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
process.env.SUPABASE_SERVICE_KEY = "svc";
process.env.RESEND_API_KEY = "re_test";
process.env.HBF_ADMIN_TOKEN = "office-token";
process.env.GOOGLE_CLIENT_SECRET = "google-secret";
process.env.HBF_TEST_FAST = "1";
const G = require("../netlify/functions/mail-lib/gmail-copy.js");

let pass = 0, fail = 0;
function ok(label, cond, detail) { if (cond) { pass++; console.log("  ok   " + label); } else { fail++; console.log("  FAIL " + label + (detail ? "  " + detail : "")); } }

function seal(plain) {
  const key = crypto.createHash("sha256").update("office-token|airbnb-gmail-refresh-token").digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
const INSERT = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.insert";

function world(o) {
  o = o || {};
  G._reset();
  const calls = { copies: [], resendGets: 0, token: 0 };
  global.fetch = async (url, init) => {
    const method = (init && init.method) || "GET";
    const json = (v, status) => ({ ok: (status || 200) < 300, status: status || 200, json: async () => v, text: async () => JSON.stringify(v) });
    if (o.hang) {
      return new Promise((resolve, reject) => {
        if (init && init.signal) init.signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); });
      });
    }
    if (o.explode) throw new Error("network down");
    if (/airbnb_mail_state/.test(url)) return json(o.noRow ? [] : [{ token_enc: seal("refresh-123") }]);
    if (/oauth2\.googleapis\.com\/token/.test(url)) { calls.token++; return json({ access_token: "acc", scope: o.scope == null ? INSERT : o.scope, expires_in: 3599 }); }
    if (/api\.resend\.com\/emails\/(\w+)$/.test(url) && method === "GET") {
      calls.resendGets++;
      return o.noMessageId ? json({ id: "x" }) : json({ id: "re_1", message_id: "<0100abc@eu-west-1.amazonses.com>" });
    }
    if (/upload\/gmail\/v1\/users\/me\/messages\?uploadType=multipart&internalDateSource=dateHeader$/.test(url) && method === "POST") {
      calls.copies.push(init);
      if (o.copyStatus) return json({ error: "no" }, o.copyStatus);
      return json({ id: "gm" + calls.copies.length });
    }
    throw new Error("unexpected fetch " + method + " " + url);
  };
  return calls;
}
function rfc822(init) { return init.body.split("Content-Type: message/rfc822\r\n\r\n")[1]; }

(async () => {
  console.log("a copy, with attachments");
  {
    const w = world();
    const pdf = Buffer.from("%PDF-1.4 a signed form").toString("base64");
    const r = await G.fileSentCopy({ to: "guest@example.com", subject: "Your stay — Hawthbush Farm", html: "<p>Hello <b>Ann</b></p>",
      text: "Hello Ann", attachments: [{ filename: "Arrival pack.pdf", content: pdf }], resendId: "re_1" });
    ok("filed", r.ok && r.gmailId === "gm1", JSON.stringify(r));
    const raw = rfc822(w.copies[0]);
    const head = raw.split("\r\n\r\n")[0];
    ok("the Message-ID Resend gave the email", /^Message-ID: <0100abc@eu-west-1\.amazonses\.com>$/m.test(head), head);
    ok("labelled SENT only", /\{"labelIds":\["SENT"\]\}/.test(w.copies[0].body));
    ok("mixed: the alternative parts, then the attachment", /Content-Type: multipart\/mixed/.test(head) && /multipart\/alternative/.test(raw));
    ok("the PDF is attached whole", /Content-Type: application\/pdf; name="Arrival pack.pdf"/.test(raw) && raw.indexOf(pdf.slice(0, 20)) !== -1);
    ok("a Date header (the copy is dated by it)", /^Date: .+ \+0000$/m.test(head), head);
    ok("subject with a dash is encoded, not mangled", /^Subject: =\?UTF-8\?B\?/m.test(head));
  }

  console.log("without Resend's Message-ID");
  {
    const w = world({ noMessageId: true });
    const r = await G.fileSentCopy({ to: ["a@example.com", "b@example.com"], subject: "Hi", html: "<p>x</p>", resendId: "re_1" });
    const head = rfc822(w.copies[0]).split("\r\n\r\n")[0];
    ok("still filed, under an id of our own", r.ok && /^Message-ID: <hbf-[0-9a-f-]{36}@hawthbushfarm\.co\.uk>$/m.test(head), head);
    ok("both recipients", /^To: a@example\.com, b@example\.com$/m.test(head));
    ok("text made from the HTML when none is given", /text\/plain/.test(rfc822(w.copies[0])));
    ok("asked Resend twice, then gave up waiting", w.resendGets === 2);
  }

  console.log("never throws");
  {
    world({ explode: true });
    const r = await G.fileSentCopy({ to: "a@example.com", subject: "x", html: "x" });
    ok("network down → { ok: false }", r.ok === false && /network down/.test(r.why), JSON.stringify(r));
  }
  {
    world({ noRow: true });
    const r = await G.fileSentCopy({ to: "a@example.com", subject: "x", html: "x" });
    ok("Gmail not connected → { ok: false }", r.ok === false && /not connected/.test(r.why));
  }
  {
    const w = world({ copyStatus: 401 });
    const r = await G.fileSentCopy({ to: "a@example.com", subject: "x", html: "x", resendId: "re_1" });
    ok("Gmail refuses → { ok: false } with the status", r.ok === false && /Gmail 401/.test(r.why));
    world();
    await G.fileSentCopy({ to: "a@example.com", subject: "x", html: "x" });
  }
  {
    const r = await G.fileSentCopy({ to: "", subject: "x", html: "x" });
    ok("no recipient → { ok: false }", r.ok === false);
  }
  {
    const r = await G.fileSentCopy(null);
    ok("nothing at all → { ok: false }", r.ok === false);
  }
  {
    world({ hang: true });
    const t = Date.now();
    const r = await G.fileSentCopy({ to: "a@example.com", subject: "x", html: "x", budgetMs: 600 });
    ok("a hung Google gives up within its budget", r.ok === false && Date.now() - t < 1500, (Date.now() - t) + "ms " + JSON.stringify(r));
  }

  console.log("permission");
  {
    const w = world({ scope: "https://www.googleapis.com/auth/gmail.readonly" });
    const r = await G.fileSentCopy({ to: "a@example.com", subject: "x", html: "x", resendId: "re_1" });
    ok("read-only connection: nothing attempted", r.ok === false && w.copies.length === 0 && w.resendGets === 0 && /permission/.test(r.why));
    const ready = await G.copyReady();
    ok("copyReady says so", ready.ok === false && /not allowed/.test(ready.why));
  }
  {
    const w = world();
    await G.fileSentCopy({ to: "a@example.com", subject: "x", html: "x" });
    await G.fileSentCopy({ to: "b@example.com", subject: "y", html: "y" });
    ok("one token for several copies", w.token === 1);
    ok("modify and full access count too", G.canCopy("https://www.googleapis.com/auth/gmail.modify") && G.canCopy("https://mail.google.com/") && !G.canCopy("https://www.googleapis.com/auth/gmail.send"));
  }

  console.log("header injection");
  {
    const raw = G.buildMime({ to: ["a@example.com\r\nBcc: evil@example.com"], subject: "Hi\r\nBcc: evil@example.com", html: "x", messageId: "<m@x>" });
    const head = raw.split("\r\n\r\n")[0];
    ok("a line break in an address or subject cannot add a header", !/^Bcc:/m.test(head), head);
  }

  console.log("who calls it");
  {
    const dir = path.join(__dirname, "../netlify/functions");
    const src = (f) => fs.readFileSync(path.join(dir, f), "utf8");
    ["portal-auth.js", "send-ticket-email.js", "send-cleaning-summary.js", "submit-viewing.js", "whatsapp-webhook.js"].forEach((f) => {
      ok(f + " files nothing (sign-in links, tickets, staff and office emails)", src(f).indexOf("gmail-copy") === -1);
    });
    ["automations.js", "handle-viewing.js", "portal-nudges.js", "send-accom-email.js", "send-accom-reminders.js",
     "stripe-accom-webhook.js", "stripe-ticket-webhook.js", "submit-brochure.js", "contract-lib/common.js"].forEach((f) => {
      ok(f + " files its customer emails", /fileSentCopy\(/.test(src(f)));
    });
    const admin = src("contract-admin.js");
    ok("the contract invite (a sign-in link) is never copied", !/copy:\s*true/.test(admin));
    const ticket = src("stripe-ticket-webhook.js");
    ok("ticket webhook: only the couple's bar emails, never the office's", /if \(to !== OFFICE_EMAIL\)/.test(ticket));
    ok("ticket webhook: the ticket email itself is not copied", ticket.split("fileSentCopy(").length === 2);
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
