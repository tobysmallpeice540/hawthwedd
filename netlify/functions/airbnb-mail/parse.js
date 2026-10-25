// netlify/functions/airbnb-mail/parse.js
//
// Reads Airbnb's emails to the host. Pure functions: no network, no database.
// The worker (airbnb-mail.js) fetches the messages and stores what this finds.
//
// Everything here is read from the TEXT part of the email, which Airbnb lays
// out the same way every time. Each email type is recognised by its
// X-Template header first and its subject second.
//
// Two rules matter more than the rest:
//
//   1. Only the HOST side is read. Toby books Airbnb stays himself, and those
//      emails reach the same inbox. A host email always links into
//      airbnb.<tld>/hosting/…; a traveller's never does. Anything without that
//      link is ignored, however it is worded. Where an email names a listing
//      by its room number, it must be one of ours as well (ourRooms).
//   2. Money is read only from the labelled lines of Airbnb's own templates
//      ("YOU EARN", a payout's per-reservation line). Never from a message a
//      guest wrote.
//
// Nothing here throws on an email it does not understand: it says "ignore",
// with a reason, and the worker moves on.

"use strict";

const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12 };
const CODE_RE = /\b(HM[A-Z0-9]{8})\b/;
const HOST_LINK_RE = /airbnb\.[a-z.]{2,12}\/hosting\//i;

// Characters Airbnb sprinkles through its text for spacing and tracking.
function cleanText(t) {
  return String(t || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[   ]/g, " ")
    .replace(/[­͏​-‏⁠-⁤⁦-⁩﻿]/g, "")
    .replace(/[ \t]+\n/g, "\n");
}

function pad2(n) { return (n < 10 ? "0" : "") + n; }
function isoDate(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (!(y > 1999 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;   // 31 Feb and the like
  return y + "-" + pad2(m) + "-" + pad2(d);
}
function monthNo(s) { return MONTHS[String(s || "").slice(0, 4).toLowerCase()] || MONTHS[String(s || "").slice(0, 3).toLowerCase()] || null; }

// Every "16 Apr 2027" / "16 April 2027" in a piece of text, in order.
function fullDates(text) {
  const out = [];
  const re = /\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*\.? (\d{4})\b/g;
  let m;
  while ((m = re.exec(text))) {
    const d = isoDate(m[3], monthNo(m[2]), m[1]);
    if (d) out.push(d);
  }
  return out;
}

// "16–18 Oct 2026", "30 Oct – 2 Nov 2026", "28 Dec 2026 – 2 Jan 2027",
// "16–18 Oct" (with the year from `fallbackYear`). Returns { in, out } or null.
function dateRange(text, fallbackYear) {
  const re = /\b(\d{1,2})(?: (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*)?(?: (\d{4}))? ?[–—-] ?(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*(?: (\d{4}))?/;
  const m = String(text || "").match(re);
  if (!m) return null;
  const m2 = monthNo(m[5]);
  const y2 = m[6] ? Number(m[6]) : (fallbackYear ? Number(fallbackYear) : null);
  if (!y2) return null;
  const m1 = m[2] ? monthNo(m[2]) : m2;
  let y1 = m[3] ? Number(m[3]) : y2;
  if (!m[3] && (m1 > m2 || (m1 === m2 && Number(m[1]) > Number(m[4])))) y1 = y2 - 1;
  const a = isoDate(y1, m1, m[1]), b = isoDate(y2, m2, m[4]);
  return a && b && a < b ? { in: a, out: b } : null;
}

// "£2,193.72" → 2193.72. Only ever called on a labelled template line.
function pounds(s) {
  const m = String(s || "").match(/^(-?)£([\d,]+(?:\.\d{1,2})?)$/);
  if (!m) return null;
  const n = Number(m[2].replace(/,/g, ""));
  return Number.isFinite(n) ? (m[1] ? -n : n) : null;
}

// "9 adults, 3 children, 1 infant, 2 pets" → 12 (adults and children; infants
// and pets do not take a bed). A bare "14" is 14.
function guestCount(s) {
  s = String(s || "").trim();
  if (/^\d{1,3}$/.test(s)) return Number(s);
  let n = 0, any = false;
  const re = /(\d{1,3}) (adults?|children|child)\b/gi;
  let m;
  while ((m = re.exec(s))) { n += Number(m[1]); any = true; }
  return any ? n : null;
}

// The line after a heading such as "GUESTS".
function lineAfter(text, heading) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === heading) {
      for (let j = i + 1; j < lines.length && j < i + 6; j++) {
        if (lines[j].trim()) return lines[j].trim();
      }
    }
  }
  return null;
}

function threadIdOf(text) {
  const m = text.match(/airbnb\.[a-z.]{2,12}\/(?:hosting\/thread|hosting\/inbox|messaging\/thread|messaging\/qt_for_reservation)\/(\d{6,14})/i);
  return m ? m[1] : null;
}
function roomIdsOf(text) {
  const out = [];
  const re = /airbnb\.[a-z.]{2,12}\/rooms\/(\d{4,14})/gi;
  let m;
  while ((m = re.exec(text))) if (out.indexOf(m[1]) === -1) out.push(m[1]);
  return out;
}
function codeOf(text) {
  const m = String(text || "").match(/reservations\/details\/(HM[A-Z0-9]{8})/) || String(text || "").match(/CONFIRMATION CODE\s*\n\s*(HM[A-Z0-9]{8})/);
  return m ? m[1] : null;
}

// The listing title as the email prints it, in capitals, under the room link.
function listingOf(text) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/airbnb\.[a-z.]{2,12}\/rooms\/\d/.test(lines[i])) {
      for (let j = i + 1; j < lines.length && j < i + 5; j++) {
        const l = lines[j].replace(/[›]/g, "").trim();
        if (!l || /https?:\/\//.test(l)) continue;
        return l;
      }
    }
  }
  return null;
}

// Listing names compare without case or punctuation: the subject has "The
// Hamlet - with Hot Tub, Cinema Room & Taproom", the body has it in capitals.
function normListing(s) {
  return String(s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}

function titleCase(s) {
  return String(s || "").toLowerCase().replace(/(^|[\s'’-])([a-z])/g, function(_, a, b) { return a + b.toUpperCase(); });
}

// Only the template's own line under the HOST PAYOUT heading — never a "YOU
// EARN" that a guest typed into a message quoted in the same email. The last
// one after the heading, at the start of its line.
function youEarn(text) {
  const at = text.search(/^\s*HOST PAYOUT\s*$/m);
  if (at < 0) return null;
  const re = /^[ \t]*YOU EARN[ \t]+(-?£[\d,]+\.\d{2})[ \t]*$/gm;
  re.lastIndex = at;
  let m, last = null;
  while ((m = re.exec(text))) last = m[1];
  return last ? pounds(last) : null;
}

function guestsOf(text) {
  const g = lineAfter(text, "GUESTS");
  return g && /\d/.test(g) && g.length < 80 ? g : null;
}

// ── Message bodies ──────────────────────────────────────────────────────────

// Strip a link line Airbnb puts in brackets, and the leftover indentation.
function tidyBody(lines) {
  const out = lines.map(function(l) { return l.replace(/\s+$/, "").replace(/^ {1,4}/, ""); });
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  // Airbnb wraps at about 60 columns; put the sentences back together, keeping
  // real paragraph breaks.
  const paras = [];
  let cur = [];
  out.forEach(function(l) {
    if (!l.trim()) { if (cur.length) { paras.push(cur.join(" ")); cur = []; } }
    else cur.push(l.trim());
  });
  if (cur.length) paras.push(cur.join(" "));
  return paras.join("\n\n").trim();
}

const HOST_ROLES = /^(host|co-?host|cohost)$/i;

// A digest holds one or more messages, each laid out as
//
//      NAME
//
//      Role
//
//      text, wrapped and indented
//
// between the "always communicate through Airbnb" line and the "Reply" link.
function digestMessages(text) {
  let start = text.search(/always communicate through Airbnb/i);
  if (start < 0) return [];
  start = text.indexOf("\n", start);
  // The protection line is followed by a bracketed help link on the next line.
  const rest = text.slice(start + 1);
  const endM = rest.match(/\n(Reply|Review enquiry|Respond)\s*\n/);
  const body = endM ? rest.slice(0, endM.index) : rest;
  const lines = body.split("\n").filter(function(l) { return !/^\s*\[?https?:\/\/\S+\]?\.?\s*$/.test(l); });

  const msgs = [];
  let i = 0;
  const isBlank = function(k) { return k >= lines.length || !lines[k].trim(); };
  const nextNonBlank = function(k) { while (k < lines.length && !lines[k].trim()) k++; return k; };
  while (i < lines.length) {
    i = nextNonBlank(i);
    if (i >= lines.length) break;
    const nameLine = lines[i].trim();
    const r = nextNonBlank(i + 1);
    const roleLine = r < lines.length ? lines[r].trim() : "";
    // A message header is a name in capitals followed by a short role line.
    const looksHeader = nameLine && nameLine === nameLine.toUpperCase() && /[A-Z]/.test(nameLine)
      && nameLine.length <= 60 && roleLine && roleLine.length <= 30 && !/[.!?,]$/.test(roleLine);
    if (!looksHeader) { i++; continue; }
    let k = nextNonBlank(r + 1);
    const bodyLines = [];
    // The body runs until the next header (capitals line + short role line).
    while (k < lines.length) {
      const l = lines[k].trim();
      if (l && l === l.toUpperCase() && /[A-Z]/.test(l) && l.length <= 60) {
        const rr = nextNonBlank(k + 1);
        const role2 = rr < lines.length ? lines[rr].trim() : "";
        const afterRole = nextNonBlank(rr + 1);
        if (role2 && role2.length <= 30 && !/[.!?,]$/.test(role2) && role2 !== role2.toUpperCase()
            && isBlank(k - 1) && afterRole <= lines.length) break;
      }
      bodyLines.push(lines[k]);
      k++;
    }
    const bodyText = tidyBody(bodyLines);
    if (bodyText) {
      msgs.push({
        author: titleCase(nameLine),
        role: roleLine,
        direction: HOST_ROLES.test(roleLine) ? "host" : "guest",
        body: bodyText
      });
    }
    i = k;
  }
  return msgs;
}

// A first message sent with an enquiry or a request to book:
//   name, [link], "Identity verified · 6 reviews", place, [link], the message,
// and then "Pre-approve / Decline" or the listing's room link.
function firstMessage(text, guestFirst) {
  const lines = text.split("\n");
  let i = -1;
  // Start after the guest's own name line (the first line that is exactly it).
  for (let k = 0; k < lines.length; k++) {
    if (guestFirst && lines[k].trim() === guestFirst) { i = k; break; }
  }
  if (i < 0) return null;
  let k = i + 1;
  const skippable = function(l) {
    const t = l.trim();
    return !t || /^\[?<?https?:\/\/\S+\]?>?\.?$/.test(t) || /(Identity verified|reviews?|Guest is verified|verified)$/i.test(t)
      || /^On Airbnb since \d{4}$/i.test(t);
  };
  while (k < lines.length && skippable(lines[k])) k++;
  // A place name ("England, United Kingdom", "London") on its own line.
  const placeRe = /^([A-Z][\w'’.-]*)((,? [A-Z][\w'’.-]*)|(, [A-Z][\w'’.-]*))*$/;
  if (k < lines.length && lines[k].trim().length <= 40 && placeRe.test(lines[k].trim())) {
    k++;
    while (k < lines.length && skippable(lines[k])) k++;
  }
  const body = [];
  for (; k < lines.length; k++) {
    const t = lines[k].trim();
    if (/^(Pre-approve \/ Decline|Accept\/Decline|Accept \/ Decline)/i.test(t)) break;
    if (/airbnb\.[a-z.]{2,12}\/rooms\/\d/.test(t)) break;
    if (/^(YOU HAVE 24 HOURS|POTENTIAL EARNINGS|MORE DETAILS ABOUT|Check-in\b)/.test(t)) break;
    if (/^\[?<?https?:\/\/\S+\]?>?\.?$/.test(t)) continue;
    body.push(lines[k]);
  }
  const b = tidyBody(body);
  return b || null;
}

// Toby's own reply sent from Gmail: the text above the quoted email.
function replyBody(text) {
  const t = cleanText(text);
  const cut = t.search(/\n[^\n]{0,20}On [^\n]{4,140}wrote:\s*\n|\nSent from Gmail Mobile|\n-{2,} ?Original Message|\n>/);
  const top = cut >= 0 ? t.slice(0, cut) : t;
  return tidyBody(top.split("\n").map(function(l) { return l; })) || null;
}

function threadKind(subject) {
  const s = String(subject || "").replace(/^(RE|Re|Fwd?):\s*/, "");
  if (/^Enquiry for/i.test(s) || /^Pre-approval for/i.test(s) || /booking enquiry/i.test(s) || /enquiry/i.test(s)) return "enquiry";
  if (/^(Booking request|Request|Reservation request)/i.test(s) || /^Pending:/i.test(s)) return "request";
  return "reservation";
}

// ── The classifier ──────────────────────────────────────────────────────────
//
// msg: { id, date (ISO), from, to, subject, template, labels[], text }
// opts: { ourRooms: ["15331259", …] }   (empty = do not check rooms)
function parseAirbnbEmail(msg, opts) {
  opts = opts || {};
  const ourRooms = (opts.ourRooms || []).map(String);
  const text = cleanText(msg.text);
  const subject = String(msg.subject || "").replace(/\s+/g, " ").trim();
  const template = String(msg.template || "");
  const from = String(msg.from || "").toLowerCase();
  const to = String(msg.to || "").toLowerCase();
  const labels = msg.labels || [];
  const at = msg.date || null;
  const year = at ? Number(String(at).slice(0, 4)) : null;
  const ignore = function(reason) { return { kind: "ignore", reason: reason }; };

  // Toby's own reply, sent from Gmail to Airbnb's reply address.
  if (labels.indexOf("SENT") !== -1) {
    if (!/@reply\.airbnb\.com/.test(to)) return ignore("sent, not to an Airbnb reply address");
    // The quoted email below the reply must be a host-side one.
    if (!HOST_LINK_RE.test(text) || /inbox_type=guest/.test(text)) return ignore("reply on a trip of our own");
    const thread = threadIdOf(text.slice(Math.max(0, text.search(HOST_LINK_RE) - 60)));
    const body = replyBody(text);
    if (!thread || !body) return ignore("reply with no thread or no text");
    return { kind: "sent", threadId: thread, threadKind: threadKind(subject),
      messages: [{ author: "Toby", role: "Host", direction: "host", body: body }], at: at };
  }

  if (!/@([a-z0-9-]+\.)*airbnb\.com>?$/.test(from.replace(/^.*</, "").replace(/>.*$/, "")) && !/airbnb\.com/.test(from)) {
    return ignore("not from Airbnb");
  }
  if (/_TO_GUEST$/.test(template)) return ignore("traveller email (" + template + ")");
  if (/confirmation code is \d|account activity|co-?host|superhost|off-platform|payment of .* failed|your receipt|welcome to /i.test(subject)) {
    return ignore("not about a guest stay");
  }

  // Payout: "We sent a payout of £2,385.83 GBP". Per reservation:
  //   Reece Thomson £2,385.83 GBP
  //   Home • 16/10/2026 - 18/10/2026
  //   The Hamlet - with Hot Tub, Cinema Room & Taproom (15331259)
  //   HMS5K2QTZ2
  if (/^We sent a payout of/i.test(subject)) {
    const items = [];
    const re = /^[ \t]*(.+?) (-?£[\d,]+\.\d{2}) GBP[ \t]*\n\s*(?:Home|Stay|Experience)[^\n]*?(\d{2})\/(\d{2})\/(\d{4}) - (\d{2})\/(\d{2})\/(\d{4})[ \t]*\n\s*(.+?) \((\d{4,14})\)[ \t]*\n\s*(HM[A-Z0-9]{8})\b/gm;
    let m;
    while ((m = re.exec(text))) {
      if (ourRooms.length && ourRooms.indexOf(m[10]) === -1) continue;
      items.push({
        guestName: m[1].trim(), amount: pounds(m[2]),
        checkIn: isoDate(m[5], m[4], m[3]), checkOut: isoDate(m[8], m[7], m[6]),
        listing: m[9].trim(), roomId: m[10], code: m[11]
      });
    }
    if (!items.length) return ignore("payout with no reservation lines");
    // Airbnb's own payout reference: the same payout read twice (two mailboxes,
    // a forwarded copy) is stored once.
    const pid = (text.match(/Payout ID\s*\n\s*([A-Z0-9][A-Z0-9-]{5,40})\s*\n/) || [])[1] || null;
    return { kind: "payout", payoutId: pid, items: items, at: at };
  }

  // Everything below is about one of our stays, so it must be the host side.
  // (A review of one of our stays links to the host's "progress" pages
  // instead, and its template says HOST.)
  //  A cancellation to the host carries no hosting link: it is believed only
  // when its template says _TO_HOST, or it names one of our listings by number.
  const listingNo = (text.match(/Listing #(\d{4,14})/) || [])[1] || null;
  const cancelSubject = /^Cancell?ed: Reservation HM|^Reservation HM[A-Z0-9]{8} .*Cancell?ed/i.test(subject);
  const hostSide = HOST_LINK_RE.test(text)
    // (a forwarded copy may have lost the template header; the review then
    // still has to match one of our stays by listing and dates to count)
    || (/airbnb\.[a-z.]{2,12}\/progress\/reviews\//i.test(text) && (!template || /HOST/.test(template)))
    || (cancelSubject && (/_TO_HOST$/.test(template) || (listingNo && ourRooms.indexOf(listingNo) !== -1)));
  if (!hostSide) {
    return ignore("no link into hosting — a trip of our own, or not about a stay");
  }
  const rooms = roomIdsOf(text);
  if (listingNo && rooms.indexOf(listingNo) === -1) rooms.push(listingNo);
  if (ourRooms.length && rooms.length && !rooms.some(function(r) { return ourRooms.indexOf(r) !== -1; })) {
    return ignore("about a listing that is not ours");
  }

  // Cancellation: "Cancelled: Reservation HM9FA8RHTR for 10–12 Apr 2026",
  // older "Reservation HMKZ5QNE8W on 22 December 2023 Cancelled".
  const cs = subject.match(/^Cancell?ed: Reservation (HM[A-Z0-9]{8})\b/i) || subject.match(/^Reservation (HM[A-Z0-9]{8}) .*Cancell?ed/i);
  if (cs || /^CANCELLATIONS_.*_TO_HOST$/.test(template)) {
    const code = cs ? cs[1] : (text.match(CODE_RE) || [])[1];
    if (!code) return ignore("cancellation with no code");
    const who = text.match(/your guest (.+?) had to cancel/i);
    const range = dateRange(subject, year) || dateRange(text, year);
    return { kind: "cancellation", code: code, guestFirst: who ? who[1].trim() : null,
      checkIn: range ? range.in : null, checkOut: range ? range.out : null, at: at };
  }

  // Booking confirmed.
  if (template === "BOOKING_CONFIRMATION_TO_HOST" || /^Reservation confirmed - /i.test(subject)) {
    const code = codeOf(text);
    if (!code) return ignore("confirmation with no code");
    const sm = subject.match(/^Reservation confirmed - (.+?) arrives /i);
    const dates = fullDates(text.slice(Math.max(0, text.search(/Check-in/))));
    return {
      kind: "confirmation", code: code, threadId: threadIdOf(text), roomId: rooms[0] || null,
      listing: listingOf(text), guestName: sm ? sm[1].trim() : nameAfterDetailsLink(text),
      checkIn: dates[0] || null, checkOut: dates[1] || null,
      guests: guestsOf(text), guestCount: guestCount(guestsOf(text)),
      payout: youEarn(text), at: at
    };
  }

  // Reminder before arrival: carries the full name and the payout as it now is
  // (after any change to the booking).
  if (template === "BOOKING_RESERVATION_REMINDER_TO_HOST" || /^Reservation reminder: .+ is coming soon/i.test(subject)) {
    const code = codeOf(text);
    if (!code) return ignore("reminder with no code");
    return {
      kind: "reminder", code: code, threadId: threadIdOf(text), roomId: rooms[0] || null,
      listing: listingOf(text), guestName: nameAfterDetailsLink(text),
      guests: guestsOf(text), guestCount: guestCount(guestsOf(text)),
      payout: youEarn(text), at: at
    };
  }

  // A change to the booking was accepted. No money in it.
  if (/^ALTERATION_ACCEPTED/.test(template) || /^Your reservation change has been accepted/i.test(subject)) {
    const code = codeOf(text);
    if (!code) return ignore("change with no code");
    return { kind: "alteration", code: code, at: at };
  }

  // Review: "Reece has left a 5-star review!". The stay is named by listing
  // and dates, not by code.
  const rv = subject.match(/^(.+?) (?:has )?left (?:a|an) (\d)-star review/i);
  if (rv) {
    const stars = Number(rv[2]);
    if (!(stars >= 1 && stars <= 5)) return ignore("review with no rating");
    const sec = text.slice(Math.max(0, text.search(/FEEDBACK FROM THEIR STAY|OVERALL RATING/)));
    const lines = sec.split("\n").map(function(l) { return l.trim(); }).filter(Boolean);
    let listing = null, range = null;
    for (let i = 0; i < lines.length && i < 6; i++) {
      const r = dateRange(lines[i], year);
      if (r) { range = r; listing = i > 0 ? lines[i - 1] : null; break; }
    }
    if (!range) return ignore("review with no dates");
    return { kind: "review", guestFirst: rv[1].trim(), stars: stars, listing: listing,
      checkIn: range.in, checkOut: range.out, at: at };
  }

  // Message digest: "RE: Reservation for <listing>, 24–27 Oct".
  if (template === "MESSAGING_NEW_MESSAGE_EMAIL_DIGEST" || /^RE: /i.test(subject)) {
    const thread = threadIdOf(text);
    if (!thread) return ignore("messages with no thread");
    if (/inbox_type=guest/.test(text) && !/inbox_type=host/.test(text)) return ignore("messages on a trip of our own");
    const msgs = digestMessages(text);
    if (!msgs.length) return ignore("messages email with no messages in it");
    return { kind: "digest", threadId: thread, threadKind: threadKind(subject), messages: msgs, at: at };
  }

  // A new enquiry, with the guest's first message.
  if (/^(BOOKING_INITIAL_INQUIRY|RESERVATION_INQUIRIES_REMINDER)/.test(template) || /^Enquiry for /i.test(subject)
      || /booking enquiry/i.test(subject)) {
    const thread = threadIdOf(text);
    if (!thread) return ignore("enquiry with no thread");
    const nm = text.match(/RESPOND TO ([^\n]+?)[’']S (?:ENQUIRY|REQUEST)/i);
    const first = nm ? titleCase(nm[1].trim()) : null;
    const body = firstMessage(text, first);
    if (!body) return ignore("enquiry with no message");
    return { kind: "enquiry", threadId: thread, threadKind: "enquiry",
      messages: [{ author: first || "Guest", role: "Guest", direction: "guest", body: body }], at: at };
  }

  // A request to book: "Pending: Reservation Request at …". The message goes
  // with the code (the email has no thread link).
  if (template === "BOOKING_RTB_TO_HOST" || /^Pending: Reservation Request/i.test(subject)) {
    const code = codeOf(text);
    if (!code) return ignore("request with no code");
    const nm = text.match(/RESPOND TO ([^\n]+?)[’']S (?:ENQUIRY|REQUEST)/i);
    const first = nm ? titleCase(nm[1].trim()) : null;
    const body = firstMessage(text, first);
    return { kind: "request", code: code, threadKind: "request",
      messages: body ? [{ author: first || "Guest", role: "Guest", direction: "guest", body: body }] : [], at: at };
  }

  return ignore("not a kind we read (" + (template || subject.slice(0, 40)) + ")");
}

// The guest's full name, printed beside the reservation link.
function nameAfterDetailsLink(text) {
  const m = text.match(/reservations\/details\/HM[A-Z0-9]{8}[^\s\]>]*\]?>?[ \t]+([^\n\[<]{2,80})/);
  if (!m) return null;
  const n = m[1].trim();
  return /^(Identity verified|Send |Accept|https?:)/i.test(n) ? null : n;
}

// ── Matching to our bookings ────────────────────────────────────────────────

// A name the import left behind: "Imported Customer", "Henry Airbnb",
// "Julia Air Bnb", "Airbnb block", or nothing at all.
function isPlaceholderName(n) {
  const s = String(n || "").trim();
  if (!s) return true;
  if (/^imported customer$/i.test(s)) return true;
  if (/\bair ?bnb\b/i.test(s)) return true;
  if (/^(reserved|not available|blocked)$/i.test(s)) return true;
  return false;
}

// The Airbnb room number of each property, read off its iCal import link
// (https://www.airbnb.co.uk/calendar/ical/15331259.ics?s=…).
function roomOfProperty(p) {
  const m = String((p && p.airbnbImportUrl) || "").match(/\/calendar\/ical\/(\d{4,14})\.ics/);
  return m ? m[1] : null;
}

function stayOf(b) {
  const s = (b && b.stays && b.stays[0]) || {};
  return { propertyId: s.propertyId || b.propertyId || null, checkIn: s.checkIn || b.checkIn || null, checkOut: s.checkOut || b.checkOut || null };
}

function codeInBooking(b) {
  if (b && b.airbnb && b.airbnb.code) return b.airbnb.code;
  const m = String((b && b.notes) || "").match(/reservations\/details\/(HM[A-Z0-9]{8})/);
  return m ? m[1] : null;
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }

// Work out what changes on each booking. Pure: (bookings, facts) → patches.
//
//   reservations: [{ code, thread_id, room_id, listing, guest_name, check_in,
//                    check_out, guests, guest_count, payout_expected,
//                    cancelled_at, altered_at }]
//   payouts:      [{ code, amount, sent_on }]          (one row per email line)
//   reviews:      [{ listing, check_in, check_out, stars, at }]
//   properties:   the lettings properties (for room numbers and names)
//
// A field is written only when it is a placeholder, or still holds what an
// earlier sync put there: once somebody types over a name or a figure, the
// sync leaves it alone and the Airbnb panel shows both.
function planBookingPatches(bookings, facts, now) {
  const reservations = facts.reservations || [];
  const payouts = facts.payouts || [];
  const reviews = facts.reviews || [];
  const properties = facts.properties || [];
  const byCode = {};
  reservations.forEach(function(r) { if (r && r.code) byCode[r.code] = r; });
  const paidByCode = {};
  payouts.forEach(function(p) {
    if (!p || !p.code || !Number.isFinite(Number(p.amount))) return;
    paidByCode[p.code] = round2((paidByCode[p.code] || 0) + Number(p.amount));
  });
  const propRoom = {};
  properties.forEach(function(p) { const r = roomOfProperty(p); if (r) propRoom[p.id] = r; });
  const propName = {};
  properties.forEach(function(p) { propName[p.id] = normListing(p.name); });

  // Bookings that already carry a code claim it; a reservation left over may
  // be matched by property and dates, but only to a booking with no code.
  const claimed = {};
  (bookings || []).forEach(function(b) { const c = codeInBooking(b); if (c) claimed[c] = true; });

  const patches = [];
  (bookings || []).forEach(function(b) {
    if (!b || b.source !== "airbnb" || b.bookingType === "Blocked") return;
    const st = stayOf(b);
    let code = codeInBooking(b);
    let res = code ? byCode[code] : null;
    if (!code) {
      const cands = reservations.filter(function(r) {
        // Only a confirmed reservation on this very listing: a row that exists
        // only because of a cancellation email has no listing to check.
        return !claimed[r.code] && r.confirmed_at && r.room_id && propRoom[st.propertyId] === r.room_id
          && r.check_in === st.checkIn && r.check_out === st.checkOut;
      });
      if (cands.length === 1) { res = cands[0]; code = res.code; claimed[code] = true; }
    }
    // The review is found by listing and dates, from the reservation if there
    // is one and from the booking's own stay otherwise.
    const ci = (res && res.check_in) || st.checkIn, co = (res && res.check_out) || st.checkOut;
    const review = reviews.filter(function(rv) {
      if (rv.check_in !== ci || rv.check_out !== co) return false;
      const ln = normListing(rv.listing);
      if (res && res.listing) return ln === normListing(res.listing);
      const pn = propName[st.propertyId];
      return !!pn && ln.indexOf(pn) === 0;
    }).sort(function(a, b) { return String(b.at || "").localeCompare(String(a.at || "")); })[0] || null;

    if (!res && !review) return;

    const old = b.airbnb || {};
    const next = Object.assign({}, old);
    const top = {};
    if (code) next.code = code;
    if (res) {
      if (res.thread_id) next.threadId = String(res.thread_id);
      if (res.guest_name) next.guestName = res.guest_name;
      if (res.guests) next.guests = res.guests;
      if (res.payout_expected != null) next.payoutExpected = round2(res.payout_expected);
      if (paidByCode[code] != null) next.payoutPaid = paidByCode[code];
      next.cancelledAt = res.cancelled_at || null;
      next.alteredAt = res.altered_at || null;
    }
    if (review) next.stars = review.stars;

    // The figure is what Airbnb pays us: the payout once it has been sent,
    // and what the booking says we will earn until then.
    const payout = next.payoutPaid != null && next.payoutPaid > 0 ? next.payoutPaid
      : (next.payoutExpected != null ? next.payoutExpected : null);
    const single = !b.stays || b.stays.length <= 1;
    if (payout != null && single) {
      const cur = round2(Number(b.value) || 0);
      const mine = old.appliedValue != null && round2(old.appliedValue) === cur;
      // The first time, only an estimate (or no figure at all) is replaced; a
      // price somebody typed is left, and the panel shows Airbnb's beside it.
      const firstOk = old.appliedValue == null && (b.estimated || cur === 0);
      if (firstOk || mine) {
        if (cur !== round2(payout) || b.estimated) {
          top.value = round2(payout);
          top.estimated = false;
          if (b.stays && b.stays.length === 1) top.stays = [Object.assign({}, b.stays[0], { value: round2(payout) })];
        }
        if (firstOk && cur > 0) next.valueBefore = cur;
        next.appliedValue = round2(payout);
      }
    }
    if (res && res.guest_name) {
      const mineName = old.appliedName != null && old.appliedName === b.guestName;
      if (isPlaceholderName(b.guestName) || mineName) {
        if (b.guestName !== res.guest_name) top.guestName = res.guest_name;
        next.appliedName = res.guest_name;
      }
    }
    if (res && res.guest_count > 0 && single) {
      const curN = Number(b.guestCount) || 0;
      const mineN = old.appliedCount != null && Number(old.appliedCount) === curN;
      if (curN <= 1 || mineN) {
        if (curN !== res.guest_count) {
          top.guestCount = res.guest_count;
          const baseStays = top.stays || b.stays;
          if (baseStays && baseStays.length === 1) top.stays = [Object.assign({}, baseStays[0], { guestCount: res.guest_count })];
        }
        next.appliedCount = res.guest_count;
      }
    }

    const changedTop = Object.keys(top).length > 0;
    const changedAirbnb = JSON.stringify(sortKeys(old)) !== JSON.stringify(sortKeys(next));
    if (!changedTop && !changedAirbnb) return;
    next.syncedAt = now;
    patches.push({ id: b.id, set: Object.assign({}, top, { airbnb: next }), code: code || null });
  });
  return patches;
}

function sortKeys(o) {
  const out = {};
  Object.keys(o || {}).filter(function(k) { return k !== "syncedAt"; }).sort().forEach(function(k) { out[k] = o[k]; });
  return out;
}

// Apply patches to a freshly read bookings array, by id. A booking deleted
// meanwhile stays deleted.
function applyPatches(list, patches) {
  const byId = {};
  patches.forEach(function(p) { byId[String(p.id)] = p; });
  let applied = 0;
  const out = (list || []).map(function(b) {
    const p = b && byId[String(b.id)];
    if (!p) return b;
    applied++;
    const set = Object.assign({}, p.set);
    // Keep anything staff set inside the airbnb object meanwhile (e.g. a
    // dismissed cancellation prompt).
    if (set.airbnb && b.airbnb) set.airbnb = Object.assign({}, b.airbnb, set.airbnb,
      b.airbnb.cancelDismissedAt ? { cancelDismissedAt: b.airbnb.cancelDismissedAt } : {});
    return Object.assign({}, b, set);
  });
  return { list: out, applied: applied };
}

module.exports = {
  parseAirbnbEmail, planBookingPatches, applyPatches,
  // exported for the tests
  cleanText, fullDates, dateRange, pounds, guestCount, digestMessages, firstMessage, replyBody,
  isPlaceholderName, roomOfProperty, normListing, threadKind
};
