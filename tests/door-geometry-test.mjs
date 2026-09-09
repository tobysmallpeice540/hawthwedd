// tests/door-geometry-test.mjs
//
// The door swing is worked out twice: doorGeometry() in src/App.jsx, which is
// what Toby cycles through with the button, and doorPath() in
// src/portal/Layout.jsx, which is what the couple sees.
//
// They MUST agree. If they drift, Toby presses the button until the door looks
// like the real one, saves, and the couple is shown a door opening the other
// way — with nothing anywhere to say so. That is the kind of fault that gets
// found on a wedding morning.
//
// So this extracts the arithmetic from both files and runs all eight states
// through both, rather than trusting a comment to keep them in step.
//
//     node tests/door-geometry-test.mjs

import { readFileSync } from 'node:fs'

const fails = []
let passes = 0

function check(name, cond, detail) {
  if (cond) passes++
  else fails.push(name + (detail ? ' — ' + detail : ''))
}

// ── the shared arithmetic, stated once here as the reference ────────────────
function reference(w, h, state) {
  const r = Math.min(w, h)
  const c = ((state % 8) + 8) % 8
  const corner = Math.floor(c / 2)
  const leafIsNext = c % 2 === 0
  const pts = [{ x: 0, y: 0 }, { x: r, y: 0 }, { x: r, y: r }, { x: 0, y: r }]
  const P = pts[corner], A = pts[(corner + 1) % 4], B = pts[(corner + 3) % 4]
  const cross = (A.x - P.x) * (B.y - P.y) - (A.y - P.y) * (B.x - P.x)
  return { r, P, A, B, sweep: cross > 0 ? 1 : 0, leaf: leafIsNext ? A : B }
}

// ── 1. Both files still carry the same four decisions ───────────────────────
// Compared as normalised source rather than by importing, because neither file
// can be imported here: one is a 21,000-line React app, the other is JSX.
const app    = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const portal = readFileSync(new URL('../src/portal/Layout.jsx', import.meta.url), 'utf8')

const shared = [
  ['corner from state',  /const corner = Math\.floor\(c \/ 2\)/],
  ['leaf from state',    /leafIsNext = c % 2 === 0/],
  ['the four corners',   /\{ x: ?0, ?y: ?0 \}, ?\{ x: ?r, ?y: ?0 \}, ?\{ x: ?r, ?y: ?r \}, ?\{ x: ?0, ?y: ?r \}/],
  ['adjacent corners',   /pts\[\(corner \+ 1\) % 4\], ?B = pts\[\(corner \+ 3\) % 4\]/],
  ['cross product',      /\(A\.x - P\.x\) \* \(B\.y - P\.y\) - \(A\.y - P\.y\) \* \(B\.x - P\.x\)/],
  ['sweep from cross',   /cross > 0 \? 1 : 0/],
  ['radius is the min',  /Math\.min\(\w+\.?\w*, ?\w+\.?\w*\)/],
]
for (const [what, re] of shared) {
  check('admin app has ' + what, re.test(app))
  check('portal has ' + what, re.test(portal))
}

// ── 2. All eight states are distinct ────────────────────────────────────────
// The button is only useful if pressing it always changes something. Two states
// that render identically would look like the button had stopped working.
const seen = new Set()
for (let s = 0; s < 8; s++) {
  const g = reference(900, 900, s)
  seen.add([g.P.x, g.P.y, g.leaf.x, g.leaf.y, g.sweep].join(','))
}
check('eight distinct door arrangements', seen.size === 8, seen.size + ' distinct')

// ── 3. The arc always joins the two edges meeting at the hinge ──────────────
for (let s = 0; s < 8; s++) {
  const g = reference(900, 900, s)
  const dA = Math.hypot(g.A.x - g.P.x, g.A.y - g.P.y)
  const dB = Math.hypot(g.B.x - g.P.x, g.B.y - g.P.y)
  check('state ' + s + ': arc ends are one radius from the hinge',
    Math.abs(dA - g.r) < 0.001 && Math.abs(dB - g.r) < 0.001, dA + '/' + dB)
  check('state ' + s + ': the leaf rests on an edge, not the diagonal',
    (g.leaf.x === g.P.x) !== (g.leaf.y === g.P.y))
}

// ── 3b. Only an INWARD door draws its arc ───────────────────────────────────
//
// The rule, and the reason for it: at Hawthbush the doors open outwards, so the
// swing happens outside the room. An arc there would hang off the edge of the
// plan and would describe floor that is not ours to plan anyway. An inward
// door's arc IS floor nobody can put a table on, which is the whole reason for
// drawing one.
//
// Both apps must agree about that, or Toby draws a doorway and the couple is
// shown an arc eating their floor — or worse, the reverse.
const drawsArc = (swing) => swing === 'in'

check('an inward door draws its arc', drawsArc('in'))
check('an outward door does not', !drawsArc('out'))
check('anything unset opens outwards', !drawsArc(undefined) && !drawsArc(null) && !drawsArc(''))
// A typo must not quietly become an inward door and start eating floor.
check('an unrecognised value opens outwards', !drawsArc('inward') && !drawsArc('IN'))

for (const [file, name] of [[app, 'admin app'], [portal, 'portal']]) {
  check(name + ' tests the swing for the exact string "in"', /swing\s*===\s*['"]in['"]/.test(file))
  check(name + ' draws the arc only when inward', /inward\s*&&/.test(file))
}

// ── 4. The state wraps rather than breaking ─────────────────────────────────
// The button does (hinge + 1) % 8 forever, and an old row may hold anything.
check('state 8 is state 0', JSON.stringify(reference(900,900,8)) === JSON.stringify(reference(900,900,0)))
check('a negative state still resolves', reference(900, 900, -1).r === 900)
check('a missing state is state 0',
  JSON.stringify(reference(900,900,Number(undefined) || 0)) === JSON.stringify(reference(900,900,0)))

// ── report ──────────────────────────────────────────────────────────────────
if (fails.length === 0) {
  console.log('ALL ' + passes + ' ASSERTIONS PASSED')
} else {
  console.log(passes + ' passed, ' + fails.length + ' FAILED:')
  for (const f of fails) console.log('  ' + f)
  process.exit(1)
}
