// Turning whatever a couple pastes into rows.
//
// Real guest lists arrive as a column copied out of a spreadsheet, or a CSV
// exported from Joy or The Knot, and both are messy. A strict parser refuses
// and the couple gives up; this one forgives and shows what it found before
// anything is saved.
//
// Handles: comma, tab or semicolon separated; an optional header row it
// recognises by name; quoted fields; "Last, First" in a single column; and a
// plain list of "Firstname Lastname" lines.

const HEADER_ALIASES = {
  first_name: ['first name', 'firstname', 'first', 'forename', 'given name', 'name'],
  last_name:  ['last name', 'lastname', 'last', 'surname', 'family name'],
  side:       ['side', 'group', 'party', 'table', 'guest of'],
  age_band:   ['age', 'age band', 'age group', 'type', 'adult/child'],
  access_needs: ['access', 'access needs', 'accessibility', 'notes', 'requirements'],
}

function splitLine(line) {
  // Respect double quotes so "Smith, John" stays one field.
  const out = []
  let cur = '', quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') { quoted = !quoted; continue }
    if (!quoted && (c === ',' || c === '\t' || c === ';')) { out.push(cur); cur = ''; continue }
    cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

function normaliseAge(v) {
  const s = String(v || '').trim().toLowerCase()
  if (['child', 'children', 'kid', 'c'].includes(s)) return 'child'
  if (['baby', 'babies', 'infant', 'b'].includes(s)) return 'baby'
  return 'adult'
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
  const lower = cells.map((c) => c.toLowerCase().trim())
  const map = {}
  let hits = 0
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const i = lower.findIndex((c) => aliases.includes(c))
    if (i !== -1) { map[field] = i; hits++ }
  }
  // "name" alone counts as a header only alongside another recognised column,
  // or a guest genuinely called "Name" would eat the first row.
  return hits >= 1 && (map.first_name !== undefined || map.last_name !== undefined)
    ? { map, hits } : null
}

export function parseGuests(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  if (!lines.length) return { rows: [], skipped: 0, usedHeader: false }

  const first = splitLine(lines[0])
  const header = first.length > 1 ? matchHeader(first) : null
  const body = header ? lines.slice(1) : lines
  const rows = []
  let skipped = 0

  for (const line of body) {
    const cells = splitLine(line)
    let row

    if (header) {
      const g = (f) => (header.map[f] !== undefined ? cells[header.map[f]] || '' : '')
      const hasSeparateNames = header.map.last_name !== undefined
      row = hasSeparateNames
        ? { first_name: g('first_name'), last_name: g('last_name') }
        : splitWholeName(g('first_name'))
      row.side = g('side') || null
      row.age_band = header.map.age_band !== undefined ? normaliseAge(g('age_band')) : 'adult'
      row.access_needs = g('access_needs') || null
    } else if (cells.length > 1) {
      // No header: assume first, last, then side if a third column exists.
      row = { first_name: cells[0], last_name: cells[1], side: cells[2] || null, age_band: 'adult', access_needs: null }
    } else {
      row = { ...splitWholeName(cells[0]), side: null, age_band: 'adult', access_needs: null }
    }

    if (!(row.first_name || row.last_name)) { skipped++; continue }
    rows.push(row)
  }

  return { rows, skipped, usedHeader: !!header }
}
