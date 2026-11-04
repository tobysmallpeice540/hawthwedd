// Contracts written in the app: the template markup, how a template becomes a
// FROZEN contract body, and the small helpers the staff app, the portal and
// the tests share. Pure — no React, no network. The PDF is drawn by
// netlify/functions/contract-lib/pdf.js from the same frozen body.
//
// THE BODY (what ct_admin_issue stores and hashes, and what everyone renders):
//   { format: 1, title, template: {id, name, savedAt},
//     event: {id, name, type, date, endDate},
//     blocks: [ {t:"h1"|"h2"|"h3", text} | {t:"p", text} | {t:"ul", items:[]}
//             | {t:"table", rows:[[cell]], head:bool}
//             | {t:"accommodation"} | {t:"invoicing"} | {t:"requirements"}
//             | {t:"signatures"} | {t:"break"} ],
//     data: { the contract fields as raw values, custom: {label: value} },
//     accommodation: [ {key:"amly"|"hamlet", label, from, to, fee}
//                    | {key:"glamping", label, options:[{nights, from, to, fee}]} ],
//     parties: { one: bool, client1: name, client2: name|null },
//     venue: {company, name, signed_at}            ← added by the database }
// Text may hold **bold**. Every {{field}} is already filled in.

// ── Markup ──────────────────────────────────────────────────────────────────

export const CONTRACT_SYNTAX_HELP = [
  ["# Heading", "A big heading. ## and ### for smaller ones."],
  ["A line of text", "A paragraph. Leave a blank line between paragraphs."],
  ["- an item", "A bullet point. Put each on its own line."],
  ["**words**", "Bold."],
  ["| a | b |", "A table row. Add a row of |---|---| under the first row to make it a header."],
  ["{{Venue fee}}", "A field, filled in from the event when the contract is sent. Pick one from the list, or type your own label — it becomes a box on the Contract tab."],
  ["[[Accommodation]]", "The cottages and glamping the couple say Yes, Hold or No to (only what has a fee on the Contract tab)."],
  ["[[Invoicing]]", "Who should be sent the invoices."],
  ["[[Special requirements]]", "A box for anything the couple want to tell you."],
  ["[[Signatures]]", "Names, mobiles, address and the signatures. Added at the end if you leave it out."],
  ["[[Page break]]", "Starts a new page in the PDF."],
  ["[[If accommodation]] … [[End if]]", "Everything between is left out when no accommodation is offered."],
];

const BLOCK_NAMES = {
  "accommodation": "accommodation",
  "invoicing": "invoicing",
  "invoice": "invoicing",
  "special requirements": "requirements",
  "requirements": "requirements",
  "signatures": "signatures",
  "signature": "signatures",
  "page break": "break",
};

function norm(s) { return String(s || "").toLowerCase().replace(/[\s_-]+/g, " ").replace(/[^a-z0-9 ()]/g, "").trim(); }

// The fields a template can use. `key` is the contract field on the Contract
// tab (buildContractDefaults in App.jsx) or a special. Labels are matched
// loosely: case, spaces, hyphens and punctuation are ignored.
export const CONTRACT_FIELDS = [
  { label: "Event name",            key: "eventName" },
  { label: "Event type",            key: "eventType" },
  { label: "Event date",            key: "eventDate", date: true },
  { label: "Event dates",           key: "$eventDates" },
  { label: "Access day before",     key: "accessBefore" },
  { label: "Access event day",      key: "accessDay" },
  { label: "Access day after",      key: "accessAfter" },
  { label: "Maximum guests",        key: "maxGuests", aliases: ["max guests"] },
  { label: "Venue fee",             key: "venueFee", money: true },
  { label: "Non-standard terms",    key: "nonStandard", empty: "N/A", aliases: ["non standard terms"] },
  { label: "Client 1 name",         key: "client1Name" },
  { label: "Client 2 name",         key: "client2Name" },
  { label: "Clients",               key: "$clients", aliases: ["couple"] },
  { label: "Amly fee",              key: "amlyFee", money: true },
  { label: "Hamlet fee",            key: "hamletFee", money: true },
  { label: "Glamping fee 1 night",  key: "glampingFeePd", money: true },
  { label: "Glamping fee 2 nights", key: "glamping2Fee", money: true },
  { label: "Date sent",             key: "$today", aliases: ["today"] },
  { label: "Booking reference",     key: "$ref" },
];

export function contractFieldFor(label) {
  const n = norm(label);
  return CONTRACT_FIELDS.find(function (f) {
    return norm(f.label) === n || (f.aliases || []).some(function (a) { return norm(a) === n; });
  }) || null;
}

// Parse template text into nodes. Blocks and conditions are on lines of their
// own; anything else is text. Never throws: odd input becomes paragraphs, and
// what looks wrong is reported in `warnings`.
export function parseContractTemplate(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const root = [];
  const stack = [{ list: root, cond: null }];
  const warnings = [];
  const fields = [];
  const blocks = {};
  let para = null, ul = null, table = null;

  function top() { return stack[stack.length - 1].list; }
  function flush() {
    if (para) { top().push({ t: "p", text: para.join("\n") }); para = null; }
    if (ul) { top().push({ t: "ul", items: ul }); ul = null; }
    if (table) { top().push({ t: "table", rows: table.rows, head: table.head }); table = null; }
  }
  function noteFields(s) {
    String(s).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, function (m, lab) {
      if (fields.indexOf(lab) === -1) fields.push(lab);
      return m;
    });
  }

  lines.forEach(function (raw, i) {
    const line = raw.replace(/\s+$/, "");
    const trimmed = line.trim();
    const bm = /^\[\[\s*([^\]]+?)\s*\]\]$/.exec(trimmed);
    if (bm) {
      flush();
      const name = norm(bm[1]);
      if (name === "if accommodation") {
        const node = { t: "if", cond: "accommodation", children: [] };
        top().push(node);
        stack.push({ list: node.children, cond: "accommodation" });
      } else if (name === "end if" || name === "endif") {
        if (stack.length > 1) stack.pop();
        else warnings.push("Line " + (i + 1) + ": [[End if]] with no [[If accommodation]] before it.");
      } else if (BLOCK_NAMES[name]) {
        const b = BLOCK_NAMES[name];
        top().push({ t: b });
        blocks[b] = (blocks[b] || 0) + 1;
      } else {
        warnings.push("Line " + (i + 1) + ": [[" + bm[1] + "]] is not something the contract knows — it will show as text.");
        para = (para || []).concat([trimmed]);
      }
      return;
    }
    if (trimmed === "---" || trimmed === "***") { flush(); top().push({ t: "break" }); return; }
    if (!trimmed) { flush(); return; }
    const h = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (h) { flush(); noteFields(h[2]); top().push({ t: "h" + h[1].length, text: h[2] }); return; }
    if (/^\|.*\|$/.test(trimmed)) {
      if (para || ul) { const keep = table; table = null; flush(); table = keep; }
      const cells = trimmed.slice(1, -1).split("|").map(function (c) { return c.trim(); });
      if (cells.every(function (c) { return /^:?-{2,}:?$/.test(c); })) {
        if (table && table.rows.length === 1) table.head = true;
        return;
      }
      cells.forEach(noteFields);
      if (!table) table = { rows: [], head: false };
      table.rows.push(cells);
      return;
    }
    const li = /^(?:[-*•])\s+(.*)$/.exec(trimmed);
    if (li) {
      if (para || table) { const keepUl = ul; ul = null; flush(); ul = keepUl; }
      noteFields(li[1]);
      ul = (ul || []).concat([li[1]]);
      return;
    }
    if (ul || table) flush();
    noteFields(trimmed);
    para = (para || []).concat([trimmed]);
  });
  flush();
  if (stack.length > 1) warnings.push("[[If accommodation]] is never closed with [[End if]] — everything after it counts as part of it.");
  if ((blocks.signatures || 0) > 1) warnings.push("[[Signatures]] appears more than once; only the first is used.");
  ["accommodation", "invoicing", "requirements"].forEach(function (b) {
    if ((blocks[b] || 0) > 1) warnings.push("[[" + b + "]] appears more than once.");
  });
  const custom = fields.filter(function (l) { return !contractFieldFor(l); });
  return { nodes: root, fields: fields, custom: custom, blocks: blocks, warnings: warnings };
}

// ── Values ──────────────────────────────────────────────────────────────────

export function contractMoney(v) {
  const s = String(v == null ? "" : v).replace(/[£,\s]/g, "");
  if (!s) return "";
  const n = Number(s);
  if (!isFinite(n)) return String(v);
  return "£" + n.toLocaleString("en-GB", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function contractDate(iso, short) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  return Number(m[3]) + " " + (short ? SHORT : MONTHS)[Number(m[2]) - 1] + " " + m[1];
}
export function contractDateRange(from, to) {
  if (!from) return "";
  if (!to || to === from) return contractDate(from);
  return contractDate(from) + " to " + contractDate(to);
}

// The value of one {{field}} for this contract, as text.
function fieldValue(label, ctx) {
  const def = contractFieldFor(label);
  if (!def) {
    const c = (ctx.custom || {})[label];
    return c == null ? "" : String(c);
  }
  const f = ctx.fields || {};
  if (def.key === "$eventDates") return contractDateRange(f.eventDate, ctx.event && ctx.event.endDate);
  if (def.key === "$today") return contractDate(ctx.today);
  if (def.key === "$ref") return ctx.event && ctx.event.id != null ? String(ctx.event.id) : "";
  if (def.key === "$clients") {
    return [f.client1Name, ctx.one ? "" : f.client2Name].filter(function (x) { return String(x || "").trim(); }).join(" & ");
  }
  const raw = f[def.key];
  if (raw == null || String(raw).trim() === "") return def.empty || "";
  if (def.money) return contractMoney(raw);
  if (def.date) return contractDate(raw);
  return String(raw);
}

// The accommodation offered: a row for each property with a fee.
export const CONTRACT_ACCOM_LABELS = {
  amly: "Amly Barn (3 bedrooms)",
  hamlet: "The Hamlet (7 bedrooms)",
  glamping: "Glamping (7 tents, 20 beds)",
};
function hasFee(v) { const n = Number(String(v == null ? "" : v).replace(/[£,\s]/g, "")); return isFinite(n) && n > 0; }
export function contractAccommodation(f) {
  const out = [];
  if (hasFee(f.amlyFee)) out.push({ key: "amly", label: CONTRACT_ACCOM_LABELS.amly, from: f.amlyFrom || "", to: f.amlyTo || "", fee: String(f.amlyFee) });
  if (hasFee(f.hamletFee)) out.push({ key: "hamlet", label: CONTRACT_ACCOM_LABELS.hamlet, from: f.hamletFrom || "", to: f.hamletTo || "", fee: String(f.hamletFee) });
  const opts = [];
  if (hasFee(f.glampingFeePd)) opts.push({ nights: 1, from: f.glampingFrom || "", to: f.glampingTo || "", fee: String(f.glampingFeePd) });
  if (hasFee(f.glamping2Fee)) opts.push({ nights: 2, from: f.glamping2From || "", to: f.glamping2To || "", fee: String(f.glamping2Fee) });
  if (opts.length) out.push({ key: "glamping", label: CONTRACT_ACCOM_LABELS.glamping, options: opts });
  return out;
}

// Fill in every {{field}} and decide every [[If accommodation]]. Returns the
// frozen blocks plus the fields that came out empty (for a warning before
// sending — an empty field is allowed, it is just shown as blank).
export function resolveContractNodes(nodes, ctx) {
  const empty = [];
  let sigs = false;
  function fill(s) {
    return String(s).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, function (m, lab) {
      const v = fieldValue(lab, ctx);
      if (!v && empty.indexOf(lab) === -1) empty.push(lab);
      return v;
    });
  }
  function walk(list, out) {
    list.forEach(function (n) {
      if (n.t === "if") { if (ctx.hasAccommodation) walk(n.children, out); return; }
      if (n.t === "p" || /^h[123]$/.test(n.t)) { out.push({ t: n.t, text: fill(n.text) }); return; }
      if (n.t === "ul") { out.push({ t: "ul", items: n.items.map(fill) }); return; }
      if (n.t === "table") { out.push({ t: "table", head: !!n.head, rows: n.rows.map(function (r) { return r.map(fill); }) }); return; }
      if (n.t === "accommodation" && !ctx.hasAccommodation) return;
      if (n.t === "signatures") { if (sigs) return; sigs = true; }
      out.push({ t: n.t });
    });
  }
  const blocks = [];
  walk(nodes, blocks);
  if (!sigs) blocks.push({ t: "h2", text: "Signatures" }, { t: "signatures" });
  // No page break at the very start or end, and never two in a row.
  const tidy = blocks.filter(function (b, i) {
    if (b.t !== "break") return true;
    const prev = blocks[i - 1];
    return i > 0 && i < blocks.length - 1 && prev && prev.t !== "break";
  });
  return { blocks: tidy, empty: empty };
}

export function contractTitle(nodes) {
  const h = (nodes || []).find(function (n) { return n.t === "h1"; });
  return h ? h.text.replace(/\*\*/g, "") : "Booking form";
}

// ── The couple's answers ────────────────────────────────────────────────────

// What is still needed before signing. Mirrors ct_missing() in the database,
// which is the one that is enforced.
export function contractMissing(body, one, a) {
  const miss = [];
  const v = a || {};
  function blank(k) { return !String(v[k] == null ? "" : v[k]).trim(); }
  if (blank("client1Name")) miss.push("client1Name");
  if (blank("client1Mobile")) miss.push("client1Mobile");
  if (!one) {
    if (blank("client2Name")) miss.push("client2Name");
    if (blank("client2Mobile")) miss.push("client2Mobile");
  }
  if (blank("address")) miss.push("address");
  ((body && body.accommodation) || []).forEach(function (row) {
    const ans = String(v[row.key] || "");
    if (["yes", "hold", "no"].indexOf(ans) === -1) { miss.push(row.key); return; }
    if (row.key === "glamping" && ans !== "no") {
      const opts = row.options || [];
      let n = v.glampingNights == null || v.glampingNights === "" ? null : Number(v.glampingNights);
      if (n == null && opts.length === 1) n = Number(opts[0].nights);
      if (n == null || !opts.some(function (o) { return Number(o.nights) === n; })) miss.push("glampingNights");
    }
  });
  return miss;
}

export const CONTRACT_MISSING_LABELS = {
  client1Name: "your full name", client1Mobile: "your mobile",
  client2Name: "the second name", client2Mobile: "the second mobile",
  address: "your correspondence address", amly: "Amly Barn — yes, hold or no",
  hamlet: "The Hamlet — yes, hold or no", glamping: "Glamping — yes, hold or no",
  glampingNights: "Glamping — one night or two",
};

export function answerWord(a) {
  return a === "yes" ? "Yes" : a === "hold" ? "Hold" : a === "no" ? "No" : "";
}

// The chosen glamping option (or null), given the answers.
export function glampingChoice(row, a) {
  if (!row || !row.options || !row.options.length) return null;
  const v = a || {};
  let n = v.glampingNights == null || v.glampingNights === "" ? null : Number(v.glampingNights);
  if (n == null && row.options.length === 1) n = Number(row.options[0].nights);
  return row.options.find(function (o) { return Number(o.nights) === n; }) || null;
}

// The answers in the shape SignWell returned, so the existing review panel
// (contractWriteback, contractStays in App.jsx) works on an in-app contract
// unchanged. Dates as DD/MM/YYYY, as SignWell gave them.
function ukDate(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || "")); return m ? m[3] + "/" + m[2] + "/" + m[1] : ""; }
export function contractValuesForReview(body, a) {
  const d = (body && body.data) || {};
  const v = a || {};
  const out = {
    "Client 1 Name": v.client1Name || "", "Client 2 Name": v.client2Name || "",
    "Client 1 Mobile": v.client1Mobile || "", "Client 2 Mobile": v.client2Mobile || "",
    "Address": v.address || "", "Email Invoiced": v.invoiceEmail || "", "Name Invoiced": v.invoiceName || "",
    "Special Requirements": v.requirements || "",
    "Event Name": d.eventName || "", "Event Type": d.eventType || "", "Event Date": ukDate(d.eventDate),
    "Venue Fee": d.venueFee || "", "Non Standard Terms": d.nonStandard || "",
  };
  ((body && body.accommodation) || []).forEach(function (row) {
    if (row.key === "amly" || row.key === "hamlet") {
      const n = row.key === "amly" ? "Amly" : "Hamlet";
      out[n] = answerWord(v[row.key]);
      out[n + " From"] = ukDate(row.from); out[n + " to"] = ukDate(row.to); out[n + " Fee"] = row.fee || "";
      return;
    }
    if (row.key === "glamping") {
      const ch = glampingChoice(row, v);
      const ans = answerWord(v.glamping);
      (row.options || []).forEach(function (o) {
        const picked = ans && ans !== "No" && ch && Number(ch.nights) === Number(o.nights);
        if (Number(o.nights) === 2) {
          out["Glamping 2 night"] = picked ? ans : "No";
          out["Glamping 2 from"] = ukDate(o.from); out["Glamping 2 to"] = ukDate(o.to); out["Glamping 2 fee"] = o.fee || "";
        } else {
          out["Glamping"] = picked ? ans : "No";
          out["Glamping from"] = ukDate(o.from); out["Glamping to"] = ukDate(o.to); out["Glamping fee pd"] = o.fee || "";
        }
      });
    }
  });
  return out;
}

// Split text on **bold** into runs: [{text, bold}].
export function boldRuns(text) {
  const out = [];
  const parts = String(text == null ? "" : text).split("**");
  parts.forEach(function (p, i) { if (p) out.push({ text: p, bold: i % 2 === 1 }); });
  return out;
}

// ── Importing a Word document ───────────────────────────────────────────────

// HTML (from mammoth's docx conversion) to template markup. Headings, paragraphs,
// bold, bullets and tables survive; everything else becomes plain text.
export function htmlToContractMarkup(html, DOMParserImpl) {
  const P = DOMParserImpl || (typeof DOMParser !== "undefined" ? DOMParser : null);
  if (!P) throw new Error("No HTML parser available");
  const doc = new P().parseFromString("<div>" + String(html || "") + "</div>", "text/html");
  const root = doc.body.firstChild;
  const out = [];
  function inline(node) {
    let s = "";
    node.childNodes.forEach(function (c) {
      if (c.nodeType === 3) { s += c.nodeValue.replace(/\s+/g, " "); return; }
      if (c.nodeType !== 1) return;
      const tag = c.tagName.toLowerCase();
      if (tag === "br") { s += "\n"; return; }
      const inner = inline(c);
      if ((tag === "strong" || tag === "b") && inner.trim()) s += "**" + inner.trim() + "** ";
      else s += inner;
    });
    return s.replace(/ \*\*/g, " **").replace(/[ \t]+\n/g, "\n");
  }
  function cell(td) { return inline(td).replace(/\|/g, "/").replace(/\s*\n\s*/g, " ").trim(); }
  root.childNodes.forEach(function (n) {
    if (n.nodeType !== 1) { const t = (n.nodeValue || "").trim(); if (t) out.push(t, ""); return; }
    const tag = n.tagName.toLowerCase();
    const text = inline(n).trim();
    if (/^h[1-6]$/.test(tag)) { if (text) out.push("#".repeat(Math.min(3, Number(tag[1]))) + " " + text.replace(/\*\*/g, ""), ""); return; }
    if (tag === "ul" || tag === "ol") {
      n.querySelectorAll(":scope > li").forEach(function (li) { const t = inline(li).trim(); if (t) out.push("- " + t.replace(/\n+/g, " ")); });
      out.push(""); return;
    }
    if (tag === "table") {
      const rows = Array.prototype.slice.call(n.querySelectorAll("tr"));
      rows.forEach(function (tr, i) {
        const cells = Array.prototype.slice.call(tr.children).map(cell);
        out.push("| " + cells.join(" | ") + " |");
        if (i === 0 && tr.querySelector("th")) out.push("|" + cells.map(function () { return "---"; }).join("|") + "|");
      });
      out.push(""); return;
    }
    if (text) out.push(text, "");
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// The kind of event, for choosing a template.
export const CONTRACT_KINDS = [["wedding", "Weddings"], ["party", "Parties"], ["wake", "Wakes"], ["other", "Other events"]];
export function contractKindOf(eventType) {
  const t = String(eventType || "").toLowerCase();
  if (t.indexOf("wedding") !== -1) return "wedding";
  if (t.indexOf("party") !== -1) return "party";
  if (t.indexOf("wake") !== -1 || t.indexOf("funeral") !== -1 || t.indexOf("memorial") !== -1 || t.indexOf("celebration of life") !== -1) return "wake";
  return "other";
}
