// Assertions for the guest-list parser. Pure logic, no browser, no database.
//   node tests/parse-guests-test.mjs
import { parseGuests } from '../src/portal/parseGuests.js'

let pass = 0, fail = 0
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++ } else { fail++; console.log(`FAIL ${label}\n  got  ${g}\n  want ${w}`) }
}

// a column pasted out of a spreadsheet
let r = parseGuests('Ada Lovelace\nGrace Hopper\nAlan Turing')
eq('plain lines count', r.rows.length, 3)
eq('plain lines split', r.rows[0], { first_name: 'Ada', last_name: 'Lovelace', side: null, age_band: 'adult', access_needs: null })

// double-barrelled surnames keep their given names together
r = parseGuests('Mary Anne Evans')
eq('multi-part given name', r.rows[0].first_name, 'Mary Anne')
eq('multi-part surname', r.rows[0].last_name, 'Evans')

// one name only
r = parseGuests('Cher')
eq('mononym', r.rows[0], { first_name: 'Cher', last_name: '', side: null, age_band: 'adult', access_needs: null })

// a real CSV export with a header
r = parseGuests('First Name,Last Name,Side,Age\nAda,Lovelace,Bride,adult\nTom,Thumb,Groom,child')
eq('header detected', r.usedHeader, true)
eq('header rows', r.rows.length, 2)
eq('header side', r.rows[0].side, 'Bride')
eq('age normalised', r.rows[1].age_band, 'child')

// tabs, as pasted from Excel
r = parseGuests('Ada\tLovelace\nGrace\tHopper')
eq('tab separated', r.rows[1], { first_name: 'Grace', last_name: 'Hopper', side: null, age_band: 'adult', access_needs: null })

// quoted "Last, First" in a single Name column
r = parseGuests('Name,Side\n"Lovelace, Ada",Bride')
eq('quoted surname-first first', r.rows[0].first_name, 'Ada')
eq('quoted surname-first last', r.rows[0].last_name, 'Lovelace')

// blank lines and empty rows are skipped, not saved as nameless guests
r = parseGuests('Ada Lovelace\n\n   \nGrace Hopper')
eq('blank lines dropped', r.rows.length, 2)
eq('nothing silently skipped', r.skipped, 0)

// a guest genuinely called "Name" must not be eaten as a header
r = parseGuests('Name Smith\nAda Lovelace')
eq('single column never treated as header', r.rows.length, 2)
eq('first row kept', r.rows[0].first_name, 'Name')

// age words that are not adult/child/baby fall back to adult
r = parseGuests('First Name,Last Name,Age\nAda,Lovelace,grown-up')
eq('unknown age falls back', r.rows[0].age_band, 'adult')

// empty input
r = parseGuests('')
eq('empty input', r.rows.length, 0)

// ── numbered lists ──────────────────────────────────────────────────────────
//
// Added after a real wedding's list arrived as "1. Olivia Bennett",
// "2. James Carter" and so on, sixty names deep, because somebody pasted a
// numbered list and the parser kept the numbers as part of the name. Every one
// of those had to be corrected by hand.
//
// The stripping is deliberately narrow — number, dot or bracket, WHITESPACE —
// so it cannot eat a CSV id column or a name that merely starts with a digit.

r = parseGuests('1. Olivia Bennett\n2. James Carter')
eq('numbered list loses its numbers',
   r.rows.map((x) => x.first_name + ' ' + x.last_name), ['Olivia Bennett', 'James Carter'])

r = parseGuests('1) Ava Mitchell')
eq('brackets count as numbering', r.rows[0].last_name, 'Mitchell')

r = parseGuests('  12 . Noah Wilson')
eq('spaces around the number are fine', r.rows[0].first_name, 'Noah')

// The three that stop it going too far.
r = parseGuests('1,Olivia,Bennett')
eq('a CSV id column is not stripped', r.rows[0].first_name, '1')

r = parseGuests('3M Someone')
eq('a name starting with a digit survives', r.rows[0].first_name, '3M')

r = parseGuests('1.Olivia Bennett')
eq('no space after the dot is not a list', r.rows[0].first_name, '1.Olivia')

r = parseGuests('first name,last name\n1. Ada,Lovelace')
eq('numbering does not confuse a header row', r.rows[0].first_name, 'Ada')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
