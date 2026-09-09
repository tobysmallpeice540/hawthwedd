// tests/day-order-test.mjs — node tests/day-order-test.mjs
//
// A wedding does not end at midnight. Music ends at 00:00 and the site closes
// at 00:30, and both belong at the BOTTOM of Saturday's list — which is not
// where they land the moment anything sorts "00:30" against "14:00".
//
// This is the same wrap-around that bit the curfew query in SQL, where
// `time + interval '24 hours'` quietly returns 00:30 again. It was fixed there
// with a minutes-past-midnight key; these are the assertions for the front-end
// half of it, which both apps now share.

import { dayOrder, DAY_ENDS_AT_MIN } from '../src/shared/dayOrder.js'

const fails = []
let passes = 0
const check = (name, cond, detail) => cond ? passes++ : fails.push(name + (detail ? ' — ' + detail : ''))

// ── the actual wedding day, in order ────────────────────────────────────────
const day = ['00:30', '23:45', '14:00', '00:00', '09:00', '19:30']
const sorted = day.slice().sort((a, b) => dayOrder(a) - dayOrder(b))
check('a real wedding day sorts in the order it happens',
  JSON.stringify(sorted) === JSON.stringify(['09:00','14:00','19:30','23:45','00:00','00:30']),
  sorted.join(' → '))

// The three that were wrong before, stated plainly.
check('midnight comes after the bar closing at 23:45', dayOrder('00:00') > dayOrder('23:45'))
check('site closed at 00:30 is last of all', dayOrder('00:30') > dayOrder('00:00'))
check('carriages at midnight beat first dance at 21:00', dayOrder('00:00') > dayOrder('21:00'))

// ── the cutover ─────────────────────────────────────────────────────────────
// Two o'clock is a judgement, not a fact: after the site closes at 00:30
// nothing legitimately happens until daybreak, so anything earlier is still
// last night. A supplier arriving at 06:00 is a genuine early start.
check('01:59 is still the night before', dayOrder('01:59') > dayOrder('23:00'))
check('02:00 is the next morning', dayOrder('02:00') < dayOrder('23:00'))
check('a 6am supplier sorts first', dayOrder('06:00') < dayOrder('09:00'))
check('the cutover is where it says it is', DAY_ENDS_AT_MIN === 120)

// ── shapes it will actually be handed ───────────────────────────────────────
check('seconds are tolerated', dayOrder('00:30:00') === dayOrder('00:30'))
check('a single-digit hour works', dayOrder('9:00') === dayOrder('09:00'))
check('midday is midday', dayOrder('12:00') === 12 * 60)

// ── and the ones that must not throw ────────────────────────────────────────
// '25:99' is the one worth naming: it matches the shape of a time and the
// arithmetic gives 1599, a number that looks perfectly ordinary and would sit a
// nonsense row in the middle of the afternoon where nobody would question it.
for (const bad of [null, undefined, '', 'later', '25:99', '12:70', '99:00', '25:99:xx', {}]) {
  check('a missing or unreadable time sorts last (' + JSON.stringify(bad) + ')',
    dayOrder(bad) === Number.MAX_SAFE_INTEGER)
}

// Nothing real can outrank the fallback, or an unreadable time would wander
// into the middle of the day instead of sitting at the end.
check('no real time outranks the fallback',
  ['00:00','23:59','02:00','01:59'].every((t) => dayOrder(t) < Number.MAX_SAFE_INTEGER))

if (fails.length === 0) console.log('ALL ' + passes + ' ASSERTIONS PASSED')
else { console.log(passes + ' passed, ' + fails.length + ' FAILED:'); fails.forEach((f) => console.log('  ' + f)); process.exit(1) }
