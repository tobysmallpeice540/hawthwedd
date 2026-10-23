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
