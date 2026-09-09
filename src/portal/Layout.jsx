import { useEffect, useRef, useState } from 'react'
import { rpc } from './supabase.js'

// The table plan.
//
// A table is one object: a 6ft trestle, 1830 × 760mm, with six seats derived
// from its position and rotation rather than placed. So dragging moves the
// table and its seats together, and rotating in 90° steps just redraws them —
// nobody changes seat because the plan turned.
//
// Everything is drawn in millimetres inside an SVG viewBox, so the browser does
// the scaling and no pixel maths appears anywhere below.

const L = 1830          // table length
const D = 760           // table depth
const SEAT_R = 190      // drawn seat radius
const SEAT_GAP = 240    // how far a seat sits off the table edge
const GRID = 250        // snap

// Seat centres for an unrotated table whose origin is its middle.
// 0,1,2 along one long side; 3,4,5 along the other. The index is the seat's
// identity and never changes when the table moves.
function seatOffset(i) {
  const col = i % 3
  const x = (col - 1) * (L / 3)
  const y = i < 3 ? -(D / 2 + SEAT_GAP) : (D / 2 + SEAT_GAP)
  return { x, y }
}

function rotatePoint(p, deg) {
  const r = (deg * Math.PI) / 180
  return { x: p.x * Math.cos(r) - p.y * Math.sin(r), y: p.x * Math.sin(r) + p.y * Math.cos(r) }
}

// Axis-aligned box a table occupies once rotated, used for the no-go check.
function tableBox(t) {
  const long = t.rotation === 90 || t.rotation === 270
  const w = long ? D : L
  const h = long ? L : D
  return { x: t.x_mm - w / 2, y: t.y_mm - h / 2, w, h }
}

function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

const snap = (v) => Math.round(v / GRID) * GRID

export default function Layout() {
  const [data, setData] = useState(null)
  const [state, setState] = useState('loading')
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(null)
  const [notice, setNotice] = useState('')
  const [narrow, setNarrow] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 820px)')
    const on = () => setNarrow(mq.matches)
    on()
    mq.addEventListener ? mq.addEventListener('change', on) : mq.addListener(on)
    return () => { mq.removeEventListener ? mq.removeEventListener('change', on) : mq.removeListener(on) }
  }, [])

  async function load() {
    try { setData(await rpc('wp_get_layout')); setState('ready') }
    catch (e) { setError(e.message || String(e)); setState('error') }
  }
  useEffect(() => { load() }, [])

  if (state === 'loading') return <section className="card"><p className="muted">Loading…</p></section>
  if (state === 'error') {
    return (
      <section className="card">
        <h2>We couldn't load your table plan</h2>
        <div className="alert alert-warn" style={{ fontSize: 12 }}>{error}</div>
        <button className="btn" onClick={load}>Try again</button>
      </section>
    )
  }

  if (!data.room) {
    return (
      <section className="card">
        <h3>Table plan</h3>
        <p className="muted" style={{ fontSize: 14, marginTop: 8 }}>
          We haven't set the room up yet. It will appear here shortly — do give us a nudge
          if it doesn't.
        </p>
      </section>
    )
  }

  const c = data.counts
  const sel = data.tables.find((t) => t.id === selected) || null

  return (
    <>
      <section className="card">
        <h3>Table plan</h3>
        <p className="muted" style={{ fontSize: 14 }}>
          Rough is fine. This helps us set the room up roughly right on the day —
          we will confirm the final version with you, and we can move things about.
        </p>
        <div className="totals-line" style={{ marginTop: 14 }}>
          <strong>{c.seated_guests}</strong> seated {c.seated_guests === 1 ? 'guest' : 'guests'}
          <span className="dot">·</span>
          <strong>{c.tables_needed}</strong> {c.tables_needed === 1 ? 'table' : 'tables'} needed
          <span className="dot">·</span>
          <strong>{data.tables.length}</strong> placed
        </div>
        {narrow && (
          <div className="alert alert-warn" style={{ marginTop: 14 }}>
            The plan needs a bigger screen to move things around. You can look at it here,
            but do come back on a laptop to change it.
          </div>
        )}
      </section>

      <section className="card">
        <RoomCanvas
          room={data.room}
          tables={data.tables}
          selected={selected}
          readOnly={narrow}
          onSelect={setSelected}
          onMoved={load}
          onNotice={setNotice}
        />
        {notice && <div className="alert alert-warn" style={{ marginTop: 12 }}>{notice}</div>}
        {!narrow && (
          <div className="actions">
            <button className="btn-small" onClick={async () => {
              try { await rpc('wp_add_table', { p_x_mm: snap(data.room.width_mm / 2), p_y_mm: snap(data.room.height_mm / 2) }); await load() }
              catch (e) { setNotice(e.message || String(e)) }
            }}>Add a table</button>
          </div>
        )}
      </section>

      {sel && (
        <TablePanel
          table={sel}
          unseated={data.unseated}
          readOnly={narrow}
          onChanged={load}
          onNotice={setNotice}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  )
}

// ── the room ────────────────────────────────────────────────────────────────

function RoomCanvas({ room, tables, selected, readOnly, onSelect, onMoved, onNotice }) {
  const svgRef = useRef(null)
  const [drag, setDrag] = useState(null)

  const shapes = room.shapes || []
  const nogo = shapes.filter((s) => s.kind === 'nogo')

  function toMm(evt) {
    const r = svgRef.current.getBoundingClientRect()
    return {
      x: ((evt.clientX - r.left) / r.width) * room.width_mm,
      y: ((evt.clientY - r.top) / r.height) * room.height_mm,
    }
  }

  function onPointerDown(e, t) {
    onSelect(t.id)
    if (readOnly) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = toMm(e)
    setDrag({ id: t.id, dx: p.x - t.x_mm, dy: p.y - t.y_mm, x: t.x_mm, y: t.y_mm })
  }

  function onPointerMove(e) {
    if (!drag) return
    const p = toMm(e)
    setDrag((d) => ({ ...d, x: snap(p.x - d.dx), y: snap(p.y - d.dy) }))
  }

  async function onPointerUp() {
    if (!drag) return
    const d = drag
    setDrag(null)

    const moved = { ...tables.find((t) => t.id === d.id), x_mm: d.x, y_mm: d.y }
    const box = tableBox(moved)

    if (box.x < 0 || box.y < 0 || box.x + box.w > room.width_mm || box.y + box.h > room.height_mm) {
      onNotice('That would put the table outside the room.')
      return
    }
    if (nogo.some((z) => overlaps(box, { x: z.x, y: z.y, w: z.w, h: z.h }))) {
      onNotice('Tables cannot go there — that space has to stay clear.')
      return
    }
    const clash = tables.some((t) => t.id !== d.id && overlaps(box, tableBox(t)))
    if (clash) {
      onNotice('That would sit on top of another table.')
      return
    }

    onNotice('')
    try { await rpc('wp_move_table', { p_id: d.id, p_x_mm: d.x, p_y_mm: d.y }); await onMoved() }
    catch (e) { onNotice(e.message || String(e)) }
  }

  return (
    <div className="canvas-wrap">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${room.width_mm} ${room.height_mm}`}
        className="room"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <rect x="0" y="0" width={room.width_mm} height={room.height_mm} className="room-floor" />

        {shapes.map((s, i) => (
          <g key={i}>
            <rect x={s.x} y={s.y} width={s.w} height={s.h}
              className={s.kind === 'nogo' ? 'zone-nogo' : 'zone-fixed'} />
            {s.label && (
              <text x={s.x + s.w / 2} y={s.y + s.h / 2} className="zone-label"
                dominantBaseline="middle" textAnchor="middle">{s.label}</text>
            )}
          </g>
        ))}

        {tables.map((t) => {
          const live = drag && drag.id === t.id ? { ...t, x_mm: drag.x, y_mm: drag.y } : t
          const seats = t.seats || []
          const n = t.one_side ? 3 : 6
          return (
            <g key={t.id}
               transform={`translate(${live.x_mm} ${live.y_mm}) rotate(${t.rotation})`}
               className={'table-g' + (selected === t.id ? ' is-selected' : '') + (readOnly ? ' is-locked' : '')}
               onPointerDown={(e) => onPointerDown(e, t)}>
              <rect x={-L / 2} y={-D / 2} width={L} height={D} rx="60" className="table-rect" />
              <text x="0" y="0" className="table-label" dominantBaseline="middle" textAnchor="middle">
                {t.label}
              </text>
              {Array.from({ length: n }).map((_, i) => {
                const o = seatOffset(i)
                const taken = seats.find((s) => s.seat_index === i)
                return (
                  <circle key={i} cx={o.x} cy={o.y} r={SEAT_R}
                    className={'seat' + (taken ? ' is-taken' : '')} />
                )
              })}
            </g>
          )
        })}
      </svg>
      <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        Indicative only — we will confirm the final layout with you.
      </p>
    </div>
  )
}

// ── one table ───────────────────────────────────────────────────────────────

function TablePanel({ table, unseated, readOnly, onChanged, onNotice, onClose }) {
  const [busy, setBusy] = useState(false)
  const [pick, setPick] = useState(null)     // seat index awaiting a guest
  const [search, setSearch] = useState('')
  const [confirming, setConfirming] = useState(false)

  const n = table.one_side ? 3 : 6
  const seats = table.seats || []
  const byIndex = (i) => seats.find((s) => s.seat_index === i)

  async function call(fn, args, after) {
    setBusy(true)
    try { const r = await rpc(fn, args); onNotice(''); await onChanged(); if (after) after(r) }
    catch (e) { onNotice(e.message || String(e)) }
    finally { setBusy(false) }
  }

  const matches = unseated.filter((g) =>
    !search.trim() || g.name.toLowerCase().includes(search.trim().toLowerCase()))

  return (
    <section className="card">
      <div className="list-head">
        <h3 style={{ marginBottom: 0 }}>{table.label}</h3>
        <button className="btn-small ghost" onClick={onClose}>Close</button>
      </div>

      {!readOnly && (
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="btn-small ghost" disabled={busy}
            onClick={() => call('wp_move_table', { p_id: table.id, p_rotation: (table.rotation + 90) % 360 })}>
            Turn 90°
          </button>
          <button className="btn-small ghost" disabled={busy}
            onClick={() => call('wp_set_table_sides', { p_id: table.id, p_one_side: !table.one_side }, (r) => {
              // Never let three people vanish quietly off a plan.
              if (r && r.unseated > 0) {
                onNotice(
                  `${r.unseated} ${r.unseated === 1 ? 'person is' : 'people are'} back on the list: ` +
                  (r.names || []).join(', ') + '. Seat them somewhere else when you are ready.'
                )
              }
            })}>
            {table.one_side ? 'Seats both sides' : 'Seats one side only'}
          </button>
          {confirming ? (
            <>
              <button className="btn-small danger" disabled={busy}
                onClick={() => call('wp_delete_table', { p_id: table.id }, (r) => {
                  onClose()
                  if (r && r.unseated > 0) onNotice(`${r.unseated} guest${r.unseated === 1 ? '' : 's'} went back on the list.`)
                })}>Remove the table</button>
              <button className="btn-small ghost" onClick={() => setConfirming(false)}>Keep it</button>
            </>
          ) : (
            <button className="btn-small ghost" onClick={() => setConfirming(true)}>Remove</button>
          )}
        </div>
      )}

      {table.one_side && (
        <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
          Three seats along one side — the usual arrangement for a top table.
        </p>
      )}

      <div className="seats-list">
        {Array.from({ length: n }).map((_, i) => {
          const taken = byIndex(i)
          return (
            <div className="seat-row" key={i}>
              <span className="seat-no">{i + 1}</span>
              {taken ? (
                <>
                  <span className="seat-name">{taken.name}</span>
                  {!readOnly && (
                    <button className="btn-small ghost" disabled={busy}
                      onClick={() => call('wp_unassign_seat', { p_guest_id: taken.guest_id })}>
                      Remove
                    </button>
                  )}
                </>
              ) : (
                <>
                  <span className="seat-name muted">Empty</span>
                  {!readOnly && (
                    <button className="btn-small ghost" onClick={() => { setPick(pick === i ? null : i); setSearch('') }}>
                      {pick === i ? 'Cancel' : 'Seat someone'}
                    </button>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>

      {pick !== null && !readOnly && (
        <div className="editor">
          <label>Who is sitting in seat {pick + 1}?</label>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Start typing a name" autoFocus />
          {unseated.length === 0 ? (
            <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
              Everyone on your seated list already has a seat.
            </p>
          ) : (
            <div className="pick-list">
              {matches.slice(0, 40).map((g) => (
                <button key={g.id} className="pick" disabled={busy}
                  onClick={() => call('wp_assign_seat', { p_guest_id: g.id, p_table_id: table.id, p_seat_index: pick },
                    () => setPick(null))}>
                  {g.name}{g.side ? <span className="muted"> · {g.side}</span> : null}
                </button>
              ))}
              {matches.length === 0 && <p className="muted" style={{ fontSize: 13 }}>Nobody by that name is still unseated.</p>}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
