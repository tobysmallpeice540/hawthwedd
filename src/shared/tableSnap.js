// Putting two tables together.
//
// THE TRAP THIS EXISTS TO FIX. A trestle is 1830mm long and the plan snapped
// positions to a 250mm grid. 1830 / 250 = 7.32, so two tables could never be
// placed exactly one table-length apart: the nearest grid positions leave an
// 80mm overlap, which the plan refused, or a 170mm gap, which looks like a gap.
// Butting two tables into one long one was therefore impossible, and nothing
// on screen explained why.
//
// A finer grid alone would not fix it — 1830 is not a multiple of anything
// round. What fixes it is snapping to the OTHER TABLES rather than to a grid:
// when an edge comes close to another table's edge, it goes flush.
//
// Everything here is in millimetres and rotation-aware, and every function is
// pure so tests/table-snap-test.mjs can exercise it without a browser.

// The bare tabletop — no chairs, no pull-out room. Edges join tabletop to
// tabletop, which is what "butted up" means to anyone laying a room out.
export function tableRect(t, size) {
  const long = t.rotation === 90 || t.rotation === 270;
  const w = long ? size.D : size.L;
  const h = long ? size.L : size.D;
  return { x: t.x_mm - w / 2, y: t.y_mm - h / 2, w, h };
}

// How close an edge has to be before it jumps flush. Generous enough to catch
// a rough drag, tight enough that a table deliberately placed a foot away stays
// a foot away.
export const SNAP_MM = 200;

// Candidate centres for one axis: flush on either side, flush at either end,
// or centred on it. The last two matter as much as the first — a row of tables
// wants to line up as well as touch.
function candidates(mySpan, theirStart, theirSpan) {
  const theirEnd = theirStart + theirSpan;
  return [
    theirEnd + mySpan / 2,                    // mine begins where theirs ends
    theirStart - mySpan / 2,                  // mine ends where theirs begins
    theirStart + mySpan / 2,                  // left edges aligned
    theirEnd - mySpan / 2,                    // right edges aligned
    theirStart + theirSpan / 2,               // centres aligned
  ];
}

// Nudge a proposed centre onto the nearest neighbouring edge, per axis and
// independently, so a table can go flush along one axis while staying put on
// the other. Returns the proposal unchanged when nothing is near.
//
// `isAllowed(x, y)` is the caller's own rule — room bounds, keep-clear zones,
// and the pull-out room around every other table. A SNAP MUST NEVER PROPOSE A
// POSITION THE PLAN WILL THEN REFUSE: without this the two long sides of two
// trestles jump together and the couple is immediately told they are too close
// for anybody to get up, which reads as the plan arguing with itself. Pushing
// two tables side by side also destroys the six seats along the join, so it is
// not a thing to help anyone do by accident.
export function snapToNeighbours(proposed, moving, others, size, opts) {
  const tolerance = (opts && opts.tolerance) || SNAP_MM;
  const isAllowed = (opts && opts.isAllowed) || (() => true);

  const me = tableRect({ ...moving, x_mm: proposed.x, y_mm: proposed.y }, size);
  let best = { x: { d: tolerance, v: proposed.x }, y: { d: tolerance, v: proposed.y } };

  for (const o of others || []) {
    if (!o || o.id === moving.id) continue;
    const r = tableRect(o, size);

    for (const c of candidates(me.w, r.x, r.w)) {
      const d = Math.abs(c - proposed.x);
      if (d < best.x.d && isAllowed(c, proposed.y)) best.x = { d, v: c };
    }
    for (const c of candidates(me.h, r.y, r.h)) {
      const d = Math.abs(c - proposed.y);
      if (d < best.y.d && isAllowed(proposed.x, c)) best.y = { d, v: c };
    }
  }

  // Each axis was judged against the UNSNAPPED other one, so check the pair
  // once more and give up rather than land somewhere refused.
  if (best.x.v !== proposed.x && best.y.v !== proposed.y && !isAllowed(best.x.v, best.y.v)) {
    if (best.x.d <= best.y.d) best.y = { d: tolerance, v: proposed.y };
    else best.x = { d: tolerance, v: proposed.x };
  }
  return { x: best.x.v, y: best.y.v };
}

// The floor a table really needs: the top, plus — on whichever sides have
// chairs — the chair and the room to pull it back and stand up.
//
// A table ticked "one side only" is padded on ONE side, so a top table can
// still go hard against a wall, which is the entire point of that tick.
export function tableFootprint(t, z) {
  const pad = z.chair + z.clear;
  const front = pad;
  const back = t.one_side ? 0 : pad;
  const w = z.L;
  const h = z.D + front + back;
  const cy = (front - back) / 2;
  const rad = ((t.rotation || 0) * Math.PI) / 180;
  const off = {
    x: 0 * Math.cos(rad) - (-cy) * Math.sin(rad),
    y: 0 * Math.sin(rad) + (-cy) * Math.cos(rad),
  };
  const long = t.rotation === 90 || t.rotation === 270;
  return {
    x: t.x_mm + off.x - (long ? h : w) / 2,
    y: t.y_mm + off.y - (long ? w : h) / 2,
    w: long ? h : w,
    h: long ? w : h,
  };
}

// Touching is not overlapping.
//
// The old test used strict inequalities, which is right in principle — two
// boxes sharing an edge do not overlap. In practice a millimetre of rounding
// turned a flush join into a refusal, and the couple saw "those two would be
// too close" for two tables that were exactly touching. A millimetre of slack
// makes flush reliable and costs nothing on a plan that is indicative anyway.
export const TOUCH_SLACK_MM = 2;

export function boxesOverlap(a, b, slack = TOUCH_SLACK_MM) {
  return a.x + slack < b.x + b.w &&
         a.x + a.w > b.x + slack &&
         a.y + slack < b.y + b.h &&
         a.y + a.h > b.y + slack;
}
