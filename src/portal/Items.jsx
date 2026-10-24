import { useEffect, useState } from 'react'
import { rpc, isMissingFunction } from './supabase.js'
import WhenInput from './WhenInput.jsx'

// The things a client is bringing to the venue — signs, favours, the cake
// knife. Staff tick each one off as it arrives and again as it goes home, so
// nothing is left in the barn on Monday morning.
//
// Components that render inputs live at module scope — see Guests.jsx.

export default function Items() {
  const [data, setData] = useState(null)
  const [state, setState] = useState('loading')
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(null)   // null, or a name to start with

  async function load() {
    try { setData(await rpc('wp_get_items')); setState('ready') }
    catch (e) { setError(e.message || String(e)); setState('error') }
  }
  useEffect(() => { load() }, [])

  if (state === 'loading') return <section className="card"><p className="muted">Loading…</p></section>
  if (state === 'error') {
    return (
      <section className="card">
        <h2>We couldn't load your list</h2>
        <div className="alert alert-warn" style={{ fontSize: 12 }}>{error}</div>
        <button className="btn" onClick={load}>Try again</button>
      </section>
    )
  }

  const have = new Set(data.items.map((i) => i.name.toLowerCase()))
  const suggestions = (data.typical || []).filter((n) => !have.has(n.toLowerCase()))

  return (
    <>
      <DropOffSlot />
      <section className="card">
        <div className="list-head">
          <div>
            <h3 style={{ marginBottom: 4 }}>What you are bringing</h3>
            <p className="muted" style={{ fontSize: 13 }}>
              Anything you are dropping off for the day. We tick each one off when it
              arrives, and again when it goes home — so tell us who is taking it away
              at the end.
            </p>
          </div>
          <span className="count">{data.items.length}</span>
        </div>

        <div className="alert alert-warn" style={{ fontSize: 13 }}>
          <strong>Decorations for hanging in the barn</strong> — bunting, drapes, fabric, paper
          or anything else hung or draped — must be approved by us first, to meet fire
          regulations. Put them on the list with a note of what they are made of and
          we will confirm.
        </div>

        {data.items.length > 0 && (
          <div className="guests">
            {data.items.map((it) => <ItemRow key={it.id} item={it} onChanged={load} />)}
          </div>
        )}
        {data.items.length === 0 && adding === null && (
          <p className="muted" style={{ fontSize: 14, padding: '10px 0' }}>Nothing on the list yet.</p>
        )}

        {adding !== null
          ? <ItemForm item={null} startName={adding} onDone={() => { setAdding(null); load() }} onCancel={() => setAdding(null)} />
          : <div className="actions"><button className="btn-small" onClick={() => setAdding('')}>Add something</button></div>}
      </section>

      {suggestions.length > 0 && adding === null && (
        <section className="card">
          <h3>Things people often bring</h3>
          <p className="muted" style={{ fontSize: 13 }}>Tap one to add it.</p>
          <div className="pick-list">
            {suggestions.map((n) => (
              <button key={n} type="button" className="pick" onClick={() => setAdding(n)}>+ {n}</button>
            ))}
          </div>
        </section>
      )}
    </>
  )
}

function ItemRow({ item, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function remove() {
    setBusy(true); setErr('')
    try { await rpc('wp_delete_item', { p_id: item.id }); await onChanged() }
    catch (e) {
      setErr(e.code === 'already_received'
        ? 'We already have this one, so it stays on the list — it is how it gets back to you.'
        : (e.message || String(e)))
      setBusy(false); setConfirming(false)
    }
  }

  if (editing) {
    return <ItemForm item={item} onDone={() => { setEditing(false); onChanged() }} onCancel={() => setEditing(false)} />
  }

  return (
    <div className="guest">
      <div className="guest-main">
        <span className="guest-name">{item.name}</span>
        {item.qty > 1 && <span className="guest-side">× {item.qty}</span>}
        {item.collected_at ? <span className="chip chip-go">Gone home</span>
          : item.received_at ? <span className="chip chip-go">With us</span> : null}
        {item.take_home_by && <div className="guest-note">Taking it home: {item.take_home_by}</div>}
        {item.notes && <div className="guest-note">{item.notes}</div>}
        {err && <div className="guest-note err">{err}</div>}
      </div>
      <div className="guest-actions">
        {confirming ? (
          <>
            <button className="btn-small danger" onClick={remove} disabled={busy}>Remove</button>
            <button className="btn-small ghost" onClick={() => setConfirming(false)}>Keep</button>
          </>
        ) : (
          <>
            <button className="btn-small ghost" onClick={() => setEditing(true)}>Edit</button>
            {!item.received_at && <button className="btn-small ghost" onClick={() => setConfirming(true)}>Remove</button>}
          </>
        )}
      </div>
    </div>
  )
}

function ItemForm({ item, startName, onDone, onCancel }) {
  const [name, setName] = useState(item ? item.name : (startName || ''))
  const [qty, setQty] = useState(item ? item.qty : 1)
  const [home, setHome] = useState(item && item.take_home_by ? item.take_home_by : '')
  const [notes, setNotes] = useState(item && item.notes ? item.notes : '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      if (item) {
        await rpc('wp_update_item', { p_id: item.id, p_name: name, p_qty: Number(qty) || 1,
                                      p_notes: notes, p_take_home_by: home })
      } else {
        await rpc('wp_add_item', { p_name: name, p_qty: Number(qty) || 1,
                                   p_notes: notes || null, p_take_home_by: home || null })
      }
      onDone()
    } catch (e2) {
      setErr(e2.code === 'no_name' ? 'What is it?' : (e2.message || String(e2)))
      setBusy(false)
    }
  }

  return (
    <form className="editor" onSubmit={submit}>
      <div className="namegrid">
        <div>
          <label>What is it</label>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div>
          <label>How many</label>
          <input type="number" min="1" max="999" value={qty} onChange={(e) => setQty(e.target.value)} />
        </div>
      </div>
      <label>Who is taking it home at the end <span className="opt">optional</span></label>
      <input value={home} onChange={(e) => setHome(e.target.value)} placeholder="Name, so we know who to hand it to" />
      <label style={{ marginTop: 12 }}>Anything we should know <span className="opt">optional</span></label>
      <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Where it goes, how it is set up…" />
      {err && <div className="alert alert-warn">{err}</div>}
      <div className="actions">
        <button className="btn-small" type="submit" disabled={busy}>{busy ? 'Saving…' : (item ? 'Save' : 'Add')}</button>
        <button className="btn-small ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

// When it all arrives and when it goes home. Stored as venue-form answers
// (dropoff_date, dropoff_time, collect_date, collect_time) so they sit with
// everything else the couple tells us and reach the function sheet; saving
// here sends only these four, and the form merges them in.
const SLOT_KEYS = ['dropoff_date', 'dropoff_time', 'collect_date', 'collect_time']

function DropOffSlot() {
  const [vals, setVals] = useState(null)
  const [state, setState] = useState('loading')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  async function load() {
    try {
      const d = await rpc('wp_get_venue_form')
      const keys = new Set((d.questions || []).map((q) => q.qkey))
      // The questions arrive with a migration; until then there is nowhere to
      // keep the answers, so say nothing rather than offer a box that drops them.
      if (!SLOT_KEYS.every((k) => keys.has(k))) { setState('absent'); return }
      const a = d.answers || {}
      setVals(Object.fromEntries(SLOT_KEYS.map((k) => [k, a[k] || ''])))
      setState('ready')
    } catch (e) {
      setState(isMissingFunction(e) ? 'absent' : 'quiet')
    }
  }
  useEffect(() => { load() }, [])

  if (state !== 'ready') return null

  function set(k, v) { setVals((p) => ({ ...p, [k]: v })); setMsg('') }
  async function save(e) {
    e.preventDefault()
    setBusy(true); setErr(''); setMsg('')
    try { await rpc('wp_save_venue_form', { p_answers: vals }); setMsg('Saved. Thank you.') }
    catch (e2) { setErr(e2.message || String(e2)) }
    finally { setBusy(false) }
  }

  return (
    <form className="card" onSubmit={save}>
      <h3 style={{ marginBottom: 4 }}>Dropping off and collecting</h3>
      <p className="muted" style={{ fontSize: 13 }}>
        Tell us roughly when you will bring everything in, and when it will be collected,
        so somebody is here to meet you.
      </p>
      <div className="namegrid" style={{ marginTop: 12 }}>
        <div>
          <label htmlFor="drop-d">Dropping off</label>
          <WhenInput id="drop-d" type="date" value={vals.dropoff_date} onChange={(e) => set('dropoff_date', e.target.value)} />
        </div>
        <div>
          <label htmlFor="drop-t">Roughly what time</label>
          <WhenInput id="drop-t" type="time" value={vals.dropoff_time} onChange={(e) => set('dropoff_time', e.target.value)} />
        </div>
        <div>
          <label htmlFor="coll-d">Collecting</label>
          <WhenInput id="coll-d" type="date" value={vals.collect_date} onChange={(e) => set('collect_date', e.target.value)} />
        </div>
        <div>
          <label htmlFor="coll-t">Roughly what time</label>
          <WhenInput id="coll-t" type="time" value={vals.collect_time} onChange={(e) => set('collect_time', e.target.value)} />
        </div>
      </div>
      {err && <div className="alert alert-warn">{err}</div>}
      {msg && <div className="alert alert-ok">{msg}</div>}
      <div className="actions">
        <button className="btn-small" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  )
}
