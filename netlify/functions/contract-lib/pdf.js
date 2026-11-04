// netlify/functions/contract-lib/pdf.js
//
// The signed booking form as a PDF, drawn from the FROZEN contract body (see
// src/shared/contractDoc.js for its shape) plus the couple's answers, the
// signatures and the audit trail. pdf-lib with the standard fonts: no browser,
// no network, well inside Netlify's 10 seconds (a 14-page form takes ~100ms).
//
// The standard fonts can only draw Windows-1252 characters, so every string
// goes through safe() first: curly quotes, dashes, £ and · survive; anything
// else becomes its nearest plain equivalent or "?". A PDF that refuses to draw
// because somebody typed an emoji into their address must never happen.
//
// This folder holds no contract-lib.js or index.js, so Netlify does not treat
// it as a function; it is required by contract-sign.js and contract-admin.js.

const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const A4 = [595.28, 841.89];
const M = { left: 52, right: 52, top: 54, bottom: 64 };
const W = A4[0] - M.left - M.right;
const INK = rgb(0.176, 0.165, 0.145);
const MUTED = rgb(0.478, 0.439, 0.376);
const LINE = rgb(0.85, 0.82, 0.78);
const SOFT = rgb(0.965, 0.95, 0.925);

// Windows-1252 beyond Latin-1, which the standard fonts can draw.
const CP1252 = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
const SWAP = { "→": "->", "←": "<-", "≤": "<=", "≥": ">=", "−": "-", "‐": "-", "‑": "-",
  " ": " ", " ": " ", " ": " ", " ": " ", "​": "", "﻿": "", "′": "'", "″": "\"",
  "✓": "v", "✔": "v", "✕": "x", "✗": "x" };
function safe(s) {
  let out = "";
  for (const ch of String(s == null ? "" : s).normalize("NFC")) {
    const c = ch.codePointAt(0);
    if (ch === "\t") { out += " "; continue; }
    if (c >= 0x20 && c <= 0x7e) { out += ch; continue; }
    if (c >= 0xa0 && c <= 0xff) { out += ch; continue; }
    if (CP1252.indexOf(ch) !== -1) { out += ch; continue; }
    if (SWAP[ch] != null) { out += SWAP[ch]; continue; }
    const plain = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (plain && plain !== ch && /^[\x20-\x7e]+$/.test(plain)) { out += plain; continue; }
    // A letter or digit we cannot draw shows as "?" so the gap is visible; an
    // emoji or other symbol is simply left out.
    out += /[\p{L}\p{N}]/u.test(ch) ? "?" : "";
  }
  return out;
}

function money(v) {
  const s = String(v == null ? "" : v).replace(/[£,\s]/g, "");
  const n = Number(s);
  if (!s || !isFinite(n)) return String(v || "");
  return "£" + n.toLocaleString("en-GB", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
}
function ukDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? m[3] + "/" + m[2] + "/" + m[1] : "";
}
function when(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d)) return String(ts);
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(d);
}
function answerWord(a) { return a === "yes" ? "Yes" : a === "hold" ? "Hold" : a === "no" ? "No" : ""; }
function runsOf(text) {
  const out = [];
  String(text == null ? "" : text).split("**").forEach(function (p, i) { if (p) out.push({ text: p, bold: i % 2 === 1 }); });
  return out;
}

async function renderContractPdf(c) {
  const doc = await PDFDocument.create();
  const body = c.body || {};
  doc.setTitle(safe(body.title || "Booking form"));
  doc.setAuthor("Hawthbush Farm Ltd");
  doc.setSubject("Contract " + c.id + " version " + c.version);
  doc.setProducer("Hawthbush Farm venue app");
  const F = {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    ital: await doc.embedFont(StandardFonts.HelveticaOblique),
    sig: await doc.embedFont(StandardFonts.TimesRomanItalic),
  };

  let page, y;
  function newPage() { page = doc.addPage(A4); y = A4[1] - M.top; }
  newPage();
  function atTop() { return y >= A4[1] - M.top - 0.5; }
  function ensure(h) { if (y - h < M.bottom) newPage(); }
  function width(t, size, font) { return font.widthOfTextAtSize(safe(t), size); }

  // Wrap runs of text into lines of segments that fit `w`.
  function wrap(runs, size, w, baseFont) {
    const lines = [];
    let line = [], lineW = 0;
    function push() { lines.push(line); line = []; lineW = 0; }
    runs.forEach(function (run) {
      const font = run.font || (run.bold ? F.bold : baseFont || F.reg);
      String(run.text).split("\n").forEach(function (chunk, ci) {
        if (ci > 0) push();
        const words = safe(chunk).split(/(\s+)/);
        words.forEach(function (word) {
          if (!word) return;
          const isSpace = /^\s+$/.test(word);
          if (isSpace) { if (line.length) { const sw = font.widthOfTextAtSize(" ", size); line.push({ text: " ", font: font, w: sw }); lineW += sw; } return; }
          let ww = font.widthOfTextAtSize(word, size);
          if (lineW + ww > w && line.length) {
            while (line.length && line[line.length - 1].text === " ") { lineW -= line.pop().w; }
            push();
          }
          // A single word wider than the line (a hash, a long URL): break it.
          while (ww > w) {
            let n = word.length;
            while (n > 1 && font.widthOfTextAtSize(word.slice(0, n), size) > w - lineW) n--;
            line.push({ text: word.slice(0, n), font: font, w: font.widthOfTextAtSize(word.slice(0, n), size) });
            push();
            word = word.slice(n);
            ww = font.widthOfTextAtSize(word, size);
          }
          line.push({ text: word, font: font, w: ww });
          lineW += ww;
        });
      });
    });
    if (line.length) push();
    return lines.length ? lines : [[]];
  }
  function drawLines(lines, x, size, color, lh) {
    lines.forEach(function (ln) {
      ensure(lh);
      let cx = x;
      ln.forEach(function (seg) {
        if (seg.text !== " ") page.drawText(seg.text, { x: cx, y: y - size, size: size, font: seg.font, color: color || INK });
        cx += seg.w;
      });
      y -= lh;
    });
  }
  function para(text, o) {
    const opt = o || {};
    const size = opt.size || 9.5;
    const lines = wrap(opt.runs || runsOf(text), size, opt.width || W, opt.font);
    drawLines(lines, opt.x || M.left, size, opt.color, size * 1.38);
    y -= opt.after == null ? 5 : opt.after;
  }
  function heading(text, size, before) {
    if (!atTop()) y -= before;
    ensure(size * 1.4 + 30);   // never strand a heading at the foot of a page
    para(text, { size: size, font: F.bold, runs: runsOf(text).map(function (r) { return { text: r.text, font: F.bold }; }), after: size * 0.45 });
  }

  // A table: rows of cell strings. widths are fractions of W.
  function table(rows, opt) {
    const o = opt || {};
    const size = o.size || 9;
    const pad = 4;
    const n = Math.max.apply(null, rows.map(function (r) { return r.length; }));
    let fr = o.widths;
    if (!fr) {
      if (n === 2) fr = [0.42, 0.58];
      else {
        const longest = [];
        for (let i = 0; i < n; i++) longest.push(Math.max(4, Math.min(40, Math.max.apply(null, rows.map(function (r) { return String(r[i] || "").length; })))));
        const sum = longest.reduce(function (a, b) { return a + b; }, 0);
        fr = longest.map(function (l) { return l / sum; });
      }
    }
    const cols = fr.map(function (f) { return f * W; });
    y -= 2;
    rows.forEach(function (row, ri) {
      const head = o.head && ri === 0;
      const cells = cols.map(function (cw, ci) {
        const cell = row[ci] == null ? "" : row[ci];
        const runs = typeof cell === "object" && cell.runs ? cell.runs
          : runsOf(cell).map(function (r) { return { text: r.text, bold: r.bold || head, font: (o.firstColMuted && ci === 0 && !head) ? F.reg : undefined }; });
        return wrap(runs, size, cw - pad * 2, F.reg);
      });
      const lh = size * 1.35;
      const h = Math.max.apply(null, cells.map(function (l) { return l.length; })) * lh + pad * 2;
      if (y - h < M.bottom) newPage();
      let x = M.left;
      cells.forEach(function (lines, ci) {
        page.drawRectangle({ x: x, y: y - h, width: cols[ci], height: h, borderColor: LINE, borderWidth: 0.7,
          color: head ? SOFT : undefined });
        let ty = y - pad;
        lines.forEach(function (ln) {
          let cx = x + pad;
          ln.forEach(function (seg) {
            if (seg.text !== " ") page.drawText(seg.text, { x: cx, y: ty - size, size: size, font: seg.font,
              color: (o.firstColMuted && ci === 0 && !head) ? MUTED : INK });
            cx += seg.w;
          });
          ty -= lh;
        });
        x += cols[ci];
      });
      y -= h;
    });
    y -= 8;
  }

  const a = c.answers || {};
  const signers = c.signers || [];
  function signer(role) { return signers.find(function (s) { return s.role === role; }) || null; }

  function accommodation() {
    const rows = [["Property", "Yes / Hold / No", "From", "To", "Fee (incl. VAT)"]];
    (body.accommodation || []).forEach(function (row) {
      if (row.key !== "glamping") {
        rows.push([row.label, answerWord(a[row.key]) || "-", ukDate(row.from), ukDate(row.to), money(row.fee)]);
        return;
      }
      const opts = row.options || [];
      let n = a.glampingNights == null || a.glampingNights === "" ? null : Number(a.glampingNights);
      if (n == null && opts.length === 1) n = Number(opts[0].nights);
      opts.forEach(function (o) {
        const picked = a.glamping && a.glamping !== "no" && Number(o.nights) === n;
        rows.push([row.label + ", " + (o.nights === 1 ? "1 night" : o.nights + " nights"),
          picked ? answerWord(a.glamping) : (a.glamping ? "No" : "-"), ukDate(o.from), ukDate(o.to), money(o.fee)]);
      });
    });
    table(rows, { head: true, widths: [0.36, 0.16, 0.15, 0.15, 0.18] });
  }

  function signatures() {
    const venue = body.venue || {};
    const parties = [signer("client1")].concat(c.one_signer ? [] : [signer("client2")]);
    const labels = ["First party", "Second party"];
    ensure(150);
    const colW = (W - 16) / 2;
    // Pairs side by side: first and second party.
    const top = y;
    let lowest = y;
    parties.forEach(function (s, i) {
      y = top;
      const x = M.left + i * (colW + 16);
      const role = "client" + (i + 1);
      para(labels[i], { x: x, width: colW, font: F.bold, runs: [{ text: labels[i], font: F.bold }], after: 2 });
      sigBlock(x, colW, s && s.signed_at ? s.signed_name : "", a[role + "Name"] || (s && s.name) || "",
        [["Mobile", a[role + "Mobile"] || ""], ["Date", s && s.signed_at ? ukDate(new Date(s.signed_at).toISOString()) : ""]],
        s && s.signed_at ? "Signed electronically by " + s.email + " on " + when(s.signed_at) + (s.ip ? " from " + s.ip : "") : "Not signed");
      lowest = Math.min(lowest, y);
    });
    y = lowest - 4;
    table([["Correspondence address", a.address || ""]], { firstColMuted: true });
    sigBlock(M.left, colW, venue.name || "", venue.name || "",
      [["For", venue.company || "Hawthbush Farm Ltd"], ["Date", venue.signed_at ? ukDate(new Date(venue.signed_at).toISOString()) : ""]],
      "Signed electronically for Hawthbush Farm Ltd when the form was sent" + (venue.signed_at ? ", " + when(venue.signed_at) : ""),
      "Signature — Hawthbush Farm");
  }
  function sigBlock(x, w, sigText, printName, extra, note, title) {
    if (title) para(title, { x: x, width: w, font: F.bold, runs: [{ text: title, font: F.bold }], after: 2 });
    ensure(110);
    // The typed name, as the signature.
    page.drawText(safe(sigText || " "), { x: x + 2, y: y - 22, size: 17, font: F.sig, color: INK });
    page.drawLine({ start: { x: x, y: y - 28 }, end: { x: x + w, y: y - 28 }, thickness: 0.7, color: LINE });
    y -= 31;
    para("Signature", { x: x, width: w, size: 7.5, color: MUTED, after: 3 });
    [["Print name", printName]].concat(extra).forEach(function (p) {
      para(p[1] || " ", { x: x, width: w, size: 9.5, after: 0 });
      page.drawLine({ start: { x: x, y: y - 1 }, end: { x: x + w, y: y - 1 }, thickness: 0.5, color: LINE });
      y -= 3;
      para(p[0], { x: x, width: w, size: 7.5, color: MUTED, after: 4 });
    });
    para(note, { x: x, width: w, size: 7.5, color: MUTED, font: F.ital, runs: [{ text: note, font: F.ital }], after: 8 });
  }

  // ── The document ─────────────────────────────────────────────────────────
  (body.blocks || []).forEach(function (b) {
    switch (b.t) {
      case "h1": heading(b.text, 16, 10); break;
      case "h2": heading(b.text, 13, 10); break;
      case "h3": heading(b.text, 10.5, 6); break;
      case "p": para(b.text); break;
      case "ul":
        b.items.forEach(function (it) {
          const lines = wrap(runsOf(it), 9.5, W - 14, F.reg);
          ensure(9.5 * 1.38);
          page.drawText("•", { x: M.left + 3, y: y - 9.5, size: 9.5, font: F.reg, color: INK });
          drawLines(lines, M.left + 14, 9.5, INK, 9.5 * 1.38);
          y -= 1.5;
        });
        y -= 4;
        break;
      case "table": table(b.rows, { head: b.head, firstColMuted: !b.head && b.rows.every(function (r) { return r.length === 2; }) }); break;
      case "break": if (!atTop()) newPage(); break;
      case "accommodation": accommodation(); break;
      case "invoicing":
        table([["Name of person to invoice", a.invoiceName || ""], ["Email of person to be sent invoice", a.invoiceEmail || ""]], { firstColMuted: true });
        break;
      case "requirements":
        table([["Special requirements", a.requirements || "None given"]], { firstColMuted: true });
        break;
      case "signatures": signatures(); break;
      default: break;
    }
  });

  // ── The signing record ───────────────────────────────────────────────────
  newPage();
  heading("Signing record", 13, 0);
  para("This page is part of the booking form. It records how and when the form was sent and signed. " +
       "The fingerprints are SHA-256 hashes: the first is of the form exactly as it was sent, the second of the form " +
       "together with everything filled in and every signature. Any change to either would change its fingerprint.",
       { size: 8.5, color: MUTED });
  const ev = body.event || {};
  table([
    ["Contract", String(c.id)],
    ["Version", String(c.version)],
    ["Event", [ev.name, ev.date ? ukDate(ev.date) : ""].filter(Boolean).join(" · ")],
    ["Sent", when(c.sent_at) + (c.sent_by_name ? " by " + c.sent_by_name : "")],
    ["Completed", when(c.signed_at)],
    ["Fingerprint as sent", c.body_sha256 || ""],
    ["Fingerprint as signed", c.final_sha256 || ""],
  ], { firstColMuted: true, size: 8.5 });
  heading("Signatures", 10.5, 4);
  table([["Signer", "Signed as", "When (UK time)", "IP address"]].concat(signers.map(function (s) {
    return [s.name + " <" + s.email + ">", s.signed_name || "-", when(s.signed_at), s.ip || "-"];
  })), { head: true, size: 8.5, widths: [0.36, 0.2, 0.26, 0.18] });
  heading("Activity", 10.5, 4);
  table([["When (UK time)", "What", "Who", "IP address"]].concat((c.log || []).map(function (l) {
    return [when(l.at), l.what || "", l.who || "", l.ip || ""];
  })), { head: true, size: 8, widths: [0.24, 0.42, 0.2, 0.14] });

  // ── Footers, now the page count is known ─────────────────────────────────
  const pages = doc.getPages();
  const title = safe(body.title || "Booking form");
  pages.forEach(function (p, i) {
    const left = "Hawthbush Farm Ltd · " + title;
    const right = "Page " + (i + 1) + " of " + pages.length;
    p.drawLine({ start: { x: M.left, y: 44 }, end: { x: A4[0] - M.right, y: 44 }, thickness: 0.5, color: LINE });
    p.drawText(safe(left), { x: M.left, y: 32, size: 7.5, font: F.reg, color: MUTED });
    p.drawText(right, { x: A4[0] - M.right - F.reg.widthOfTextAtSize(right, 7.5), y: 32, size: 7.5, font: F.reg, color: MUTED });
    p.drawText(safe("Contract " + c.id + " · version " + c.version + " · Gun Hill, Heathfield, East Sussex TN21 0JY"),
      { x: M.left, y: 22, size: 6.5, font: F.reg, color: MUTED });
  });

  return Buffer.from(await doc.save());
}

module.exports = { renderContractPdf: renderContractPdf, safe: safe };
