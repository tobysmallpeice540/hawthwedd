// tests/table-snap-test.mjs — node tests/table-snap-test.mjs
//
// The bug these are written against: a trestle is 1830mm long and the plan
// snapped to a 250mm grid. 1830 / 250 = 7.32, so two tables could never sit
// exactly one table-length apart. The nearest grid positions gave an 80mm
// overlap — refused — or a 170mm gap. Making one long table out of two was
// impossible and nothing on screen said why.

import { tableRect, snapToNeighbours, boxesOverlap, tableFootprint, SNAP_MM } from '../src/shared/tableSnap.js'

const fails = []
let passes = 0
const check = (name, cond, detail) => cond ? passes++ : fails.push(name + (detail ? ' — ' + detail : ''))

const size = { L: 1830, D: 760, chair: 450, clear: 150 }
const t = (id, x, y, rotation = 0) => ({ id, x_mm: x, y_mm: y, rotation })

// ── the arithmetic that caused it, stated so it cannot come back ────────────
check('a table length is not a whole number of 250mm grid steps', 1830 % 250 !== 0)

// ── end to end, which is the thing he asked for ────────────────────────────
const anchor = t('a', 5000, 5000)
// Dragged to roughly one table-length away, but off by 60mm — a normal drag.
const rough = { x: 5000 + 1830 + 60, y: 5040 }
const snapped = snapToNeighbours(rough, t('b', 0, 0), [anchor], size)

check('an end lands flush against the other table', snapped.x === 5000 + 1830, 'got ' + snapped.x)
check('and the row lines up on the other axis', snapped.y === 5000, 'got ' + snapped.y)

const A = tableRect(anchor, size)
const B = tableRect({ ...t('b', 0, 0), x_mm: snapped.x, y_mm: snapped.y }, size)
check('flush tables do not count as overlapping', !boxesOverlap(A, B))
check('they really are touching, not merely near', A.x + A.w === B.x, A.x + A.w + ' vs ' + B.x)

// ── a millimetre of rounding must not turn a join into a refusal ───────────
check('a 1mm overlap is still treated as touching',
  !boxesOverlap(A, { ...B, x: B.x - 1 }))
check('a real overlap is still refused',
  boxesOverlap(A, { ...B, x: B.x - 400 }))

// ── but it must not drag distant tables together ───────────────────────────
const farAway = { x: 5000 + 1830 + 900, y: 5000 + 1900 }
const notSnapped = snapToNeighbours(farAway, t('c', 0, 0), [anchor], size)
check('a table deliberately placed well clear stays where it was put',
  notSnapped.x === farAway.x && notSnapped.y === farAway.y,
  JSON.stringify(notSnapped))

// ── AND IT MUST NOT SNAP SOMEWHERE THE PLAN WILL THEN REFUSE ───────────────
//
// Two trestles pushed long-side to long-side are flush on screen and useless in
// the room: the six chairs along the join have nowhere to go. Without the
// allowed-check the table jumps together and the couple is told immediately
// that they are too close for anybody to get up, which reads as the plan
// arguing with itself.
const allowed = (x, y) => {
  const mine = tableFootprint({ ...t('side', x, y) }, size)
  return !boxesOverlap(mine, tableFootprint(anchor, size))
}
// Dragged to just below the anchor — long sides nearly touching.
const sideBySide = snapToNeighbours({ x: 5000, y: 5000 + 900 }, t('side', 0, 0), [anchor], size,
  { isAllowed: allowed })
check('long sides are not snapped together, because the chairs would not fit',
  sideBySide.y === 5000 + 900, 'got ' + sideBySide.y)

// End to end is still offered, because it is allowed.
const endToEnd = snapToNeighbours({ x: 5000 + 1830 + 60, y: 5000 }, t('end', 0, 0), [anchor], size,
  { isAllowed: allowed })
check('end to end still goes flush with the same rule in force',
  endToEnd.x === 5000 + 1830, 'got ' + endToEnd.x)

check('the tolerance is what it says it is', SNAP_MM === 200)
// Just outside tolerance stays put; just inside goes flush.
const edgeX = 5000 + 1830
check('just outside the tolerance is left alone',
  snapToNeighbours({ x: edgeX + SNAP_MM + 1, y: 9999 }, t('d',0,0), [anchor], size).x === edgeX + SNAP_MM + 1)
check('just inside the tolerance goes flush',
  snapToNeighbours({ x: edgeX + SNAP_MM - 1, y: 9999 }, t('d',0,0), [anchor], size).x === edgeX)

// ── the footprint still pads the chaired sides only ────────────────────────
const both = tableFootprint(t('x', 5000, 5000), size)
const oneSide = tableFootprint({ ...t('y', 5000, 5000), one_side: true }, size)
check('a two-sided table is padded on both long sides',
  both.h === size.D + 2 * (size.chair + size.clear), 'got ' + both.h)
check('one side only is padded on one, so it can go against a wall',
  oneSide.h === size.D + (size.chair + size.clear), 'got ' + oneSide.h)

// ── rotation ────────────────────────────────────────────────────────────────
const upright = t('e', 5000, 5000, 90)
const r = tableRect(upright, size)
check('a rotated table is deep where it was long', r.w === size.D && r.h === size.L)
const belowIt = snapToNeighbours({ x: 5030, y: 5000 + 1830 + 70 }, t('f', 0, 0, 90), [upright], size, {})
check('two rotated tables join end to end as well', belowIt.y === 5000 + 1830, 'got ' + belowIt.y)

// ── the axes are independent ───────────────────────────────────────────────
// Going flush along one axis must not yank the table sideways on the other.
const onlyX = snapToNeighbours({ x: edgeX + 20, y: 5000 + 4000 }, t('g',0,0), [anchor], size)
check('a far-off other axis is left alone', onlyX.x === edgeX && onlyX.y === 5000 + 4000)

// ── and the things that must not throw ─────────────────────────────────────
check('no neighbours means no change',
  JSON.stringify(snapToNeighbours({ x: 1, y: 2 }, t('h',0,0), [], size)) === JSON.stringify({ x: 1, y: 2 }))
check('a missing list is fine',
  snapToNeighbours({ x: 1, y: 2 }, t('h',0,0), undefined, size).x === 1)
check('a table never snaps to itself',
  snapToNeighbours({ x: 5010, y: 5010 }, anchor, [anchor], size).x === 5010)

if (fails.length === 0) console.log('ALL ' + passes + ' ASSERTIONS PASSED')
else { console.log(passes + ' passed, ' + fails.length + ' FAILED:'); fails.forEach((f) => console.log('  ' + f)); process.exit(1) }
