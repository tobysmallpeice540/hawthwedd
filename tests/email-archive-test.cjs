// tests/email-archive-test.cjs
//
// The pure rules of the email archive (netlify/functions/email-archive/parse.js):
// whose addresses count, the text of an email with its quoted history cut off,
// which attachments are real (never a signature logo), and the rows stored.
//
//   node tests/email-archive-test.cjs

const P = require("../netlify/functions/email-archive/parse.js");

let pass = 0, fail = 0;
function ok(label, cond, detail) { if (cond) { pass++; console.log("  ok   " + label); } else { fail++; console.log("  FAIL " + label + (detail ? "  " + detail : "")); } }
const b64 = (s) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

console.log("addresses");
ok("ours: the farm Gmail, our domain, Toby's", P.isOurs("hawthbushfarm@gmail.com") && P.isOurs("Hello@HawthbushFarm.co.uk") && P.isOurs("toby@smallpeice.net"));
ok("a client's is not ours", !P.isOurs("amy@gmail.com"));
ok("Airbnb relays are not people", P.isRelay("abc123@guest.airbnb.com") && P.isRelay("x@reply.airbnb.co.uk") && !P.isRelay("airbnbfan@gmail.com"));
ok("cleaned and lower-cased", P.cleanAddr("  Amy.Smith@Gmail.COM ") === "amy.smith@gmail.com" && P.cleanAddr("not an email") === null && P.cleanAddr("a@b") === null);
ok("free text: every address", JSON.stringify(P.addrsIn("Email rosenberg.l.jessie@gmail.com, bob@x.co.uk.")) === JSON.stringify(["rosenberg.l.jessie@gmail.com", "bob@x.co.uk"]));
const list = P.parseAddressList('"Smith, Amy" <Amy@x.com>, bob@y.com; Carol <carol@z.org>, junk');
ok("header list with a comma in a quoted name", list.length === 3 && list[0].name === "Smith, Amy" && list[0].addr === "amy@x.com" && list[1].addr === "bob@y.com" && list[2].name === "Carol", JSON.stringify(list));

console.log("whose emails");
const rec = P.recordAddresses(
  [{ email: "couple@x.com", email2: "Mum@x.com", invoiceEmails: "Email pay@x.com, hello@hawthbushfarm.co.uk" }],
  [{ email: "booked@y.com", outcome: "booked" }, { email: "maybe@y.com", outcome: "undecided" }, { email: "nope@y.com", outcome: "didnotbook" }],
  [{ id: "A12", email: "guest@z.com" }, { id: "A13", email: "x9@guest.airbnb.com" }, { id: "A14", email: "toby@smallpeice.net" }]);
const all = Object.keys(rec.all).sort();
ok("every record address, none of ours or a relay", JSON.stringify(all) === JSON.stringify(["booked@y.com", "couple@x.com", "guest@z.com", "maybe@y.com", "mum@x.com", "nope@y.com", "pay@x.com"]), JSON.stringify(all));
ok("kept for ever: events, lettings, an enquiry that booked, and booking ids",
  ["couple@x.com", "mum@x.com", "pay@x.com", "guest@z.com", "booked@y.com", "A12", "A13"].every((a) => rec.keep.indexOf(a) !== -1)
  && rec.keep.indexOf("maybe@y.com") === -1 && rec.keep.indexOf("nope@y.com") === -1, JSON.stringify(rec.keep));

console.log("the text");
const gmailReply = "Lovely, see you then!\n\nAmy\n\nOn Tue, 4 Mar 2025 at 10:01, Hawthbush Farm <\nhello@hawthbushfarm.co.uk> wrote:\n\n> Dear Amy,\n> Thanks for coming.\n";
ok("Gmail's 'On … wrote:' over two lines is cut", P.stripQuoted(gmailReply) === "Lovely, see you then!\n\nAmy", JSON.stringify(P.stripQuoted(gmailReply)));
const outlook = "Yes please.\r\n\r\n________________________________\r\nFrom: Hawthbush Farm <hello@hawthbushfarm.co.uk>\r\nSent: 03 March 2025 09:00\r\nTo: Amy\r\n\r\nOld stuff";
ok("Outlook's header block is cut", P.stripQuoted(outlook) === "Yes please.");
const outlook2 = "Sounds good\n\nFrom: Toby <toby@hawthbushfarm.co.uk>\nDate: Monday, 3 March 2025\nSubject: Re: hi\n\nold";
ok("a From:/Date: block is cut", P.stripQuoted(outlook2) === "Sounds good");
const fwd = "See below from the caterer.\n\n---------- Forwarded message ---------\nFrom: Caterer <c@food.com>\nDate: Mon, 3 Mar 2025\nSubject: Menu\n\nThe menu is attached.";
ok("a forwarded message is kept", P.stripQuoted(fwd).indexOf("The menu is attached.") !== -1);
ok("only quoted lines left: the whole is kept rather than nothing", P.stripQuoted("> just a quote\n> more") === "> just a quote\n> more");
ok("Original Message", P.stripQuoted("Thanks\n-----Original Message-----\nFrom: x") === "Thanks");
const html = '<html><head><style>p{}</style></head><body><p>Hi Toby,</p><p>We&#39;d love the 14th &amp; the 15th.</p><div class="gmail_quote">On Mon wrote: old</div></body></html>';
ok("HTML: tags, entities and the gmail_quote go", P.htmlToText(html).trim() === "Hi Toby,\nWe'd love the 14th & the 15th.", JSON.stringify(P.htmlToText(html)));
const outlookHtml = '<div>Great</div><div id="appendonsend"></div><hr><div id="divRplyFwdMsg">From: us</div>';
ok("HTML: Outlook's reply block goes", P.htmlToText(outlookHtml).trim() === "Great");
const payloadPlain = { mimeType: "multipart/alternative", parts: [
  { partId: "0", mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }], body: { data: b64("Café at 3pm\n\nOn Mon, X wrote:\n> old") } },
  { partId: "1", mimeType: "text/html", body: { data: b64("<p>ignored</p>") } }] };
ok("plain text preferred, UTF-8 kept", P.bodyText(payloadPlain) === "Café at 3pm");
const latin = { mimeType: "text/plain", headers: [{ name: "Content-Type", value: 'text/plain; charset="iso-8859-1"' }], body: { data: Buffer.from("£500 deposit", "latin1").toString("base64") } };
ok("Latin-1 decoded", P.bodyText(latin) === "£500 deposit");
const long = { mimeType: "text/plain", body: { data: b64("x".repeat(25000)) } };
ok("capped at 20,000 characters", P.bodyText(long).length < 20010);

console.log("attachments");
const part = (id, name, mime, size, headers) => ({ partId: id, filename: name, mimeType: mime, headers: headers || [], body: { attachmentId: "att" + id, size: size } });
const payloadAtt = { mimeType: "multipart/mixed", parts: [
  { partId: "0", mimeType: "text/plain", body: { data: b64("see attached") } },
  part("1", "contract.pdf", "application/pdf", 300000, [{ name: "Content-Disposition", value: "attachment; filename=contract.pdf" }]),
  part("2", "image001.png", "image/png", 6000, [{ name: "Content-Disposition", value: "inline" }, { name: "Content-ID", value: "<image001>" }]),
  part("3", "logo.jpg", "image/jpeg", 30000, [{ name: "Content-Disposition", value: "attachment" }]),
  part("4", "IMG_2041.HEIC", "image/heic", 2400000, [{ name: "Content-Disposition", value: "inline" }, { name: "Content-ID", value: "<x>" }]),
  part("5", "banner.png", "image/png", 120000, [{ name: "Content-ID", value: "<banner>" }]),
  part("6", "smime.p7s", "application/pkcs7-signature", 4000),
  part("7", "winmail.dat", "application/ms-tnef", 90000),
  { partId: "8", mimeType: "multipart/related", parts: [part("8.1", "floorplan.png", "image/png", 400000, [{ name: "Content-Disposition", value: "attachment" }])] },
  part("9", "guests.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 9000)] };
const atts = P.listAttachments(payloadAtt);
ok("documents kept, logos and signatures not", JSON.stringify(atts.map((a) => a.name)) === JSON.stringify(["contract.pdf", "IMG_2041.HEIC", "floorplan.png", "guests.xlsx"]), JSON.stringify(atts.map((a) => a.name)));
ok("each keeps its part number", atts[2].part === "8.1" && atts[0].size === 300000 && atts[0].mime === "application/pdf");
ok("found again by part number", P.findPartById(payloadAtt, "8.1").filename === "floorplan.png" && P.findPartById(payloadAtt, "99") === null);

console.log("rows");
const msg = (id, labels, from, to, extra) => Object.assign({ id: id, threadId: "t" + id, internalDate: String(Date.parse("2025-03-04T10:00:00Z")), labelIds: labels,
  payload: Object.assign({}, payloadAtt, { headers: [{ name: "From", value: from }, { name: "To", value: to }, { name: "Cc", value: "Mum <mum@x.com>" },
    { name: "Subject", value: "Re: Our day" }, { name: "Message-ID", value: "<m" + id + "@mail>" }] }) }, extra || {});
const inRow = P.buildRow(msg("a1", ["INBOX"], '"Amy Smith" <Amy@X.com>', "Hawthbush <hawthbushfarm@gmail.com>"));
ok("from the guest: in", inRow.direction === "in" && inRow.from_addr === "amy@x.com" && inRow.from_name === "Amy Smith");
ok("everyone but us", JSON.stringify(inRow.addrs) === JSON.stringify(["amy@x.com", "mum@x.com"]), JSON.stringify(inRow.addrs));
ok("subject, thread, message id, date, attachments", inRow.subject === "Re: Our day" && inRow.thread_id === "ta1" && inRow.rfc_id === "<ma1@mail>"
  && inRow.sent_at === "2025-03-04T10:00:00.000Z" && inRow.attachments.length === 4 && inRow.body === "see attached");
const outRow = P.buildRow(msg("a2", ["SENT"], "Hawthbush Farm <hello@hawthbushfarm.co.uk>", "amy@x.com"));
ok("sent by us: out", outRow.direction === "out" && JSON.stringify(outRow.addrs) === JSON.stringify(["amy@x.com", "mum@x.com"]));
ok("from our address without the SENT label: still out", P.buildRow(msg("a3", ["INBOX"], "toby@hawthbushfarm.co.uk", "amy@x.com")).direction === "out");
ok("a draft is never stored", P.buildRow(msg("a4", ["DRAFT"], "hawthbushfarm@gmail.com", "amy@x.com")) === null);
ok("metadata alone gives the addresses", JSON.stringify(P.messageAddrs({ payload: { headers: [{ name: "From", value: "z@q.com" }, { name: "Bcc", value: "hidden@q.com" }] } })) === JSON.stringify(["z@q.com", "hidden@q.com"]));

console.log("the app's own emails");
const log = [
  { id: "L1", sentAt: "2025-02-01T09:00:00.000Z", to: "Amy@x.com", subject: "Your brochure", template: "brochure_request", bodyHtml: "<p>Here it is</p>" },
  { id: "L2", sentAt: "2025-02-02T09:00:00.000Z", to: "guest@z.com", subject: "Booking confirmed", type: "booking_confirmed", body: "Booked!", bookingId: "A12" },
  { sentAt: "2025-02-03T09:00:00.000Z", to: "toby@hawthbushfarm.co.uk", subject: "Office copy" },
  { sentAt: "2025-02-04T09:00:00.000Z", subject: "no recipient" }];
const lr = P.logRows(log, null);
ok("each logged email with a recipient that is not us", lr.length === 2, JSON.stringify(lr.map((r) => r.gmail_id)));
ok("its id, kind, text and html", lr[0].gmail_id === "app:L1" && lr[0].direction === "app" && lr[0].kind === "brochure_request" && lr[0].body === "Here it is" && lr[0].body_html === "<p>Here it is</p>" && lr[0].addrs[0] === "amy@x.com");
ok("its booking id", lr[1].ref === "A12" && lr[1].kind === "booking_confirmed");
ok("only from the last one copied on", P.logRows(log, "2025-02-02T09:00:00.000Z").length === 1);
ok("an entry with no id gets a stable one", P.appLogId({ sentAt: "S", to: "T" }) === "app:S|T");

console.log("the Gmail search");
const q = P.addressQuery(["a@x.com", "b@y.com"], "2025/01/01");
ok("from/to/cc/bcc for each, from the start of 2025", q === "{from:a@x.com to:a@x.com cc:a@x.com bcc:a@x.com from:b@y.com to:b@y.com cc:b@y.com bcc:b@y.com} after:2025/01/01 -in:chats", q);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
