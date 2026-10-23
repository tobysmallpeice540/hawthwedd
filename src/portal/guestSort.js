// Sorting a guest list, and the words for the three accommodations.
//
// Pure, and in its own module for the same reason parseGuests.js is: it can
// then be tested without a browser. tests/guest-sort-test.mjs does that.

// The three the diary knows about, in the couple's words rather than the
// database's. Only the ones actually booked or held are ever offered.
export const ACCOM_LABEL = { amly: 'Amly', hamlet: 'The Hamlet', camping: 'Glamping' }
export const ACCOM_KEYS = ['amly', 'hamlet', 'camping']

export function accomOptions(accommodation) {
  const a = accommodation || {}
  return ACCOM_KEYS.filter((k) => a[k] === 'yes' || a[k] === 'hold')
}

// "Table 12" sorts before "Table 2" as text and after it as a number, and
// anybody reading a list of twenty-five tables will notice. Pull the digits out.
// Anything unnumbered goes after the numbered ones; anybody unseated goes last,
// which is where you want them when you are working out who is left.
export function tableRank(g) {
  if (!g || !g.table_label) return Number.MAX_SAFE_INTEGER
  const m = /(\d+)/.exec(g.table_label)
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER - 1
}

export function byName(a, b) {
  return (a.last_name || '').localeCompare(b.last_name || '') ||
         (a.first_name || '').localeCompare(b.first_name || '')
}

// Sorting by where somebody is staying has THREE groups, not two, and the
// middle one is the whole point:
//
//   0..2  in a particular place — Amly, then the Hamlet, then glamping
//   3     staying, but nowhere decided yet
//   9     not staying at all
//
// The first version collapsed the middle into the last, because both have a
// null staying_where. That put the people who still need a bed found for them
// at the very bottom of the list, mixed in with everyone going home — which is
// exactly backwards, since they are the only ones the sort is any use for.
export function stayingRank(g) {
  if (!g || !g.staying) return 9
  const i = ACCOM_KEYS.indexOf(g.staying_where)
  return i >= 0 ? i : 3
}

// Name is always the tie-break, whichever column is chosen. A list that keeps
// re-ordering within a group is harder to read than one that never sorted.
export function sortGuests(guests, how) {
  const out = (guests || []).slice()
  if (how === 'table') {
    out.sort((a, b) => tableRank(a) - tableRank(b) || byName(a, b))
  } else if (how === 'where') {
    out.sort((a, b) => stayingRank(a) - stayingRank(b) || byName(a, b))
  } else if (how === 'name') {
    out.sort(byName)
  }
  return out
}

// ── export and print ───────────────────────────────────────────────────────
//
// Anyone with a role on the day (best man, ushers, readers…) at the top,
// alphabetical; then everyone else, alphabetical. Toby's rule for every
// printed list: the people who have a job are the ones looked for first.
export function hasRole(g) { return !!(g && String(g.role || '').trim()) }

export function roleFirst(guests) {
  const all = (guests || []).slice().sort(byName)
  return { withRole: all.filter(hasRole), rest: all.filter((g) => !hasRole(g)) }
}

// Seated guests by table, in table order (Table 2 before Table 12), unseated
// last; names alphabetical within each table, people with a role first.
export function byTable(guests) {
  const groups = new Map()
  const seated = (guests || []).filter((g) => g.list !== 'evening')
    .slice().sort((a, b) => tableRank(a) - tableRank(b))
  for (const g of seated) {
    const k = g.table_label || ''
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(g)
  }
  return Array.from(groups, ([label, list]) => {
    const r = roleFirst(list)
    return { label: label || 'Not seated yet', seated: !!label, guests: r.withRole.concat(r.rest) }
  })
}

export function fullName(g) { return [g.first_name, g.last_name].filter(Boolean).join(' ') }

const RSVP_WORD = { yes: 'Coming', no: 'Not coming', maybe: 'Maybe' }
const AGE_WORD = { adult: 'Adult', child: 'Child', baby: 'High chair' }

// One cell of a CSV. Quoted when it must be, and a cell that a spreadsheet
// would run as a formula (=, +, -, @ at the start) is defused with a leading
// apostrophe: a guest typed as "=HYPERLINK(…)" must stay a name.
function cell(v) {
  let s = v === null || v === undefined ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

export const CSV_COLUMNS = ['List', 'First name', 'Last name', 'Role', 'Reply', 'Age', 'Table',
  'Side', 'Staying', 'Where', 'Access or dietary needs']

export function guestsCsv(guests) {
  const r = roleFirst(guests)
  const rows = r.withRole.concat(r.rest).map((g) => [
    g.list === 'evening' ? 'Evening only' : 'Seated',
    g.first_name, g.last_name, g.role, RSVP_WORD[g.rsvp] || '', AGE_WORD[g.age_band] || '',
    g.list === 'evening' ? '' : (g.table_label || ''),
    g.side, g.staying ? 'Yes' : 'No', g.staying ? (ACCOM_LABEL[g.staying_where] || 'Not decided') : '',
    g.access_needs,
  ])
  // Byte-order mark first, so Excel reads the accents in a name as UTF-8.
  return '﻿' + [CSV_COLUMNS].concat(rows).map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
}

// The printed lists, as a whole HTML page for a print window. Shared by the
// client's Guests tab and the event form in the staff app, so both print the
// same thing.
function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function guestsFileName(eventName, ext) {
  const base = String(eventName || 'guest list').replace(/[^A-Za-z0-9 &'-]+/g, ' ').trim().replace(/\s+/g, ' ')
  return (base || 'guest list') + ' - guests.' + ext
}

function where(g) {
  return g.list === 'evening' ? 'Evening' : (g.table_label || '—')
}

function rowsHtml(list, cols) {
  return list.map((g) => '<tr>' + cols.map((c) => '<td>' + esc(c(g)) + '</td>').join('') + '</tr>').join('')
}

function tableHtml(heads, list, cols) {
  return '<table><thead><tr>' + heads.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
    rowsHtml(list, cols) + '</tbody></table>'
}

export function guestsPrintHtml(guests, how, eventName, eventDate) {
  const r = roleFirst(guests)
  const needs = (g) => [g.age_band === 'child' ? 'Child' : g.age_band === 'baby' ? 'High chair' : '', g.access_needs]
    .filter(Boolean).join(' · ')
  let body = ''
  if (r.withRole.length) {
    body += '<h2>With a role on the day <span>' + r.withRole.length + '</span></h2>' +
      tableHtml(['Name', 'Role', 'Table'], r.withRole, [fullName, (g) => g.role, where])
  }
  if (how === 'name') {
    body += '<h2>' + (r.withRole.length ? 'Everyone else' : 'Everyone') + ' <span>' + r.rest.length + '</span></h2>' +
      tableHtml(['Name', 'Table', 'Notes'], r.rest, [fullName, where, needs])
  } else {
    for (const t of byTable(guests)) {
      body += '<section class="tbl"><h2>' + esc(t.label) + ' <span>' + t.guests.length + '</span></h2>' +
        tableHtml(['Name', 'Role', 'Notes'], t.guests, [fullName, (g) => g.role || '', needs]) + '</section>'
    }
    const ev = roleFirst(guests.filter((g) => g.list === 'evening'))
    const evening = ev.withRole.concat(ev.rest)
    if (evening.length) {
      body += '<section class="tbl"><h2>Evening only <span>' + evening.length + '</span></h2>' +
        tableHtml(['Name', 'Role', 'Notes'], evening, [fullName, (g) => g.role || '', needs]) + '</section>'
    }
  }
  const title = (eventName || 'Guest list') + ' — ' + (how === 'name' ? 'guests by name' : 'guests by table')
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>' +
    'body{font-family:Georgia,serif;color:#222;margin:24px;font-size:12.5px}' +
    'h1{font-size:20px;margin:0 0 2px}.sub{color:#666;margin:0 0 18px;font-size:12px}' +
    'h2{font-size:14px;margin:18px 0 6px;border-bottom:1.5px solid #222;padding-bottom:3px}h2 span{color:#777;font-weight:normal;font-size:12px}' +
    'table{width:100%;border-collapse:collapse}th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#666;padding:3px 6px}' +
    'td{padding:4px 6px;border-bottom:1px solid #ddd;vertical-align:top}td:first-child{width:38%}' +
    '.tbl{break-inside:avoid}@media print{body{margin:0}}' +
    '</style></head><body><h1>' + esc(eventName || 'Guest list') + '</h1><p class="sub">' +
    esc((eventDate ? eventDate + ' · ' : '') + guests.length + ' guests · printed ' + new Date().toLocaleDateString('en-GB')) +
    '</p>' + body + '<script>window.onload=function(){window.print()}<\/script></body></html>'
}


// Browser actions for the two buttons. Kept beside the builders so the client
// tab and the staff app do exactly the same thing. Return false if the
// browser blocked the print window, so the caller can say so.
export function downloadGuestsCsv(guests, eventName) {
  const blob = new Blob([guestsCsv(guests)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = guestsFileName(eventName, 'csv')
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function printGuests(guests, how, eventName, eventDate) {
  const w = window.open('', '_blank')
  if (!w) return false
  w.document.open()
  w.document.write(guestsPrintHtml(guests, how, eventName, eventDate))
  w.document.close()
  return true
}
