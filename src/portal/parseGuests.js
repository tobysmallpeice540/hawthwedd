// Turning whatever a couple pastes into rows.
//
// Real guest lists arrive as a column copied out of a spreadsheet, or a CSV
// exported from Joy or The Knot, and both are messy. A strict parser refuses
// and the couple gives up; this one forgives and shows what it found before
// anything is saved.
//
// Handles: comma, tab or semicolon separated; an optional header row it
// recognises by name (looked for in the first few lines); quoted fields,
// including ones that run over a line break; "Last, First" in a single column;
// and a plain list of "Firstname Lastname" lines. With headings it also reads
// the RSVP, dietary/notes, meal-choice, age and role columns that the RSVP
// sites export, so a list kept on Bridebook, Hitched, Joy or Zola can be
// brought in again and again — wp_merge_guests updates the people already on
// the list instead of adding them twice.

// Headings as the RSVP sites write them — Bridebook, Hitched, Joy, Zola,
// Say I Do, Getting Married, The Knot — and as people write them by hand.
// Compared after normalising (lower case, no BOM, no stray punctuation).
const HEADER_ALIASES = {
  first_name: ['first name', 'firstname', 'first', 'forename', 'forenames', 'given name', 'given names',
               'first names', 'guest first name', 'name', 'full name', 'guest name', 'guest', 'name(s)'],
  last_name:  ['last name', 'lastname', 'last', 'surname', 'surnames', 'family name', 'last names', 'guest last name'],
  side:       ['side', 'group', 'party', 'table', 'guest of', 'category'],
  age_band:   ['age', 'age band', 'age group', 'type', 'adult/child', 'guest type', 'adult or child'],
  child_flag: ['child', 'children', 'is child', 'kid', 'under 12', 'child?'],
  rsvp:       ['rsvp', 'rsvp status', 'status', 'attending', 'attendance', 'response', 'reply', 'coming',
               'will attend', 'will you attend', 'attending?', 'rsvp response'],
  role:       ['role', 'wedding party', 'wedding party role', 'bridal party'],
}
// Every one of these columns is kept, joined into the guest's notes — a list
// can carry dietary needs AND allergies AND a free notes column.
const NOTE_ALIASES = ['access', 'access needs', 'accessibility', 'notes', 'note', 'requirements',
  'dietary', 'diet', 'dietary requirements', 'dietary requirement', 'dietary restrictions', 'dietary needs',
  'dietary info', 'dietary information', 'allergies', 'allergy', 'allergies/dietary', 'dietary/allergies',
  'special requirements', 'special requests', 'additional requirements', 'comments']
// Meal choices go into the notes too, under their own heading ("Main: Beef"),
// so the kitchen sees them beside the dietary needs.
const MEAL_ALIASES = ['meal', 'meal choice', 'meal selection', 'menu', 'menu choice', 'food choice', 'food',
  'starter', 'main', 'main course', 'mains', 'dessert', 'pudding', 'entree', 'entrée', 'course']

function splitLine(line, delim) {
  // Respect double quotes so "Smith, John" stays one field; "" inside quotes
  // is a literal quote. With no delimiter given, any of , tab ; separates —
  // the behaviour for pasted lists without headings.
  const isSep = delim ? (c) => c === delim : (c) => c === ',' || c === '\t' || c === ';'
  const out = []
  let cur = '', quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; continue }
      quoted = !quoted; continue
    }
    if (!quoted && isSep(c)) { out.push(cur); cur = ''; continue }
    cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

// Lines, but a quoted field may run over a line break (a notes column often
// does in an export) — those are joined back into one record.
function logicalLines(text) {
  const raw = String(text || '').split(/\r?\n/)
  const out = []
  let pending = null
  for (const l of raw) {
    const line = pending === null ? l : pending + ' ' + l
    const quotes = (line.match(/"/g) || []).length
    if (quotes % 2 === 1) { pending = line; continue }
    pending = null
    out.push(line)
  }
  if (pending !== null) out.push(pending)
  return out
}

function detectDelim(line) {
  if (line.includes('\t')) return '\t'
  const commas = (line.match(/,/g) || []).length, semis = (line.match(/;/g) || []).length
  return semis > commas ? ';' : ','
}

function normHeading(c) {
  return String(c || '').replace(/^﻿/, '').toLowerCase().replace(/[*:]/g, '').replace(/\s+/g, ' ').trim()
}

// "Attending", "Accepted", "Declined", "No response"… → yes / no / maybe / null.
// Null is "not heard", and never overwrites anything.
export function normaliseRsvp(v) {
  const s = String(v || '').toLowerCase().replace(/\s+/g, ' ').trim()
  if (!s) return null
  if (/^(no response|no reply|awaiting|pending|not responded|unanswered|invited|not sent|sent\b|-)/.test(s)) return null
  if (/^(no\b|n$|declin|regret|not attending|not coming|not going|can't|cannot|unable|won't|will not|absent)/.test(s)) return 'no'
  if (/^(maybe|tentative|unsure|possibly|not sure|tbc)/.test(s)) return 'maybe'
  if (/^(yes|y$|attending|accept|going|coming|confirmed|will attend|attend|joyfully)/.test(s)) return 'yes'
  return null
}

function truthy(v) {
  return /^(yes|y|true|1|x|✓|child)$/i.test(String(v || '').trim())
}

function normaliseAge(v) {
  const s = String(v || '').trim().toLowerCase()
  if (['child', 'children', 'kid', 'c'].includes(s)) return 'child'
  if (['baby', 'babies', 'infant', 'b'].includes(s)) return 'baby'
  return 'adult'
}

// Only a cell that plainly says what someone is may CHANGE a guest already on
// the list. A blank, "Guest", "8" or "Toddler" must not turn a child into an
// adult on re-import — so anything unrecognised is null, and the merge leaves
// the stored age alone. ("Child (2-12)" and "Adults" are recognised.)
export function explicitAge(v) {
  const s = String(v || '').trim().toLowerCase()
  if (/^(adult|adults|grown[- ]?up|a)\b/.test(s)) return 'adult'
  if (/^(child|children|kid|kids|c)\b/.test(s)) return 'child'
  if (/^(baby|babies|infant|b)\b/.test(s)) return 'baby'
  return null
}
function explicitChildFlag(v) {
  const s = String(v || '').trim().toLowerCase()
  if (/^(yes|y|true|1|x|✓|child)$/.test(s)) return 'child'
  if (/^(no|n|false|0|adult)$/.test(s)) return 'adult'
  return null
}

// One field holding a whole name. "Smith, John" is surname first; anything else
// is treated as given names then surname.
function splitWholeName(v) {
  const s = String(v || '').trim().replace(/\s+/g, ' ')
  if (!s) return { first_name: '', last_name: '' }
  if (s.includes(',')) {
    const [last, first] = s.split(',').map((x) => x.trim())
    return { first_name: first || '', last_name: last || '' }
  }
  const bits = s.split(' ')
  if (bits.length === 1) return { first_name: bits[0], last_name: '' }
  return { first_name: bits.slice(0, -1).join(' '), last_name: bits[bits.length - 1] }
}

function matchHeader(cells) {
  const lower = cells.map(normHeading)
  const map = {}
  let hits = 0
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    // The alias order is a preference: with both "Type" and "Age" columns,
    // "Age" is the age; with "Name" and "First name", "First name" wins.
    let i = -1
    for (const al of aliases) { const k = lower.indexOf(al); if (k !== -1 && !Object.values(map).includes(k)) { i = k; break } }
    // "Ceremony RSVP", "Day RSVP", "Wedding day - attending"…
    if (i === -1 && field === 'rsvp') i = lower.findIndex((c) => /\brsvp\b|attending/.test(c))
    if (i !== -1) { map[field] = i; hits++ }
  }
  const taken = new Set(Object.values(map))
  const notes = [], meals = []
  lower.forEach((c, i) => {
    if (taken.has(i)) return
    if (NOTE_ALIASES.includes(c) || /dietary|allerg/.test(c)) notes.push(i)
    else if (MEAL_ALIASES.includes(c) || /\bmeal\b|menu choice/.test(c)) meals.push(i)
  })
  map.notes = notes; map.meals = meals
  // A heading row needs a name column. "name" alone counts only alongside
  // another column, or a guest genuinely called "Name" would eat the first row.
  return hits >= 1 && (map.first_name !== undefined || map.last_name !== undefined)
    ? { map, hits, headings: cells } : null
}

// A pasted list is very often a NUMBERED list — straight out of a document, an
// email, or a note on a phone — and without this the numbers become part of the
// name. A real wedding ended up with "1. Olivia Bennett" and "2. James Carter"
// sixty times over, and every one of those has to be fixed by hand.
//
// Deliberately narrow: a number, then a dot or a bracket, then WHITESPACE. That
// is what a list looks like. It leaves "1,Olivia,Bennett" alone, because a
// comma there is a CSV column and the 1 is somebody's id, and it leaves names
// like "3M" or an address alone too. Up to three digits — nobody numbers a
// guest list past 999, and a longer run of digits is more likely to be data.
function stripListNumber(line) {
  return line.replace(/^\s*\d{1,3}\s*[.)]\s+/, '')
}

export function parseGuests(text) {
  const lines = logicalLines(text)
    .map((l) => stripListNumber(l.trim()))
    .filter((l) => l.replace(/[,;\t"\s]/g, '') !== '')

  if (!lines.length) return { rows: [], skipped: 0, usedHeader: false, columns: null }

  // The heading row is usually first, but an export can open with a title line
  // or two ("Guest list — Sam & Alex"). Look a few lines down for it.
  let header = null, start = 0, delim = null
  for (let k = 0; k < Math.min(5, lines.length) && !header; k++) {
    const d = detectDelim(lines[k])
    const cells = splitLine(lines[k], d)
    if (cells.length > 1) {
      header = matchHeader(cells)
      if (header) { start = k + 1; delim = d }
    }
  }
  const body = header ? lines.slice(start) : lines
  const rows = []
  let skipped = 0

  for (const line of body) {
    const cells = splitLine(line, delim)
    let row

    if (header) {
      const m = header.map
      const g = (f) => (m[f] !== undefined ? cells[m[f]] || '' : '')
      const hasSeparateNames = m.last_name !== undefined && m.first_name !== undefined
      row = hasSeparateNames
        ? { first_name: g('first_name'), last_name: g('last_name') }
        : m.first_name !== undefined ? splitWholeName(g('first_name')) : splitWholeName(g('last_name'))
      row.side = g('side') || null
      row.age_band = m.age_band !== undefined ? normaliseAge(g('age_band'))
        : m.child_flag !== undefined ? (truthy(g('child_flag')) ? 'child' : 'adult') : 'adult'
      const notes = m.notes.map((i) => cells[i] || '').filter((v) => v && !/^(none|n\/a|na|no|-|nil)$/i.test(v))
      const meals = m.meals.map((i) => {
        if (!cells[i]) return ''
        const h = String(header.headings[i] || '').replace(/^﻿/, '').trim()
        return (m.meals.length > 1 ? h : 'Meal') + ': ' + cells[i]
      }).filter(Boolean)
      row.access_needs = [...notes, ...meals].join(' · ').slice(0, 300) || null
      // The same, one value per column, for the merge: it adds each value only
      // if it is not there already, and a meal choice ("Main: Beef") replaces
      // the one under the same heading ("Main: Lamb") rather than piling up.
      row.notes_parts = notes.map((v) => ({ text: v.slice(0, 300) }))
        .concat(meals.map((v) => ({ text: v.slice(0, 300), heading: v.slice(0, v.indexOf(':')) })))
      // Only what the list actually says: no RSVP column, no change to RSVPs.
      row.rsvp = m.rsvp !== undefined ? normaliseRsvp(g('rsvp')) : null
      row.role = g('role') || null
      // True only when this row's cell plainly says adult, child or baby.
      const said = m.age_band !== undefined ? explicitAge(g('age_band'))
        : m.child_flag !== undefined ? explicitChildFlag(g('child_flag')) : null
      row.age_given = said !== null
      if (said) row.age_band = said
    } else if (cells.length > 1) {
      // No header: assume first, last, then side if a third column exists.
      row = { first_name: cells[0], last_name: cells[1], side: cells[2] || null, age_band: 'adult', access_needs: null }
    } else {
      row = { ...splitWholeName(cells[0]), side: null, age_band: 'adult', access_needs: null }
    }

    if (!(row.first_name || row.last_name)) { skipped++; continue }
    // "Guest of Sam", "+1", "Plus one" — a placeholder, not a person yet.
    if (/^(\+ ?1\b|plus ?one\b|guest of\b|guest$|tbc$)/i.test((row.first_name + ' ' + row.last_name).trim())) { skipped++; continue }
    rows.push(row)
  }

  return {
    rows, skipped, usedHeader: !!header,
    columns: header ? {
      rsvp: header.map.rsvp !== undefined, notes: header.map.notes.length > 0, meals: header.map.meals.length > 0,
      age: header.map.age_band !== undefined || header.map.child_flag !== undefined, role: header.map.role !== undefined,
    } : null,
  }
}
