// tests/email-archive-run-test.cjs
//
// The email archive end to end (netlify/functions/email-archive), with
// Supabase, Google and storage faked at fetch:
//   · the first run reads each record address back to 2025, stores its emails
//     (and the app's own), and notes the rest of the mailbox as nobody's;
//   · the next run reads nothing twice; a new email is picked up by the recent
//     look; a new enquiry's older emails are read back on its own;
//   · Gmail saying "slow down" stops the run without losing its place;
//   · not connected: the app's own emails are still kept;
//   · two-year purge: daily, with the addresses to keep;
//   · "Save to files": admins only, only an attachment in the archive, stored
//     in the bucket under the record's folder.
//
//   node tests/email-archive-run-test.cjs

const crypto = require("crypto");
process.env.SUPABASE_SERVICE_KEY = "svc";
process.env.HBF_ADMIN_TOKEN = "office-token";
process.env.GOOGLE_CLIENT_SECRET = "google-secret";
const fn = require("../netlify/functions/email-archive/email-archive.js");

let pass = 0, fail = 0;
function ok(label, cond, detail) { if (cond) { pass++; console.log("  ok   " + label); } else { fail++; console.log("  FAIL " + label + (detail ? "  " + detail : "")); } }

function seal(plain) {
  const key = crypto.createHash("sha256").update("office-token|airbnb-gmail-refresh-token").digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
const b64 = (s) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
const daysAgo = (n) => Date.now() - n * 86400000;

function mail(id, at, labels, from, to, text, atts) {
  return { id: id, threadId: "t" + id, internalDate: String(at), labelIds: labels,
    payload: { mimeType: "multipart/mixed", headers: [{ name: "From", value: from }, { name: "To", value: to }, { name: "Subject", value: "Subject " + id }, { name: "Message-ID", value: "<" + id + "@m>" }],
      parts: [{ partId: "0", mimeType: "text/plain", body: { data: b64(text) } }].concat((atts || []).map((a, i) => ({
        partId: String(i + 1), filename: a, mimeType: "application/pdf", headers: [{ name: "Content-Disposition", value: "attachment" }],
        body: { attachmentId: "fresh-" + Math.random(), size: 90000 } }))) } };
}

function world(opts) {
  const o = opts || {};
  const db = {
    app: {
      hawthbush_bookings_v6: [{ id: 1, email: "couple@x.com" }],
      hbf_enquiries_v1: [{ id: "e1", email: "Amy@X.com", outcome: "undecided" }],
      hbf_accom_v1: [{ id: "A12", email: "guest@z.com" }],
      hbf_email_log_v1: [{ id: "L1", sentAt: new Date(daysAgo(30)).toISOString(), to: "amy@x.com", subject: "Your brochure", template: "brochure_request", body: "Here" }]
    },
    state: { id: 1, last_ok_at: null, app_log_upto: null, last_purge_at: null },
    messages: {}, seen: {}, addresses: {}, purges: [], uploads: []
  };
  const box = {
    m1: mail("m1", Date.parse("2025-03-01T10:00:00Z"), ["INBOX"], "Amy <amy@x.com>", "hawthbushfarm@gmail.com", "Can we visit?\n\nOn Mon, X wrote:\n> old", ["plan.pdf"]),
    m2: mail("m2", daysAgo(1), ["SENT"], "hello@hawthbushfarm.co.uk", "amy@x.com", "Of course"),
    m3: mail("m3", daysAgo(1), ["INBOX"], "shop@spam.com", "hawthbushfarm@gmail.com", "SALE"),
    m4: mail("m4", Date.parse("2025-05-01T10:00:00Z"), ["INBOX"], "guest@z.com", "hawthbushfarm@gmail.com", "Arriving at 4"),
    m5: mail("m5", daysAgo(1), ["DRAFT"], "hawthbushfarm@gmail.com", "amy@x.com", "draft")
  };
  const calls = { list: [], meta: [], full: [], att: 0, token: 0 };
  const addrsOf = (m) => m.payload.headers.filter((h) => /^(from|to|cc|bcc)$/i.test(h.name)).map((h) => (/<([^>]+)>/.exec(h.value) || [, h.value])[1].toLowerCase());
  global.fetch = async (url, init) => {
    const method = (init && init.method) || "GET";
    const res = (v, status) => ({ ok: (status || 200) < 300, status: status || 200, json: async () => v, text: async () => (typeof v === "string" ? v : JSON.stringify(v)) });
    let m;
    // Supabase
    if ((m = /\/rest\/v1\/app_data\?key=eq\.(\w+)&select=value$/.exec(url))) return res(db.app[m[1]] === undefined ? [] : [{ value: db.app[m[1]] }]);
    if (/\/rest\/v1\/email_archive_state\?id=eq\.1&select=\*/.test(url)) return res([db.state]);
    if (/\/rest\/v1\/email_archive_state\?id=eq\.1/.test(url) && method === "PATCH") { Object.assign(db.state, JSON.parse(init.body)); return res(""); }
    if (/airbnb_mail_state/.test(url)) return res(o.noGmail ? [] : [{ token_enc: seal("refresh-123"), account_email: "hawthbushfarm@gmail.com" }]);
    if ((m = /\/rest\/v1\/(email_messages|email_archive_seen)\?select=gmail_id&gmail_id=in\.\((.*)\)$/.exec(url))) {
      const store = m[1] === "email_messages" ? db.messages : db.seen;
      return res(decodeURIComponent(m[2]).split(",").filter((id) => store[id]).map((id) => ({ gmail_id: id })));
    }
    if ((m = /\/rest\/v1\/email_messages\?gmail_id=eq\.([^&]+)&select=/.exec(url))) { const r = db.messages[decodeURIComponent(m[1])]; return res(r ? [r] : []); }
    if (/\/rest\/v1\/email_archive_addresses\?select=addr/.test(url)) return res(Object.keys(db.addresses).map((a) => ({ addr: a })));
    if (/\/rest\/v1\/rpc\/email_ingest$/.test(url)) {
      const p = JSON.parse(init.body).p; let n = 0;
      (p.messages || []).forEach((r) => { if (!db.messages[r.gmail_id]) { db.messages[r.gmail_id] = r; n++; } });
      (p.seen || []).forEach((id) => { db.seen[id] = true; });
      (p.addresses_done || []).forEach((a) => { db.addresses[a.addr] = a.found; });
      return res({ ok: true, messages: n, seen: (p.seen || []).length, addresses: (p.addresses_done || []).length });
    }
    if (/\/rest\/v1\/rpc\/email_purge$/.test(url)) { db.purges.push(JSON.parse(init.body)); db.state.last_purge_at = new Date().toISOString(); return res(0); }
    if (/\/auth\/v1\/user/.test(url)) return res(o.caller ? { id: "u1" } : {}, o.caller ? 200 : 401);
    if (/\/rest\/v1\/profiles/.test(url)) return res([{ role: o.caller, active: true }]);
    if ((m = /\/storage\/v1\/object\/booking-files\/(.+)$/.exec(url)) && method === "POST") { db.uploads.push({ path: m[1], bytes: init.body.length, type: init.headers["Content-Type"] }); return res({ Key: m[1] }); }
    // Google
    if (/oauth2\.googleapis\.com\/token/.test(url)) { calls.token++; return res({ access_token: "acc" }); }
    if ((m = /gmail\/v1\/users\/me\/messages\?maxResults=500&q=([^&]*)/.exec(url))) {
      const q = decodeURIComponent(m[1]); calls.list.push(q);
      if (o.throttleList) return res({ error: { message: "Quota exceeded" } }, 429);
      const after = /after:(\d{4})\/(\d\d)\/(\d\d)/.exec(q);
      const since = after ? Date.parse(after[1] + "-" + after[2] + "-" + after[3] + "T00:00:00Z") : 0;
      const want = /^\{/.test(q) ? (q.match(/from:([^\s}]+)/g) || []).map((x) => x.slice(5)) : null;
      const ids = Object.values(box).filter((x) => Number(x.internalDate) >= since && (!want || addrsOf(x).some((a) => want.indexOf(a) !== -1))
        && !(/-from:airbnb\.com/.test(q) && addrsOf(x)[0].indexOf("airbnb") !== -1)).map((x) => ({ id: x.id }));
      return res({ messages: ids });
    }
    if ((m = /gmail\/v1\/users\/me\/messages\/(\w+)\?format=metadata/.exec(url))) { calls.meta.push(m[1]); return res(box[m[1]]); }
    if ((m = /gmail\/v1\/users\/me\/messages\/(\w+)\?format=full/.exec(url))) {
      calls.full.push(m[1]);
      if (o.throttleFull) return res({ error: { message: "Too many" } }, 429);
      return res(box[m[1]]);
    }
    if ((m = /gmail\/v1\/users\/me\/messages\/(\w+)\/attachments\/(.+)$/.exec(url))) { calls.att++; return res({ data: b64("%PDF-1.4 the plan") }); }
    throw new Error("unexpected fetch " + method + " " + url);
  };
  return { db, box, calls, o };
}
const cron = () => fn.handler({ httpMethod: "POST", headers: { "x-admin-token": "office-token" }, body: JSON.stringify({ action: "sync" }) });
const asStaff = (body) => fn.handler({ httpMethod: "POST", headers: { authorization: "Bearer jwt" }, body: JSON.stringify(body) });

(async () => {
  console.log("the first run");
  const w = world();
  let r = JSON.parse((await cron()).body);
  ok("ran cleanly, connected", r.ok && r.connected && r.account === "hawthbushfarm@gmail.com", JSON.stringify(r));
  ok("stored each record's emails, old and new", ["m1", "m2", "m4"].every((id) => w.db.messages[id]), Object.keys(w.db.messages).join());
  ok("not the shop's, nor a draft", !w.db.messages.m3 && !w.db.messages.m5 && w.db.seen.m3 && w.db.seen.m5);
  ok("the app's own email copied in", w.db.messages["app:L1"] && w.db.messages["app:L1"].kind === "brochure_request");
  ok("which way", w.db.messages.m1.direction === "in" && w.db.messages.m2.direction === "out");
  ok("the quoted history cut, the attachment listed", w.db.messages.m1.body === "Can we visit?" && w.db.messages.m1.attachments[0].name === "plan.pdf");
  ok("every address read back", ["amy@x.com", "guest@z.com", "couple@x.com"].every((a) => a in w.db.addresses));
  ok("read back from the start of 2025", w.calls.list.some((q) => /^\{.*\} after:2025\/01\/01/.test(q)));
  ok("the shop's email was only looked at, not read", w.calls.full.indexOf("m3") === -1 && w.calls.meta.indexOf("m3") !== -1);
  ok("nothing more to do", r.more === false && r.pending === 0 && w.db.state.last_ok_at, JSON.stringify(r));
  ok("purged once, keeping events, lettings and booking ids, not the undecided enquiry",
    w.db.purges.length === 1 && ["couple@x.com", "guest@z.com", "A12"].every((a) => w.db.purges[0].p_keep.indexOf(a) !== -1) && w.db.purges[0].p_keep.indexOf("amy@x.com") === -1,
    JSON.stringify(w.db.purges));

  console.log("the next run");
  w.calls.full.length = 0; w.calls.meta.length = 0;
  r = JSON.parse((await cron()).body);
  ok("reads nothing twice", w.calls.full.length === 0 && w.calls.meta.length === 0, JSON.stringify(w.calls));
  ok("purges only once a day", w.db.purges.length === 1);

  console.log("a new email, and a new enquiry");
  w.box.m6 = mail("m6", daysAgo(0.1), ["INBOX"], "amy@x.com", "hawthbushfarm@gmail.com", "One more thing");
  w.box.m7 = mail("m7", Date.parse("2025-06-01T10:00:00Z"), ["INBOX"], "Late <late@x.com>", "hawthbushfarm@gmail.com", "Hello from June");
  r = JSON.parse((await cron()).body);
  ok("the new email is picked up", !!w.db.messages.m6 && w.calls.meta.indexOf("m6") !== -1);
  ok("an address nobody has yet: not stored", !w.db.messages.m7);
  w.db.app.hbf_enquiries_v1.push({ id: "e2", email: "late@x.com" });
  r = JSON.parse((await cron()).body);
  ok("once it is an enquiry, its older email is read back", !!w.db.messages.m7 && "late@x.com" in w.db.addresses, JSON.stringify(r));

  console.log("Gmail says slow down");
  {
    const t = world({ throttleFull: true });
    const before = t.db.state.last_ok_at;
    r = JSON.parse((await cron()).body);
    ok("stops as throttled, not failed", r.ok && r.throttled && /slow down/.test(r.error || ""), JSON.stringify(r));
    ok("nothing marked done that was not read", Object.keys(t.db.addresses).length === 0 || !("amy@x.com" in t.db.addresses));
    ok("its place kept: last good run not moved on", t.db.state.last_ok_at === before);
    ok("still says there is more", r.more === true);
  }

  console.log("not connected");
  {
    const n = world({ noGmail: true });
    r = JSON.parse((await cron()).body);
    ok("says so", r.ok && r.connected === false && /not connected/.test(r.error || ""), JSON.stringify(r));
    ok("the app's own emails are still kept", !!n.db.messages["app:L1"]);
  }

  console.log("Save to files");
  {
    const s = world({ caller: "admin" });
    await cron();
    let res = await asStaff({ action: "attachment", gmail_id: "m1", part: "1", folder: "enquirys/e1" });
    let body = JSON.parse(res.body);
    ok("saved", res.statusCode === 200 && body.ok && body.name === "plan.pdf" && body.direction === "in", res.body);
    ok("under the record's folder, in the bucket", s.db.uploads.length === 1 && /^enquirys\/e1\/\d+_plan\.pdf$/.test(s.db.uploads[0].path) && s.db.uploads[0].type === "application/pdf" && s.db.uploads[0].bytes > 0, JSON.stringify(s.db.uploads));
    ok("the attachment read with a fresh id", s.calls.att === 1);
    res = await asStaff({ action: "attachment", gmail_id: "m1", part: "9", folder: "enquirys/e1" });
    ok("not an attachment the archive lists", res.statusCode === 404);
    res = await asStaff({ action: "attachment", gmail_id: "m3", part: "1", folder: "enquirys/e1" });
    ok("not from an email outside the archive", res.statusCode === 404);
    res = await asStaff({ action: "attachment", gmail_id: "m1", part: "1", folder: "../etc" });
    ok("not to any folder", res.statusCode === 400);
    const bar = world({ caller: "bar" });
    res = await asStaff({ action: "attachment", gmail_id: "m1", part: "1", folder: "enquirys/e1" });
    ok("a bar login is refused", res.statusCode === 401 && bar.db.uploads.length === 0);
    res = await fn.handler({ httpMethod: "POST", headers: { "x-admin-token": "office-token" }, body: JSON.stringify({ action: "attachment", gmail_id: "m1", part: "1", folder: "enquirys/e1" }) });
    ok("the cron token cannot save files", res.statusCode === 401);
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
