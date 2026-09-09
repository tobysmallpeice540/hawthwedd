// tests/guest-sort-test.mjs — node tests/guest-sort-test.mjs
//
// The seated list can be sorted by table, by name, or by where somebody is
// staying. Only the first is interesting, and it is interesting for one reason:
// "Table 12" sorts BEFORE "Table 2" as text. With up to twenty-five tables that
// is not a nicety — the list reads as scrambled and the couple stops trusting it.

import { sortGuests, tableRank, stayingRank, accomOptions, ACCOM_LABEL } from '../src/portal/guestSort.js'

const fails = []
let passes = 0
const check = (name, cond, detail) => cond ? passes++ : fails.push(name + (detail ? ' — ' + detail : ''))

// staying defaults to true when a place is given, because that is the only
// combination the database allows: nobody is not-staying somewhere.
const g = (last, table, where, staying) => ({
  first_name: 'A', last_name: last,
  table_label: table || null, staying_where: where || null,
  staying: staying === undefined ? !!where : staying,
})

// ── by table ────────────────────────────────────────────────────────────────
const mixed = [g('Smith','Table 12'), g('Adams','Table 2'), g('Boyd', null), g('Cole','Table 1')]
const byTable = sortGuests(mixed, 'table').map((x) => x.table_label)
check('numeric table order, not alphabetical',
  JSON.stringify(byTable) === JSON.stringify(['Table 1','Table 2','Table 12',null]),
  byTable.join(' | '))

check('the unseated go last', sortGuests(mixed, 'table').at(-1).last_name === 'Boyd')

// A table somebody renamed still sorts somewhere sensible rather than throwing.
const named = sortGuests([g('X','Top table'), g('Y','Table 3')], 'table').map((x) => x.table_label)
check('an unnumbered table sorts after the numbered ones',
  JSON.stringify(named) === JSON.stringify(['Table 3','Top table']), named.join(' | '))

// ── name is always the tie-break ────────────────────────────────────────────
const sameTable = sortGuests([g('Young','Table 4'), g('Ash','Table 4')], 'table').map((x) => x.last_name)
check('same table, sorted by name', JSON.stringify(sameTable) === JSON.stringify(['Ash','Young']))

const sameWhere = sortGuests([g('Young',null,'hamlet'), g('Ash',null,'hamlet')], 'where').map((x) => x.last_name)
check('same accommodation, sorted by name', JSON.stringify(sameWhere) === JSON.stringify(['Ash','Young']))

// ── by where they are staying ───────────────────────────────────────────────
const stays = sortGuests(
  [g('D',null,null), g('C',null,'camping'), g('A',null,'amly'), g('B',null,'hamlet')], 'where')
  .map((x) => x.staying_where)
check('grouped by accommodation, nobody-staying last',
  JSON.stringify(stays) === JSON.stringify(['amly','hamlet','camping',null]), stays.join(' | '))

// THE ONE THAT WAS WRONG. Somebody staying with nowhere decided yet is not the
// same as somebody going home, even though both have a null staying_where.
// They belong after the placed guests and BEFORE everyone not staying, because
// they are the only people this sort is actually useful for — they are the ones
// who still need a bed finding.
const mixed2 = sortGuests([
  g('Home',   null, null,      false),   // not staying
  g('Undecided', null, null,   true),    // staying, nowhere yet
  g('Hamlet', null, 'hamlet'),           // placed
], 'where').map((x) => x.last_name)
check('staying-but-unplaced sits between placed and not-staying',
  JSON.stringify(mixed2) === JSON.stringify(['Hamlet','Undecided','Home']), mixed2.join(' | '))

check('a placed guest ranks by property', stayingRank(g('X',null,'amly')) === 0 &&
  stayingRank(g('X',null,'hamlet')) === 1 && stayingRank(g('X',null,'camping')) === 2)
check('staying with nowhere decided ranks after all three properties',
  stayingRank(g('X',null,null,true)) === 3)
check('not staying ranks last', stayingRank(g('X',null,null,false)) === 9)
// A row that somehow holds a place it should not still counts as staying
// rather than being thrown to the bottom.
check('an unknown place ranks with the undecided',
  stayingRank({ staying: true, staying_where: 'treehouse' }) === 3)
check('stayingRank survives a missing guest', stayingRank(undefined) === 9)

// ── it never mutates what it was given ──────────────────────────────────────
const original = [g('Z','Table 9'), g('A','Table 1')]
const before = original.map((x) => x.last_name).join(',')
sortGuests(original, 'table')
check('sorting does not reorder the caller’s array',
  original.map((x) => x.last_name).join(',') === before)

// ── the things that must not throw ──────────────────────────────────────────
check('an empty list is fine', sortGuests([], 'table').length === 0)
check('a missing list is fine', sortGuests(undefined, 'table').length === 0)
check('an unknown sort leaves the order alone',
  sortGuests(original, 'nonsense').map((x) => x.last_name).join(',') === before)
check('tableRank survives a missing guest', Number.isFinite(tableRank(undefined)))

// ── only booked or held accommodation is offered ────────────────────────────
check('a declined accommodation is not offered',
  JSON.stringify(accomOptions({ amly:'yes', hamlet:'no', camping:'hold' })) ===
  JSON.stringify(['amly','camping']))
check('undecided is not offered',
  accomOptions({ amly:'undecided', hamlet:'undecided', camping:'undecided' }).length === 0)
check('nothing booked offers nothing', accomOptions(undefined).length === 0)
check('every key has a word for it',
  Object.keys(ACCOM_LABEL).every((k) => typeof ACCOM_LABEL[k] === 'string' && ACCOM_LABEL[k].length))

if (fails.length === 0) console.log('ALL ' + passes + ' ASSERTIONS PASSED')
else { console.log(passes + ' passed, ' + fails.length + ' FAILED:'); fails.forEach((f) => console.log('  ' + f)); process.exit(1) }
