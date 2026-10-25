// The timeline's pure parts: times, the merged day, and the printed sheet a
// couple hands to their suppliers. No React, so tests/timeline-print-test.mjs
// can run it in Node.

import { dayOrder } from '../shared/dayOrder.js'

export const hhmm = (t) => (t ? String(t).slice(0, 5) : '')

export function endsAt(start, mins) {
  if (!start || !mins) return null
  const [h, m] = String(start).split(':').map(Number)
  const total = h * 60 + m + mins
  return String(Math.floor(total / 60) % 24).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0')
}

// The venue's own times — music ends, bar closes, carriages, site closed — are
// part of the day, not a separate list to cross-reference. They are woven in at
// their own times so a couple planning speeches at 23:30 can SEE the bar closing
// at 23:45 on the line below, rather than being told it somewhere else.
//
// They come back computed, never stored, so they cannot go stale when an access
// time changes — and they are not editable here, which the row says quietly
// rather than with a button that refuses.
//
// Two things at the same time is fine. A band setting up while the cake arrives
// is an ordinary afternoon, so equal start times simply sit next to each other
// in the order they were added.
export function mergeDay(blocks, fixed) {
  const rows = blocks.map((b) => ({ kind: 'block', at: b.start_time, block: b }))
  for (const f of fixed || []) {
    if (f && f.time) rows.push({ kind: 'venue', at: f.time, title: f.title })
  }
  return rows.sort((a, b) => {
    // Not a text compare: midnight and half past belong at the END of the
    // wedding day, not the start of it. See dayOrder().
    const t = dayOrder(a.at) - dayOrder(b.at)
    if (t !== 0) return t
    // A venue line at the same minute reads better after the couple's own.
    return (a.kind === 'venue' ? 1 : 0) - (b.kind === 'venue' ? 1 : 0)
  })
}

export function lengthLabel(mins) {
  if (!mins) return null
  if (mins < 60) return mins + ' min'
  const h = Math.floor(mins / 60), m = mins % 60
  return h + (h === 1 ? ' hr' : ' hrs') + (m ? ' ' + m + ' min' : '')
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// The sheet for suppliers: every day of the booking with its lines in order
// (the venue's own times greyed in), who is responsible, the notes and the
// answers to the questions on a line; then the people to ring on the day and
// the suppliers with their contact details. Everything the couple typed is
// escaped. Unanswered questions are left off — a supplier needs the answers,
// not the form.
export function timelinePrintHtml({ eventName, eventDate, timeline, contacts, suppliers, categories }) {
  const t = timeline || { days: [], blocks: [] }
  const catLabel = (slug) => ((categories || []).find((c) => c.slug === slug) || {}).label || ''
  let body = ''
  for (const d of t.days || []) {
    const rows = mergeDay((t.blocks || []).filter((b) => b.day_key === d.day_key), d.fixed)
    if (!rows.length) continue
    body += '<section class="day"><h2>' + esc(d.label) + (d.access_text ? ' <span>Access ' + esc(d.access_text) + '</span>' : '') + '</h2><table>'
    for (const r of rows) {
      if (r.kind === 'venue') {
        body += '<tr class="venue"><td class="t">' + esc(hhmm(r.at)) + '</td><td>' + esc(r.title) + ' <em>(the venue)</em></td><td></td></tr>'
        continue
      }
      const b = r.block
      const end = endsAt(b.start_time, b.duration_min)
      const who = [b.supplier_name, b.contact_name].filter(Boolean).join(' · ')
      const prompts = String(b.prompts || '').split('\n').map((q) => q.trim()).filter(Boolean)
      const answers = Array.isArray(b.answers) ? b.answers : []
      const qa = prompts.map((q, i) => (answers[i] ? '<div class="qa">' + esc(q) + ' <b>' + esc(answers[i]) + '</b></div>' : '')).join('')
      body += '<tr><td class="t">' + esc(hhmm(b.start_time)) + (end && end !== hhmm(b.start_time) ? '–' + esc(end) : '') + '</td>' +
        '<td><b>' + esc(b.title) + '</b>' + (b.notes ? '<div class="n">' + esc(b.notes).replace(/\n/g, '<br>') + '</div>' : '') + qa + '</td>' +
        '<td class="w">' + esc(who) + '</td></tr>'
    }
    body += '</table></section>'
  }
  if (!body) body = '<p class="n">Nothing on the timeline yet.</p>'

  const people = (contacts || []).filter((c) => c && c.name)
  if (people.length) {
    body += '<section class="day"><h2>On the day, ring</h2><table>' + people.map((c) =>
      '<tr><td><b>' + esc(c.name) + '</b>' + (c.role ? '<div class="n">' + esc(c.role) + '</div>' : '') + '</td><td>' + esc(c.phone || '') + '</td><td class="w">' + esc(c.note || '') + '</td></tr>'
    ).join('') + '</table></section>'
  }
  const sup = (suppliers || []).filter((s) => s && s.name)
  if (sup.length) {
    body += '<section class="day"><h2>Suppliers</h2><table>' + sup.map((s) =>
      '<tr><td><b>' + esc(s.name) + '</b>' + (catLabel(s.category) ? '<div class="n">' + esc(catLabel(s.category)) + '</div>' : '') + '</td>' +
      '<td>' + esc(s.contact_name || '') + (s.phone ? '<div>' + esc(s.phone) + '</div>' : '') + '</td><td class="w">' + esc(s.email || '') + '</td></tr>'
    ).join('') + '</table></section>'
  }

  const title = (eventName || 'Our day') + ' — timeline'
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>' +
    'body{font-family:Georgia,serif;color:#222;margin:24px;font-size:12.5px}' +
    'h1{font-size:20px;margin:0 0 2px}.sub{color:#666;margin:0 0 18px;font-size:12px}' +
    'h2{font-size:14px;margin:18px 0 6px;border-bottom:1.5px solid #222;padding-bottom:3px}h2 span{color:#777;font-weight:normal;font-size:11.5px;margin-left:6px}' +
    'table{width:100%;border-collapse:collapse}td{padding:5px 6px;border-bottom:1px solid #ddd;vertical-align:top}' +
    'td.t{width:92px;white-space:nowrap;font-variant-numeric:tabular-nums}td.w{width:28%;color:#444}' +
    '.n{color:#555;margin-top:2px}.qa{color:#555;margin-top:2px;font-size:12px}tr.venue td{color:#888}' +
    '.day{break-inside:avoid-page}@media print{body{margin:0}}' +
    '</style></head><body><h1>' + esc(eventName || 'Our day') + '</h1><p class="sub">' +
    esc((eventDate ? eventDate + ' · ' : '') + 'Hawthbush Farm · printed ' + new Date().toLocaleDateString('en-GB')) +
    '</p>' + body + '<script>window.onload=function(){window.print()}<\/script></body></html>'
}
