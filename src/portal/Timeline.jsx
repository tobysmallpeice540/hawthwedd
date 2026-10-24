import { useEffect, useState } from 'react'
import { rpc, isMissingFunction } from './supabase.js'
import { dayOrder } from '../shared/dayOrder.js'

// Components that render inputs live at module scope — see Guests.jsx.

const hhmm = (t) => (t ? String(t).slice(0, 5) : '')

function endsAt(start, mins) {
  if (!start || !mins) return null
  const [h, m] = String(start).split(':').map(Number)
  const total = h * 60 + m + mins
  return String(Math.floor(total / 60) % 24).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0')
}

// The venue's own times — music ends, bar closes, carriages, site closed — are
// part of the day, not a separate list to cross-reference. They are woven in at
// their own times so a couple planning speeches at 23:30 can SEE the bar closing
// at 23:45 on the line below, rather than being told it somewhere else.
//
// They come back computed, never stored, so they cannot go stale when an access
// time changes — and they are not editable here, which the row says quietly
// rather than with a button that refuses.
//
// Two things at the same time is fine. A band setting up while the cake arrives
// is an ordinary afternoon, so equal start times simply sit next to each other
// in the order they were added.
function mergeDay(blocks, fixed) {
  const rows = blocks.map((b) => ({ kind: 'block', at: b.start_time, block: b }))
  for (const f of fixed || []) {
    if (f && f.time) rows.push({ kind: 'venue', at: f.time, title: f.title })
  }
  return rows.sort((a, b) => {
    // Not a text compare: midnight and half past belong at the END of the
    // wedding day, not the start of it. See dayOrder().
    const t = dayOrder(a.at) - dayOrder(b.at)
    if (t !== 0) return t
    // A venue line at the same minute reads better after the couple's own.
    return (a.kind === 'venue' ? 1 : 0) - (b.kind === 'venue' ? 1 : 0)
  })
}

function lengthLabel(mins) {
  if (!mins) return null
  if (mins < 60) return mins + ' min'
  const h = Math.floor(mins / 60), m = mins % 60
  return h + (h === 1 ? ' hr' : ' hrs') + (m ? ' ' + m + ' min' : '')
}

export default function Timeline({ kind, onGo }) {
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
  const rows = mergeDay(blocks, current ? current.fixed : [])

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
        {/* The ceremony belongs to the day itself — not the set-up day before
            or the clear-up day after. */}
        {'ceremony_time' in data && current && current.day_key === 'event' && (kind === 'Wedding' || data.blocks.some((b) => b.rel_minutes !== null && b.rel_minutes !== undefined)) && (
          <CeremonyTime value={data.ceremony_time} blocks={data.blocks} onSaved={load} />
        )}

        {data.days.length === 1 && (
          <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
            Your booking is for the one day, so everything — including setting up —
            happens on {current.label.toLowerCase()}.
          </p>
        )}
      </section>

      <section className="card">
        <div className="list-head">
          <h3 style={{ marginBottom: 0 }}>{current ? current.label : 'The day'}</h3>
          <span className="count">{blocks.length}</span>
        </div>

        {current && current.access_text && (
          <p className="muted" style={{ fontSize: 13, marginTop: 2 }}>
            Access {current.access_text}.
          </p>
        )}

        {/* At the top as well as the bottom: on a long day the bottom button
            is a long scroll away. The new line drops into its place by time
            either way. */}
        {rows.length > 0 && (
          <AddBlock
            dayKey={current ? current.day_key : 'event'}
            suppliers={data.suppliers}
            contacts={data.contacts}
            onChanged={load}
          />
        )}

        {rows.length === 0 ? (
          <p className="muted" style={{ fontSize: 14, padding: '12px 0' }}>Nothing here yet.</p>
        ) : (
          <div className="tl">
            {rows.map((r, i) => (
              r.kind === 'venue'
                ? <VenueRow key={'v' + i} at={r.at} title={r.title} />
                : <Block key={r.block.id} block={r.block} suppliers={data.suppliers} contacts={data.contacts} ceremony={data.ceremony_time} onGo={onGo} onChanged={load} />
            ))}
          </div>
        )}

        <AddBlock
          dayKey={current ? current.day_key : 'event'}
          suppliers={data.suppliers}
          contacts={data.contacts}
          onChanged={load}
        />

        {(current && (current.fixed || []).length > 0) && (
          <p className="muted" style={{ fontSize: 12, marginTop: 14 }}>
            The greyed lines come with the venue and cannot be moved from here. If you
            need something different, talk to us — sometimes there is room, and it is
            much easier to ask now.
          </p>
        )}
      </section>
    </>
  )
}

// One of the venue's own times, sitting in the day where it falls.
function VenueRow({ at, title }) {
  return (
    <div className="tl-row is-venue">
      <div className="tl-time"><span className="tl-start">{hhmm(at)}</span></div>
      <div className="tl-main">
        <div className="tl-title">{title}</div>
      </div>
    </div>
  )
}


// The ceremony time, and what moves with it. Setting it moves every row marked
// "moves with the ceremony"; anything moved by hand has become a fixed time and
// stays where it was put.
function CeremonyTime({ value, blocks, onSaved }) {
  const [t, setT] = useState(hhmm(value))
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const following = blocks.filter((b) => b.day_key === 'event' && b.rel_minutes !== null && b.rel_minutes !== undefined && !b.locked).length

  async function save(e) {
    e.preventDefault()
    setBusy(true); setErr(''); setNote('')
    try {
      const r = await rpc('wp_set_ceremony_time', { p_time: t || null })
      setNote(t ? (r.moved ? r.moved + (r.moved === 1 ? ' thing has' : ' things have') + ' moved with it.' : 'Saved.') : 'Cleared.')
      await onSaved()
    } catch (e2) { setErr(e2.message || String(e2)) }
    finally { setBusy(false) }
  }

  return (
    <form className="ceremony" onSubmit={save}>
      <div>
        <label htmlFor="cer-time">Ceremony time</label>
        <div className="ceremony-row">
          <input id="cer-time" type="time" value={t} onChange={(e) => setT(e.target.value)} />
          <button className="btn-small" type="submit" disabled={busy || t === hhmm(value)}>{busy ? 'Saving…' : 'Set'}</button>
        </div>
      </div>
      <p className="hint" style={{ marginTop: 6 }}>
        {following > 0
          ? following + (following === 1 ? ' line on the day moves' : ' lines on the day move') + ' with it, so you only change the time once.'
          : 'Lines on the day can be set to move with it.'}
        {note && <> <strong>{note}</strong></>}
      </p>
      {err && <div className="alert alert-warn">{err}</div>}
    </form>
  )
}

function Block({ block, suppliers, contacts, ceremony, onGo, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [answering, setAnswering] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function remove() {
    setBusy(true); setErr('')
    try { await rpc('wp_delete_block', { p_id: block.id }); await onChanged() }
    catch (e) { setErr(e.message || String(e)); setBusy(false); setConfirming(false) }
  }

  if (editing) {
    return (
      <div className="tl-row">
        <BlockForm
          block={block}
          dayKey={block.day_key}
          suppliers={suppliers}
          contacts={contacts}
          ceremony={ceremony}
          onDone={() => { setEditing(false); onChanged() }}
          onCancel={() => setEditing(false)}
        />
      </div>
    )
  }

  const prompts = String(block.prompts || '').split('\n').map((q) => q.trim()).filter(Boolean)
  const answers = Array.isArray(block.answers) ? block.answers : []

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
          {block.rel_minutes !== null && block.rel_minutes !== undefined && !block.locked && (
            <span className="chip" title="Moves when the ceremony time changes">Moves with ceremony</span>
          )}
        </div>
        <div className="tl-meta">
          {lengthLabel(block.duration_min)}
          {block.supplier_name && <> · {block.supplier_name}</>}
          {block.contact_name && <> · {block.contact_name}</>}
        </div>
        {block.notes && <div className="tl-notes">{block.notes}</div>}
        {/* The first dance song lives on the Music page, with its Spotify link
            — or a tick to say the DJ is doing it. */}
        {/first dance/i.test(block.title) && (
          <div className="tl-notes">
            First dance song: {onGo
              ? <button type="button" className="btn-quiet" onClick={() => onGo('music')}>add it on the Music page ›</button>
              : 'tell us on the Music page.'}
          </div>
        )}
        {prompts.length > 0 && !answering && (
          <div className="qa">
            {prompts.map((q, i) => (
              <div key={i} className="qa-row">
                <span className="qa-q">{q}</span>
                <span className={'qa-a' + (answers[i] ? '' : ' is-empty')}>{answers[i] || 'Not answered yet'}</span>
              </div>
            ))}
            <button className="btn-quiet" type="button" onClick={() => setAnswering(true)}>
              {answers.some(Boolean) ? 'Change answers' : 'Answer these'}
            </button>
          </div>
        )}
        {answering && (
          <AnswerForm block={block} prompts={prompts} answers={answers}
            onDone={() => { setAnswering(false); onChanged() }} onCancel={() => setAnswering(false)} />
        )}
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
              <button className="btn-small ghost" onClick={() => setEditing(true)}>Edit</button>
              <button className="btn-small ghost" onClick={() => setConfirming(true)}>Remove</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// The questions on a line, answered in place.
function AnswerForm({ block, prompts, answers, onDone, onCancel }) {
  const [vals, setVals] = useState(prompts.map((_, i) => answers[i] || ''))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setErr('')
    try { await rpc('wp_answer_block', { p_id: block.id, p_answers: vals }); onDone() }
    catch (e2) { setErr(e2.message || String(e2)); setBusy(false) }
  }

  return (
    <form className="editor" onSubmit={submit} style={{ marginTop: 10 }}>
      {prompts.map((q, i) => (
        <div key={i} style={{ marginBottom: 12 }}>
          <label>{q}</label>
          <input value={vals[i]} autoFocus={i === 0}
            onChange={(e) => { const v = vals.slice(); v[i] = e.target.value; setVals(v) }} />
        </div>
      ))}
      {err && <div className="alert alert-warn">{err}</div>}
      <div className="actions">
        <button className="btn-small" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save answers'}</button>
        <button className="btn-small ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function BlockForm({ block, dayKey, suppliers, contacts, ceremony, onDone, onCancel }) {
  const [start, setStart] = useState(block ? hhmm(block.start_time) : '')
  const [title, setTitle] = useState(block ? block.title : '')
  const [mins, setMins] = useState(block ? block.duration_min : 30)
  const [notes, setNotes] = useState(block && block.notes ? block.notes : '')
  // Who is doing it: one of their suppliers, or one of their own people (key
  // contacts, on the Details page). One value, prefixed, so one dropdown.
  const startWho = block && block.supplier_id ? 's:' + block.supplier_id
    : block && block.contact_id ? 'c:' + block.contact_id : ''
  const [who, setWho] = useState(startWho)
  const people = contacts || []
  const wasFollowing = !!block && block.rel_minutes !== null && block.rel_minutes !== undefined
  const [follow, setFollow] = useState(wasFollowing)
  // Offered on the day itself, once there is a ceremony time to follow.
  const canFollow = dayKey === 'event' && !!ceremony
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const supId = who.startsWith('s:') ? who.slice(2) : null
  const contactId = who.startsWith('c:') ? who.slice(2) : null

  // Sets both, so choosing nobody (or a person instead of a supplier) clears
  // what was there. Before the database knows the function, a supplier still
  // saves through the line itself; only a person needs it.
  async function setWhoFor(id) {
    try { await rpc('wp_set_block_who', { p_id: id, p_supplier_id: supId, p_contact_id: contactId }) }
    catch (e) { if (!(isMissingFunction(e) && !contactId)) throw e }
  }

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      if (block) {
        await rpc('wp_update_block', {
          p_id: block.id, p_start_time: start, p_title: title,
          p_duration_min: Number(mins) || 0, p_notes: notes,
          p_supplier_id: supId,
        })
        if (who !== startWho) await setWhoFor(block.id)
        // Moving a following line by hand fixes it at the new time (the
        // database does that). Ticking "move with the ceremony" afterwards
        // re-attaches it from wherever it now sits.
        const moved = hhmm(block.start_time) !== start
        if (canFollow && (follow !== wasFollowing || (follow && moved))) {
          await rpc('wp_set_block_follows', { p_id: block.id, p_follow: follow })
        }
      } else {
        const r = await rpc('wp_add_block', {
          p_day_key: dayKey, p_start_time: start, p_title: title,
          p_duration_min: Number(mins) || 0, p_notes: notes || null,
          p_supplier_id: supId,
        })
        if (contactId && r && r.id) await setWhoFor(r.id)
      }
      onDone()
    } catch (e2) {
      setErr(
        e2.code === 'no_title' ? 'Give it a name first.'
        : e2.code === 'no_time' ? 'What time does it start?'
        : e2.code === 'day_not_offered' ? 'Your booking does not include that day.'
        : e2.code === 'not_your_supplier' ? 'Add that supplier on the Suppliers tab first.'
        : e2.code === 'not_your_contact' ? 'That person is no longer in your key contacts.'
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
      <label style={{ marginTop: 12 }}>Who is doing it <span className="opt">optional</span></label>
      {suppliers.length > 0 || people.length > 0 ? (
        <select value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">—</option>
          {suppliers.length > 0 && (
            <optgroup label="Your suppliers">
              {suppliers.map((s) => <option key={s.id} value={'s:' + s.id}>{s.name}</option>)}
            </optgroup>
          )}
          {people.length > 0 && (
            <optgroup label="Your people">
              {people.map((c) => <option key={c.id} value={'c:' + c.id}>{c.name}{c.role ? ' (' + c.role + ')' : ''}</option>)}
            </optgroup>
          )}
        </select>
      ) : (
        <p className="hint" style={{ marginTop: 0 }}>
          Add your suppliers on the Suppliers page, or your own people under Details → key
          contacts, and you can pick them here.
        </p>
      )}
      <label style={{ marginTop: 12 }}>Notes <span className="opt">optional</span></label>
      <input value={notes} onChange={(e) => setNotes(e.target.value)} />
      {block && canFollow && (
        <label className="check" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Move this with the ceremony time
        </label>
      )}
      {err && <div className="alert alert-warn">{err}</div>}
      <div className="actions">
        <button className="btn-small" type="submit" disabled={busy}>{busy ? 'Saving…' : (block ? 'Save' : 'Add')}</button>
        <button className="btn-small ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function AddBlock({ dayKey, suppliers, contacts, onChanged }) {
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
      contacts={contacts}
      onDone={() => { setOpen(false); onChanged() }}
      onCancel={() => setOpen(false)}
    />
  )
}

