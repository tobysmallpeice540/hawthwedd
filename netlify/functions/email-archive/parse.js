// netlify/functions/email-archive/parse.js
//
// The pure half of the email archive: which addresses are ours and which are
// our clients', what an email says once the quoted history is cut off, which
// attachments are real documents, and the rows the database stores. No network
// here, so all of it is pinned by tests/email-archive-test.cjs.

"use strict";

// Our own addresses: never a client's, so never what an email is filed under.
const OUR_DOMAINS = ["hawthbushfarm.co.uk", "smallpeice.net"];
const OUR_ADDRESSES = ["hawthbushfarm@gmail.com"];
function isOurs(addr) {
  const a = String(addr || "").toLowerCase();
  if (OUR_ADDRESSES.indexOf(a) !== -1) return true;
  const d = a.split("@")[1] || "";
  return OUR_DOMAINS.some(function (x) { return d === x || d.endsWith("." + x); });
}
// Relay addresses (Airbnb and the like) stand for a booking platform, not a
// person, and the Airbnb emails have their own reader.
function isRelay(addr) {
  return /@(?:[a-z0-9-]+\.)*(?:airbnb\.[a-z.]+|booking\.com|expediapartnercentral\.com|homeaway\.com|vrbo\.com)$/i.test(String(addr || ""));
}

const ADDR_RE = /^[^\s@"'<>(),;:{}[\]\\]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i;
function cleanAddr(s) {
  const a = String(s || "").trim().replace(/^mailto:/i, "").toLowerCase();
  return ADDR_RE.test(a) ? a : null;
}
// Every address in a piece of free text ("Email a@b.com, c@d.com").
function addrsIn(text) {
  const out = [];
  String(text || "").replace(/[^\s<>(),;:"'[\]]+@[^\s<>(),;:"'[\]]+/g, function (m) {
    const a = cleanAddr(m.replace(/\.+$/, ""));
    if (a && out.indexOf(a) === -1) out.push(a);
    return m;
  });
  return out;
}

// "Smith, Amy" <amy@x.com>, bob@y.com  →  [{name, addr}]
function parseAddressList(header) {
  const s = String(header || "");
  const parts = [];
  let cur = "", q = false, ang = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && s[i - 1] !== "\\") q = !q;
    else if (!q && c === "<") ang++;
    else if (!q && c === ">") ang = Math.max(0, ang - 1);
    if ((c === "," || c === ";") && !q && !ang) { parts.push(cur); cur = ""; } else cur += c;
  }
  parts.push(cur);
  const out = [];
  parts.forEach(function (p) {
    const m = /^\s*(.*?)\s*<([^>]*)>\s*$/.exec(p);
    const addr = cleanAddr(m ? m[2] : p);
    if (!addr) return;
    const name = m ? m[1].replace(/^"|"$/g, "").replace(/\\"/g, '"').trim() : "";
    out.push({ name: name, addr: addr });
  });
  return out;
}

// ── Whose emails these are ──────────────────────────────────────────────────
// The addresses on our records, and the ones whose emails are kept for ever:
// anybody on an event or a letting, or an enquiry that booked. (An enquiry
// that never booked is kept two years — email_purge.) Booking ids go on the
// keep list too, because the app logs its own emails against them.
function recordAddresses(events, enquiries, accom) {
  const all = {}, keep = {};
  const add = function (a, kept) {
    if (!a || isOurs(a) || isRelay(a)) return;
    all[a] = true;
    if (kept) keep[a] = true;
  };
  (events || []).forEach(function (e) {
    if (!e) return;
    [e.email, e.email2, e.email3].forEach(function (x) { add(cleanAddr(x), true); });
    addrsIn(e.invoiceEmails).forEach(function (a) { add(a, true); });
  });
  (accom || []).forEach(function (b) {
    if (!b) return;
    add(cleanAddr(b.email), true);
    if (b.id != null && b.id !== "") keep[String(b.id)] = true;
  });
  (enquiries || []).forEach(function (q) {
    if (!q) return;
    add(cleanAddr(q.email), q.outcome === "booked");
  });
  return { all: all, keep: Object.keys(keep) };
}

// ── What an email says ──────────────────────────────────────────────────────
function headerMap(part) {
  const h = {};
  ((part && part.headers) || []).forEach(function (x) { h[String(x.name).toLowerCase()] = x.value; });
  return h;
}
function decodeData(data, charset) {
  const buf = Buffer.from(String(data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return /iso-8859-1|windows-1252|latin-?1/i.test(charset || "") ? buf.toString("latin1") : buf.toString("utf8");
}
function charsetOf(part) {
  const m = /charset="?([^";\s]+)/i.exec(headerMap(part)["content-type"] || "");
  return m ? m[1] : "";
}
// The first text part of a kind that is the message, not an attached file.
function findBodyPart(part, mime) {
  if (!part) return null;
  if (part.mimeType === mime && part.body && part.body.data && !part.filename) return part;
  for (const p of part.parts || []) { const f = findBodyPart(p, mime); if (f) return f; }
  return null;
}
function decodeEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/gi, "'").replace(/&ldquo;|&rdquo;/gi, '"').replace(/&ndash;/gi, "–").replace(/&mdash;/gi, "—")
    .replace(/&pound;/gi, "£").replace(/&euro;/gi, "€")
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCodePoint(Number(n)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCodePoint(parseInt(n, 16)); })
    .replace(/&amp;/gi, "&");
}
// HTML to readable text, with the quoted reply chain (Gmail's gmail_quote,
// Outlook's divRplyFwdMsg / appendonsend, Apple's blockquote) cut off first.
function htmlToText(html) {
  let h = String(html || "");
  const cut = h.search(/<div[^>]+class="[^"]*gmail_quote|<blockquote|<div[^>]+id="(?:appendonsend|divRplyFwdMsg)"|<hr[^>]+id="stopSpelling"/i);
  if (cut > 0) h = h.slice(0, cut);
  h = h.replace(/<(head|style|script|title)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d|table)>/gi, "\n").replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(h).replace(/[ \t ]+\n/g, "\n").replace(/[ \t]{2,}/g, " ");
}
// Cut the quoted history off a plain-text email. A forwarded message is the
// point of the email, so its header block is NOT cut.
function stripQuoted(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const fwdNear = function (i) {
    for (let k = Math.max(0, i - 3); k < i; k++) if (/forwarded message|begin forwarded message/i.test(lines[k])) return true;
    return false;
  };
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    const two = (l + " " + String(lines[i + 1] || "").trim()).trim();
    if (/^On\b.{4,300}\bwrote:$/i.test(l) || (/^On\b/i.test(l) && /\bwrote:$/i.test(two) && two.length < 400)) { cut = i; break; }
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(l)) { cut = i; break; }
    if (/^_{8,}$/.test(l) && /^From:/i.test(String(lines[i + 1] || "").trim())) { cut = i; break; }
    if (i > 0 && /^From:\s/i.test(l) && !fwdNear(i) && lines.slice(i + 1, i + 5).some(function (x) { return /^(Sent|Date):\s/i.test(x.trim()); })) { cut = i; break; }
    if (/^>/.test(l) && lines.slice(i).every(function (x) { return /^>/.test(x.trim()) || !x.trim(); })) { cut = i; break; }
  }
  const out = lines.slice(0, cut).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return out || lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
const BODY_CAP = 20000;
function bodyText(payload) {
  const plain = findBodyPart(payload, "text/plain");
  let text;
  if (plain) text = stripQuoted(decodeData(plain.body.data, charsetOf(plain)));
  else {
    const html = findBodyPart(payload, "text/html");
    text = html ? stripQuoted(htmlToText(decodeData(html.body.data, charsetOf(html)))) : "";
  }
  return text.length > BODY_CAP ? text.slice(0, BODY_CAP) + "\n…" : text;
}

// ── Which attachments are real ──────────────────────────────────────────────
// Not the logos in people's signatures: a picture under 50KB never counts, and
// one placed in the body (inline, or with a Content-ID) counts only above 200KB
// — a photo pasted into an email from a phone. Signatures, and Outlook's
// winmail.dat, are not documents either.
const SMALL_IMAGE = 50 * 1024, INLINE_IMAGE = 200 * 1024;
function listAttachments(payload) {
  const out = [];
  (function walk(p) {
    if (!p) return;
    if (p.filename && p.body && (p.body.attachmentId || p.body.data)) {
      const h = headerMap(p);
      const mime = String(p.mimeType || "").toLowerCase();
      const size = Number(p.body.size) || 0;
      const inline = /^\s*inline/i.test(h["content-disposition"] || "") || !!h["content-id"];
      const isImage = /^image\//.test(mime);
      const junk = /pkcs7-signature|ms-tnef/.test(mime) || /^(smime\.p7s|winmail\.dat)$/i.test(p.filename);
      if (!junk && !(isImage && (size < SMALL_IMAGE || (inline && size < INLINE_IMAGE)))) {
        out.push({ part: String(p.partId || ""), name: String(p.filename).slice(0, 200), mime: mime, size: size });
      }
    }
    (p.parts || []).forEach(walk);
  })(payload);
  return out;
}
function findPartById(payload, partId) {
  let hit = null;
  (function walk(p) {
    if (!p || hit) return;
    if (String(p.partId || "") === String(partId)) { hit = p; return; }
    (p.parts || []).forEach(walk);
  })(payload);
  return hit;
}

// ── The rows ────────────────────────────────────────────────────────────────
// The people on a message (from/to/cc/bcc), less us, from a full or metadata
// fetch alike.
function messageAddrs(msg) {
  const h = headerMap(msg && msg.payload);
  const out = [];
  ["from", "to", "cc", "bcc"].forEach(function (k) {
    parseAddressList(h[k]).forEach(function (x) { if (!isOurs(x.addr) && out.indexOf(x.addr) === -1) out.push(x.addr); });
  });
  return out;
}
function isDraft(msg) { return ((msg && msg.labelIds) || []).indexOf("DRAFT") !== -1; }

function buildRow(msg) {
  if (!msg || !msg.id || isDraft(msg)) return null;
  const h = headerMap(msg.payload);
  const from = parseAddressList(h["from"])[0] || { name: "", addr: "" };
  const labels = msg.labelIds || [];
  return {
    gmail_id: msg.id,
    thread_id: msg.threadId || null,
    rfc_id: h["message-id"] || null,
    sent_at: new Date(Number(msg.internalDate) || Date.now()).toISOString(),
    direction: labels.indexOf("SENT") !== -1 || isOurs(from.addr) ? "out" : "in",
    from_addr: from.addr || null,
    from_name: from.name || null,
    to_addrs: parseAddressList(h["to"]).map(function (x) { return x.addr; }),
    cc_addrs: parseAddressList(h["cc"]).map(function (x) { return x.addr; }),
    addrs: messageAddrs(msg),
    subject: String(h["subject"] || "").slice(0, 500),
    body: bodyText(msg.payload),
    attachments: listAttachments(msg.payload)
  };
}

// The app's own emails (hbf_email_log_v1, which keeps only the last 500),
// newest first after `upto` (a sentAt string; null = all of them).
function appLogId(e) { return "app:" + (e.id || ((e.sentAt || "") + "|" + (e.to || ""))); }
function logRows(log, upto) {
  return (Array.isArray(log) ? log : []).filter(function (e) {
    return e && e.sentAt && e.to && (!upto || String(e.sentAt) >= String(upto));
  }).map(function (e) {
    const to = addrsIn(e.to);
    const text = e.body ? String(e.body) : (e.bodyHtml ? htmlToText(e.bodyHtml).replace(/\n{3,}/g, "\n\n").trim() : "");
    return {
      gmail_id: appLogId(e),
      sent_at: new Date(e.sentAt).toISOString(),
      direction: "app",
      from_addr: "hello@hawthbushfarm.co.uk",
      from_name: "Hawthbush Farm (sent by the app)",
      to_addrs: to,
      addrs: to.filter(function (a) { return !isOurs(a); }),
      subject: String(e.subject || "").slice(0, 500),
      body: text.slice(0, BODY_CAP),
      body_html: e.bodyHtml ? String(e.bodyHtml) : null,
      kind: e.template || e.type || null,
      ref: e.bookingId != null && e.bookingId !== "" ? String(e.bookingId) : null
    };
  }).filter(function (r) { return r.addrs.length || r.ref; });
}

// A Gmail search for everything to or from a few addresses.
function addressQuery(addrs, after) {
  return "{" + addrs.map(function (a) { return "from:" + a + " to:" + a + " cc:" + a + " bcc:" + a; }).join(" ") + "} after:" + after + " -in:chats";
}

module.exports = {
  isOurs, isRelay, cleanAddr, addrsIn, parseAddressList, recordAddresses, htmlToText, stripQuoted, bodyText,
  listAttachments, findPartById, messageAddrs, isDraft, buildRow, logRows, appLogId, addressQuery, decodeData
};
