import { useEffect, useState } from 'react'
import { rpc } from './supabase.js'

// Components that render inputs live at module scope — see Guests.jsx.

const hhmm = (t) => (t ? String(t).slice(0, 5) : '')

function endsAt(start, mins) {
  if (!start || !mins) return null
  const [h, m] = String(start).split(':').map(Number)
  const total = h * 60 + m + mins
  return String(Math.floor(total / 60) % 24).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0')
}

function lengthLabel(mins) {
  if (!mins) return null
  if (mins < 60) return mins + ' min'
  const h = Math.floor(mins / 60), m = mins % 60
  return h + (h === 1 ? ' hr' : ' hrs') + (m ? ' ' + m + ' min' : '')
}

export default function Timeline() {
  const [data, setData] = useState(null)
  const [state, setState] = useState('loading')
  const [error, setError] = useState('')
  const [day, setDay] = useState(null)

  async function load() {
    try {
      const d = await rpc('wp_get_timeline')
      setData(d)
      setDay((prev) => prev || (d.days.find((x) => x.day_key === 'event') || d.days[0] || {}).day_key)
      setState('ready')
    } catch (e) { setError(e.message || String(e)); setState('error') }
  }
  useEffect(() => { load() }, [])

  if (state === 'loading') return <section className="card"><p className="muted">Loading…</p></section>
  if (state === 'error') {
    return (
      <section className="card">
        <h2>We couldn't load your timeline</h2>
        <div className="alert alert-warn" style={{ fontSize: 12 }}>{error}</div>
        <button className="btn" onClick={load}>Try again</button>
      </section>
    )
  }

  const current = data.days.find((d) => d.day_key === day) || data.days[0]
  const blocks = data.blocks.filter((b) => b.day_key === (current || {}).day_key)

  return (
    <>
      <section className="card">
        <h3>How the day runs</h3>
        <p className="muted" style={{ fontSize: 14 }}>
          A rough shape is plenty this far out. We use it to know when to expect
          everyone — it is not a contract, and nobody will hold you to the minute.
        </p>

        {data.days.length > 1 && (
          <div className="daytabs" role="tablist">
            {data.days.map((d) => (
              <button
                key={d.day_key}
                role="tab"
                aria-selected={d.day_key === (current || {}).day_key}
                className="daytab"
                onClick={() => setDay(d.day_key)}
              >
                {d.label}
              </button>
            ))}
          </div>
        )}
        {data.days.length === 1 && (
          <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
            Your booking is for the one day, so everything — including setting up —
            happens on {current.label.toLowerCase()}.
          </p>
        )}
      </section>

      {current && <Limits day={current} />}

      <section className="card">
        <div className="list-head">
          <h3 style={{ marginBottom: 0 }}>{current ? current.label : 'The day'}</h3>
          <span className="count">{blocks.length}</span>
        </div>

        {blocks.length === 0 ? (
          <p className="muted" style={{ fontSize: 14, padding: '12px 0' }}>Nothing here yet.</p>
        ) : (
          <div className="tl">
            {blocks.map((b) => (
              <Block key={b.id} block={b} suppliers={data.suppliers} onChanged={load} />
            ))}
          </div>
        )}

        <AddBlock
          dayKey={current ? current.day_key : 'event'}
          suppliers={data.suppliers}
          onChanged={load}
        />
      </section>

      {blocks.length > 0 && current && (
        <RunningLate dayKey={current.day_key} onChanged={load} />
      )}
    </>
  )
}

// What is fixed comes back computed, never stored, so it cannot go stale when
// an access time changes. The contract's own wording is shown verbatim beside
// it — deliberately not parsed. "10am to Midnight" is prose, and turning prose
// into numbers is how the corkage note once became a £9,100 charge.
function Limits({ day }) {
  const fixed = day.fixed || []
  if (!fixed.length && !day.access_text) return null

  return (
    <section className="card">
      <h3>What is fixed</h3>

      {day.access_text && (
        <div className="rows">
          <div className="row">
            <span className="k">Access</span>
            <span className="v">{day.access_text}</span>
          </div>
        </div>
      )}

      {fixed.length > 0 && (
        <div className="rows" style={{ marginTop: day.access_text ? 12 : 0 }}>
          {fixed.map((f) => (
            <div className="row" key={f.title}>
              <span className="k">{f.title}</span>
              <span className="v">{hhmm(f.time)}</span>
            </div>
          ))}
        </div>
      )}

      <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
        {fixed.length
          ? 'These come with the venue and cannot be moved from here. If you need something different, talk to us — sometimes there is room, and it is much easier to ask now.'
          : 'Your finishing times follow the access times in your contract. We will confirm them with you.'}
      </p>
    </section>
  )
}

function Block({ block, suppliers, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function remove() {
    setBusy(true); setErr('')
    try { await rpc('wp_delete_block', { p_id: block.id }); await onChanged() }
    catch (e) { setErr(e.message || String(e)); setBusy(false); setConfirming(false) }
  }

  async function togglePin() {
    setBusy(true); setErr('')
    try { await rpc('wp_update_block', { p_id: block.id, p_pinned: !block.pinned }); await onChanged() }
    catch (e) { setErr(e.message || String(e)) } finally { setBusy(false) }
  }

  if (editing) {
    return (
      <div className="tl-row">
        <BlockForm
          block={block}
          dayKey={block.day_key}
          suppliers={suppliers}
          onDone={() => { setEditing(false); onChanged() }}
          onCancel={() => setEditing(false)}
        />
      </div>
    )
  }

  const end = endsAt(block.start_time, block.duration_min)

  return (
    <div className={'tl-row' + (block.locked ? ' is-locked' : '')}>
      <div className="tl-time">
        <span className="tl-start">{hhmm(block.start_time)}</span>
        {end && end !== hhmm(block.start_time) && <span className="tl-end">{end}</span>}
      </div>
      <div className="tl-main">
        <div className="tl-title">
          {block.title}
          {block.locked && <span className="chip">Set by us</span>}
          {block.pinned && !block.locked && <span className="chip">Fixed</span>}
        </div>
        <div className="tl-meta">
          {lengthLabel(block.duration_min)}
          {block.supplier_name && <> · {block.supplier_name}</>}
        </div>
        {block.notes && <div className="tl-notes">{block.notes}</div>}
        {err && <div className="tl-notes err">{err}</div>}
      </div>
      {!block.locked && (
        <div className="guest-actions">
          {confirming ? (
            <>
              <button className="btn-small danger" onClick={remove} disabled={busy}>Remove</button>
              <button className="btn-small ghost" onClick={() => setConfirming(false)}>Keep</button>
            </>
          ) : (
            <>
              <button className="btn-small ghost" onClick={togglePin} disabled={busy}>
                {block.pinned ? 'Unfix' : 'Fix'}
              </button>
              <button className="btn-small ghost" onClick={() => setEditing(true)}>Edit</button>
              <button className="btn-small ghost" onClick={() => setConfirming(true)}>Remove</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function BlockForm({ block, dayKey, suppliers, onDone, onCancel }) {
  const [start, setStart] = useState(block ? hhmm(block.start_time) : '')
  const [title, setTitle] = useState(block ? block.title : '')
  const [mins, setMins] = useState(block ? block.duration_min : 30)
  const [notes, setNotes] = useState(block && block.notes ? block.notes : '')
  const [sup, setSup] = useState(block && block.supplier_id ? block.supplier_id : '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      if (block) {
        await rpc('wp_update_block', {
          p_id: block.id, p_start_time: start, p_title: title,
          p_duration_min: Number(mins) || 0, p_notes: notes,
          p_supplier_id: sup || null,
        })
      } else {
        await rpc('wp_add_block', {
          p_day_key: dayKey, p_start_time: start, p_title: title,
          p_duration_min: Number(mins) || 0, p_notes: notes || null,
          p_supplier_id: sup || null,
        })
      }
      onDone()
    } catch (e2) {
      setErr(
        e2.code === 'no_title' ? 'Give it a name first.'
        : e2.code === 'no_time' ? 'What time does it start?'
        : e2.code === 'day_not_offered' ? 'Your booking does not include that day.'
        : e2.code === 'not_your_supplier' ? 'Add that supplier on the Suppliers tab first.'
        : (e2.message || String(e2))
      )
      setBusy(false)
    }
  }

  return (
    <form className="editor" onSubmit={submit} style={{ marginTop: 0, width: '100%' }}>
      <div className="namegrid">
        <div>
          <label>Starts</label>
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} required />
        </div>
        <div>
          <label>How long <span className="opt">minutes</span></label>
          <input type="number" min="0" max="1440" step="15" value={mins} onChange={(e) => setMins(e.target.value)} />
        </div>
      </div>
      <label>What is happening</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ceremony, speeches, cake…" autoFocus={!block} />
      {suppliers.length > 0 && (
        <>
          <label style={{ marginTop: 12 }}>Who is doing it <span className="opt">optional</span></label>
          <select value={sup} onChange={(e) => setSup(e.target.value)}>
            <option value="">—</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </>
      )}
      <label style={{ marginTop: 12 }}>Notes <span className="opt">optional</span></label>
      <input value={notes} onChange={(e) => setNotes(e.target.value)} />
      {err && <div className="alert alert-warn">{err}</div>}
      <div className="actions">
        <button className="btn-small" type="submit" disabled={busy}>{busy ? 'Saving…' : (block ? 'Save' : 'Add')}</button>
        <button className="btn-small ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function AddBlock({ dayKey, suppliers, onChanged }) {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <div className="actions">
        <button className="btn-small" onClick={() => setOpen(true)}>Add something</button>
      </div>
    )
  }
  return (
    <BlockForm
      block={null}
      dayKey={dayKey}
      suppliers={suppliers}
      onDone={() => { setOpen(false); onChanged() }}
      onCancel={() => setOpen(false)}
    />
  )
}

// What actually happens on the day: one thing overruns and everything after it
// slides. Anything we have fixed stays put — the bar does not close later
// because lunch went long — and so does anything the couple has fixed.
function RunningLate({ dayKey, onChanged }) {
  const [from, setFrom] = useState('')
  const [mins, setMins] = useState(30)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')

  async function go(e) {
    e.preventDefault()
    if (!from) return
    setBusy(true); setErr(''); setMsg('')
    try {
      const r = await rpc('wp_shift_after', { p_day_key: dayKey, p_from: from, p_minutes: Number(mins) })
      setMsg(r.moved === 0 ? 'Nothing after that time to move.' : `Moved ${r.moved} thing${r.moved === 1 ? '' : 's'}.`)
      await onChanged()
    } catch (e2) { setErr(e2.message || String(e2)) } finally { setBusy(false) }
  }

  return (
    <section className="card">
      <h3>Everything running late?</h3>
      <p className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
        Push everything after a certain time along, in one go. Anything we have set,
        and anything you have fixed, stays where it is.
      </p>
      <form onSubmit={go}>
        <div className="namegrid">
          <div>
            <label>Everything after</label>
            <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label>Moves later by</label>
            <select value={mins} onChange={(e) => setMins(e.target.value)}>
              <option value="15">15 minutes</option>
              <option value="30">30 minutes</option>
              <option value="45">45 minutes</option>
              <option value="60">an hour</option>
              <option value="-15">15 minutes earlier</option>
              <option value="-30">30 minutes earlier</option>
            </select>
          </div>
        </div>
        {err && <div className="alert alert-warn">{err}</div>}
        {msg && <div className="alert alert-ok">{msg}</div>}
        <div className="actions">
          <button className="btn-small" type="submit" disabled={busy || !from}>
            {busy ? 'Moving…' : 'Shift them'}
          </button>
        </div>
      </form>
    </section>
  )
}
