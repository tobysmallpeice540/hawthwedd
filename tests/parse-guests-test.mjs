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

// ── exports from the RSVP sites (25 Oct) ────────────────────────────────────
//
// Couples keep their RSVPs on Bridebook, Hitched, Joy, Zola, Getting Married…
// and bring the list in again as replies arrive. The headings below are the
// shapes those exports take; the merge (wp_merge_guests) relies on rsvp being
// null whenever the list does not say.

import { normaliseRsvp } from '../src/portal/parseGuests.js'

r = parseGuests('﻿First Name,Last Name,RSVP Status,Dietary Requirements,Meal Choice\n' +
  'Ada,Lovelace,Attending,Vegan,Beef\nTom,Thumb,Declined,,\nGrace,Hopper,No response,"Nut allergy, severe",Fish')
eq('BOM header recognised', r.usedHeader, true)
eq('rsvp attending', r.rows[0].rsvp, 'yes')
eq('rsvp declined', r.rows[1].rsvp, 'no')
eq('rsvp no response is null', r.rows[2].rsvp, null)
eq('dietary and meal into notes', r.rows[0].access_needs, 'Vegan · Meal: Beef')
eq('quoted comma in notes', r.rows[2].access_needs, 'Nut allergy, severe · Meal: Fish')
eq('nothing to note is null', r.rows[1].access_needs, null)
eq('columns reported', r.columns, { rsvp: true, notes: true, meals: true, age: false, role: false })

r = parseGuests('Full Name,Wedding Day RSVP,Allergies,Starter,Main\n"Lovelace, Ada",Yes,,Soup,Lamb')
eq('rsvp column found by "rsvp" in the heading', r.rows[0].rsvp, 'yes')
eq('two course columns keep their headings', r.rows[0].access_needs, 'Starter: Soup · Main: Lamb')
eq('full name surname-first', [r.rows[0].first_name, r.rows[0].last_name], ['Ada', 'Lovelace'])

r = parseGuests('Guest list for Sam & Alex\n\nFirst name;Surname;Child;Role\nAmy;Pond;yes;Flower girl\nRory;Williams;;Best man')
eq('heading found below a title line', r.usedHeader, true)
eq('semicolon file', r.rows.length, 2)
eq('child flag column', [r.rows[0].age_band, r.rows[1].age_band], ['child', 'adult'])
eq('age given flagged', r.rows[0].age_given, true)
eq('role read', r.rows[1].role, 'Best man')

r = parseGuests('First Name,Last Name,Notes\nAda,Lovelace,"Wheelchair user,\nneeds step-free route"\nGrace,Hopper,')
eq('a note running over a line break stays one guest', r.rows.length, 2)
eq('the broken note joined', r.rows[0].access_needs, 'Wheelchair user, needs step-free route')

r = parseGuests('First Name,Last Name,RSVP\nSam,Jones,Yes\nGuest of,Sam Jones,\n+1,,\nPlus one,,')
eq('placeholder plus-ones skipped', r.rows.length, 1)
eq('and counted as skipped', r.skipped, 3)

r = parseGuests('First Name,Last Name\nAda,Lovelace')
eq('no rsvp column → rsvp null', r.rows[0].rsvp, null)
eq('no age column → age not given', r.rows[0].age_given, false)

eq('rsvp words', ['Accepted', 'Regrets', 'Maybe', 'awaiting reply', 'Not attending', 'joyfully accepts', 'N', '', 'Invited'].map(normaliseRsvp),
   ['yes', 'no', 'maybe', null, 'no', 'yes', 'no', null, null])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
