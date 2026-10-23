// tests/guest-export-test.mjs — node tests/guest-export-test.mjs
//
// The guest list's CSV and printed lists. The rule Toby gave for every printed
// list: people with a role on the day at the top, by name, then everyone else
// by name.

import { roleFirst, byTable, guestsCsv, CSV_COLUMNS } from '../src/portal/guestSort.js'

const fails = []
let passes = 0
const check = (name, cond, detail) => cond ? passes++ : fails.push(name + (detail ? ' — ' + detail : ''))

const g = (first, last, o) => Object.assign({ first_name: first, last_name: last, list: 'seated', age_band: 'adult' }, o || {})
const guests = [
  g('Zoe', 'Adams'),
  g('Ben', 'Young', { role: 'Best man', table_label: 'Top table' }),
  g('Amy', 'Clark', { role: 'Bridesmaid', table_label: 'Table 2' }),
  g('Cal', 'Brown', { table_label: 'Table 12' }),
  g('Dee', 'Brown', { table_label: 'Table 2' }),
  g('Eve', 'Moss', { list: 'evening' }),
  g('Al', 'Zed', { role: '   ' }),          // a blank role is no role
  g('Ian', 'Ng', { table_label: 'Table 2', role: 'Usher' }),
]

const r = roleFirst(guests)
check('roles first, by surname', r.withRole.map((x) => x.last_name).join() === 'Clark,Ng,Young', r.withRole.map((x) => x.last_name).join())
check('then everyone else, by surname then first name',
  r.rest.map((x) => x.first_name + ' ' + x.last_name).join() === 'Zoe Adams,Cal Brown,Dee Brown,Eve Moss,Al Zed',
  r.rest.map((x) => x.first_name + ' ' + x.last_name).join())

const t = byTable(guests)
check('tables in number order, unnumbered after, unseated last',
  t.map((x) => x.label).join('|') === 'Table 2|Table 12|Top table|Not seated yet', t.map((x) => x.label).join('|'))
check('within a table, roles first then names',
  t[0].guests.map((x) => x.last_name).join() === 'Clark,Ng,Brown', t[0].guests.map((x) => x.last_name).join())
check('evening-only guests are not on a table list', !t.some((x) => x.guests.some((y) => y.last_name === 'Moss')))

const tricky = [g('=HYPERLINK("x")', 'O\'Brien, "Jnr"', { access_needs: 'line one\nline two', role: '+1' })]
const csv = guestsCsv(tricky)
const lines = csv.replace(/^﻿/, '').split('\r\n')
check('starts with a byte-order mark for Excel', csv.charCodeAt(0) === 0xfeff)
check('header row', lines[0] === CSV_COLUMNS.join(','), lines[0])
check('formula defused and quoted', csv.includes('"\'=HYPERLINK(""x"")"'), lines[1])
check('comma and quotes quoted', csv.includes('"O\'Brien, ""Jnr"""'))
check('a leading + is defused', csv.includes(",'+1,"))
check('newline inside a cell kept inside quotes', csv.includes('"line one\nline two"'))

const plain = guestsCsv(guests).replace(/^﻿/, '').trim().split('\r\n')
check('one row per guest plus the header', plain.length === guests.length + 1, String(plain.length))
check('CSV follows the same order — roles first', plain[1].startsWith('Seated,Amy,Clark,Bridesmaid'), plain[1])
check('evening guests have no table', plain.some((l) => l.startsWith('Evening only,Eve,Moss,,,Adult,,')))

if (fails.length) { console.log(passes + ' passed, FAILED:\n  ' + fails.join('\n  ')); process.exit(1) }
console.log('ALL ' + passes + ' ASSERTIONS PASSED')
