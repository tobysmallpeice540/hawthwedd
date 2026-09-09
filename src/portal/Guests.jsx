import { useEffect, useState } from 'react'
import { rpc } from './supabase.js'
import { parseGuests } from './parseGuests.js'
import { ACCOM_LABEL, accomOptions, sortGuests } from './guestSort.js'

// EVERY component that renders an input lives at module scope. A component
// defined inside another is a new type on every render, so React rebuilds its
// DOM — which destroys focus mid-typing and throws away list rows. That has
// caused two bugs and one performance problem in this codebase already.

const AGE_LABEL = { adult: 'Adult', child: 'Child', baby: 'High chair' }


function n(v) {
  if (v === '' || v === null || v === undefined) return null
  const x = parseInt(v, 10)
  return Number.isFinite(x) ? x : null
}

export default function Guests({ accommodation }) {
  const [data, setData] = useState(null)
  const [state, setState] = useState('loading')
  const [error, setError] = useState('')

  async function load() {
    try {
      const d = await rpc('wp_get_guests')
      setData(d)
      setState('ready')
    } catch (e) {
      setError(e.message || String(e))
      setState('error')
    }
  }

  useEffect(() => { load() }, [])

  if (state === 'loading') return <section className="card"><p className="muted">Loading…</p></section>
  if (state === 'error') {
    return (
      <section className="card">
        <h2>We couldn't load your guest list</h2>
        <div className="alert alert-warn" style={{ fontSize: 12 }}>{error}</div>
        <button className="btn" onClick={load}>Try again</button>
      </section>
    )
  }

  const seated  = data.guests.filter((g) => g.list === 'seated')
  const evening = data.guests.filter((g) => g.list === 'evening')

  return (
    <>
      <NumbersPanel numbers={data.numbers} derived={data.derived} onSaved={load} />
      <GuestList
        title="Seated for the meal"
        blurb="Everyone at a table for the wedding breakfast. This is the list the table plan will use."
        list="seated"
        guests={seated}
        tables={data.tables || []}
        accommodation={accommodation}
        onChanged={load}
      />
      <GuestList
        title="Evening only"
        blurb="People joining you later. They don't get a seat at the meal, but they do count towards numbers on site."
        list="evening"
        guests={evening}
        onChanged={load}
      />
    </>
  )
}

// ── the numbers, which come long before the names ──────────────────────────

function NumbersPanel({ numbers, derived, onSaved }) {
  const [adults,   setAdults]   = useState(numbers.seated_adults   ?? '')
  const [children, setChildren] = useState(numbers.seated_children ?? '')
  const [babies,   setBabies]   = useState(numbers.seated_babies   ?? '')
  const [evening,  setEvening]  = useState(numbers.evening_extras  ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved]   = useState(false)
  const [err, setErr] = useState('')

  const seatedTotal  = (n(adults) || 0) + (n(children) || 0) + (n(babies) || 0)
  const eveningTotal = seatedTotal + (n(evening) || 0)

  async function save(e) {
    e.preventDefault()
    setSaving(true); setErr(''); setSaved(false)
    try {
      await rpc('wp_set_numbers', {
        p_seated_adults: n(adults), p_seated_children: n(children),
        p_seated_babies: n(babies), p_evening_extras: n(evening),
      })
      setSaved(true)
      await onSaved()
    } catch (e2) {
      setErr(e2.message || String(e2))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="card">
      <h3>How many people</h3>
      <p className="muted" style={{ marginBottom: 16, fontSize: 14 }}>
        Rough numbers are fine to begin with — you can change them whenever you like.
        We only need the names much later.
      </p>

      <form onSubmit={save}>
        <div className="numgrid">
          <NumberField label="Adults seated"   value={adults}   onChange={setAdults} />
          <NumberField label="Children seated" value={children} onChange={setChildren} />
          <NumberField label="High chairs"     value={babies}   onChange={setBabies}
            hint="Little ones not taking a seat" />
          <NumberField label="Evening only"    value={evening}  onChange={setEvening} hint="Extra people arriving after the meal" />
        </div>

        {seatedTotal > 0 && (
          <div className="totals-line">
            <strong>{seatedTotal}</strong> seated for the meal
            <span className="dot">·</span>
            <strong>{eveningTotal}</strong> on site in the evening
          </div>
        )}

        <button className="btn" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save numbers'}
        </button>
        {saved && !saving && <div className="alert alert-ok">Saved. Thank you.</div>}
        {err && <div className="alert alert-warn">{err}</div>}
      </form>

      {derived.seated_unnamed > 0 && derived.named_seated > 0 && (
        <div className="alert alert-warn" style={{ marginTop: 16 }}>
          You've told us <strong>{derived.seated_total}</strong> seated and named{' '}
          <strong>{derived.named_seated}</strong> so far — {derived.seated_unnamed} to go.
          There's no rush.
        </div>
      )}
    </section>
  )
}

function NumberField({ label, value, onChange, hint }) {
  return (
    <div>
      <label>{label}</label>
      <input
        type="number" min="0" inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="—"
      />
      {hint && <div className="hint">{hint}</div>}
    </div>
  )
}

// ── a named list ───────────────────────────────────────────────────────────

function GuestList({ title, blurb, list, guests, tables, accommodation, onChanged }) {
  const [adding, setAdding] = useState(false)
  const [importing, setImporting] = useState(false)
  const [sort, setSort] = useState(list === 'seated' ? 'table' : 'name')

  const seatable = list === 'seated' && (tables || []).length > 0
  const shown = sortGuests(guests, sort)

  return (
    <section className="card">
      <div className="list-head">
        <div>
          <h3 style={{ marginBottom: 4 }}>{title}</h3>
          <p className="muted" style={{ fontSize: 13 }}>{blurb}</p>
        </div>
        <span className="count">{guests.length}</span>
      </div>

      {guests.length > 1 && (
        <div className="sort-bar">
          <span className="muted">Sort by</span>
          {[['name', 'Name'], seatable ? ['table', 'Table'] : null, ['where', 'Staying']]
            .filter(Boolean)
            .map(([k, lbl]) => (
              <button key={k} type="button"
                className={'btn-small ' + (sort === k ? '' : 'ghost')}
                onClick={() => setSort(k)}>{lbl}</button>
            ))}
        </div>
      )}

      {guests.length > 0 && (
        <div className="guests">
          {shown.map((g) => (
            <GuestRow key={g.id} guest={g} tables={seatable ? tables : null}
              accommodation={accommodation} onChanged={onChanged} />
          ))}
        </div>
      )}

      {guests.length === 0 && !adding && !importing && (
        <p className="muted" style={{ fontSize: 14, padding: '10px 0' }}>
          Nobody added yet.
        </p>
      )}

      {adding && <AddGuest list={list} accommodation={accommodation} onDone={() => { setAdding(false); onChanged() }} onCancel={() => setAdding(false)} />}
      {importing && <ImportGuests list={list} onDone={() => { setImporting(false); onChanged() }} onCancel={() => setImporting(false)} />}

      {!adding && !importing && (
        <div className="actions">
          <button className="btn-small" onClick={() => setAdding(true)}>Add someone</button>
          <button className="btn-small ghost" onClick={() => setImporting(true)}>Paste or upload a list</button>
        </div>
      )}
    </section>
  )
}

function GuestRow({ guest, tables, accommodation, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // Changing the table from the list picks the first free chair — which is what
  // somebody working down a list wants. Choosing a particular seat is what the
  // plan itself is for.
  async function moveTo(tableId) {
    setBusy(true); setErr('')
    try {
      const r = await rpc('wp_set_guest_table', { p_guest_id: guest.id, p_table_id: tableId || null })
      await onChanged()
      if (r && r.ok === false) setErr('That table is full.')
    } catch (e) {
      setErr(e.code === 'table_full' ? 'That table is full.' : (e.message || String(e)))
    } finally { setBusy(false) }
  }

  async function remove() {
    setBusy(true); setErr('')
    try {
      await rpc('wp_delete_guest', { p_id: guest.id })
      await onChanged()
    } catch (e) {
      setErr(e.message || String(e)); setBusy(false); setConfirming(false)
    }
  }

  if (editing) {
    return (
      <EditGuest guest={guest} accommodation={accommodation}
        onDone={() => { setEditing(false); onChanged() }} onCancel={() => setEditing(false)} />
    )
  }

  const name = [guest.first_name, guest.last_name].filter(Boolean).join(' ')

  return (
    <div className="guest">
      <div className="guest-main">
        <span className="guest-name">{name}</span>
        {guest.age_band !== 'adult' && <span className="chip">{AGE_LABEL[guest.age_band]}</span>}
        {guest.staying && (
          <span className="chip">
            {guest.staying_where ? 'Staying · ' + ACCOM_LABEL[guest.staying_where] : 'Staying'}
          </span>
        )}
        {guest.side && <span className="guest-side">{guest.side}</span>}
        {guest.access_needs && <div className="guest-note">{guest.access_needs}</div>}
        {err && <div className="guest-note err">{err}</div>}
      </div>
      <div className="guest-actions">
        {tables && !confirming && (
          <select className="table-pick" value={guest.table_id || ''} disabled={busy}
            aria-label={'Table for ' + name}
            onChange={(e) => moveTo(e.target.value)}>
            <option value="">Not seated</option>
            {tables.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        )}
        {confirming ? (
          <>
            <button className="btn-small danger" onClick={remove} disabled={busy}>
              {busy ? 'Removing…' : 'Remove'}
            </button>
            <button className="btn-small ghost" onClick={() => setConfirming(false)}>Keep</button>
          </>
        ) : (
          <>
            <button className="btn-small ghost" onClick={() => setEditing(true)}>Edit</button>
            <button className="btn-small ghost" onClick={() => setConfirming(true)}>Remove</button>
          </>
        )}
      </div>
    </div>
  )
}

// ── adding and editing ─────────────────────────────────────────────────────

function GuestFields({ v, set, accommodation }) {
  const options = accomOptions(accommodation)
  return (
    <>
      <div className="namegrid">
        <div>
          <label>First name</label>
          <input value={v.first_name} onChange={(e) => set('first_name', e.target.value)} autoFocus />
        </div>
        <div>
          <label>Last name</label>
          <input value={v.last_name} onChange={(e) => set('last_name', e.target.value)} />
        </div>
      </div>
      <div className="namegrid">
        <div>
          <label>Side <span className="opt">optional</span></label>
          <input value={v.side} onChange={(e) => set('side', e.target.value)} placeholder="Bride, groom, friends…" />
        </div>
        <div>
          <label>Age</label>
          <select value={v.age_band} onChange={(e) => set('age_band', e.target.value)}>
            <option value="adult">Adult</option>
            <option value="child">Child</option>
            <option value="baby">High chair</option>
          </select>
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={v.staying}
          onChange={(e) => { set('staying', e.target.checked); if (!e.target.checked) set('staying_where', '') }} />
        Staying overnight with us
      </label>
      {v.staying && options.length > 0 && (
        <>
          <label>Where are they staying?</label>
          <select value={v.staying_where || ''} onChange={(e) => set('staying_where', e.target.value)}>
            <option value="">Not decided yet</option>
            {options.map((k) => <option key={k} value={k}>{ACCOM_LABEL[k]}</option>)}
          </select>
        </>
      )}
      {v.staying && options.length === 0 && (
        <p className="hint">
          Once your accommodation is confirmed you'll be able to say who is in which.
        </p>
      )}
      <label>Anything we should know <span className="opt">optional</span></label>
      <input
        value={v.access_needs}
        onChange={(e) => set('access_needs', e.target.value)}
        placeholder="Step-free access, high chair, parking by the door…"
      />
    </>
  )
}

const BLANK = { first_name: '', last_name: '', side: '', age_band: 'adult', staying: false, staying_where: '', access_needs: '' }

function AddGuest({ list, accommodation, onDone, onCancel }) {
  const [v, setV] = useState(BLANK)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (k, val) => setV((p) => ({ ...p, [k]: val }))

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      await rpc('wp_add_guest', {
        p_list: list,
        p_first_name: v.first_name, p_last_name: v.last_name,
        p_side: v.side || null, p_age_band: v.age_band,
        p_staying: v.staying, p_access_needs: v.access_needs || null,
        p_staying_where: v.staying ? (v.staying_where || null) : null,
      })
      onDone()
    } catch (e2) {
      setErr(e2.code === 'no_name' ? 'Please give at least one name.' : (e2.message || String(e2)))
      setBusy(false)
    }
  }

  return (
    <form className="editor" onSubmit={submit}>
      <GuestFields v={v} set={set} accommodation={accommodation} />
      {err && <div className="alert alert-warn">{err}</div>}
      <div className="actions">
        <button className="btn-small" type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add'}</button>
        <button className="btn-small ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function EditGuest({ guest, accommodation, onDone, onCancel }) {
  const [v, setV] = useState({
    first_name: guest.first_name || '', last_name: guest.last_name || '',
    side: guest.side || '', age_band: guest.age_band || 'adult',
    staying: !!guest.staying, staying_where: guest.staying_where || '',
    access_needs: guest.access_needs || '',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (k, val) => setV((p) => ({ ...p, [k]: val }))

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      // Sent whole rather than as a diff: wp_update_guest coalesces nulls to the
      // existing value, so an emptied field would otherwise be impossible to
      // clear. Empty strings are meaningful here.
      await rpc('wp_update_guest', {
        p_id: guest.id,
        p_first_name: v.first_name, p_last_name: v.last_name,
        p_side: v.side, p_age_band: v.age_band,
        p_staying: v.staying, p_access_needs: v.access_needs,
        // Empty string, never null: null means "leave it alone", so a couple
        // going back to "not decided yet" would silently keep the old answer.
        p_staying_where: v.staying ? (v.staying_where || '') : '',
      })
      onDone()
    } catch (e2) {
      setErr(e2.message || String(e2)); setBusy(false)
    }
  }

  return (
    <form className="editor" onSubmit={submit}>
      <GuestFields v={v} set={set} accommodation={accommodation} />
      {err && <div className="alert alert-warn">{err}</div>}
      <div className="actions">
        <button className="btn-small" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button className="btn-small ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

// ── bulk import ────────────────────────────────────────────────────────────

function ImportGuests({ list, onDone, onCancel }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const parsed = parseGuests(text)

  async function readFile(e) {
    const f = e.target.files && e.target.files[0]
    if (!f) return
    setText(await f.text())
  }

  async function submit() {
    if (!parsed.rows.length) return
    setBusy(true); setErr('')
    try {
      await rpc('wp_import_guests', { p_list: list, p_rows: parsed.rows })
      onDone()
    } catch (e2) {
      setErr(e2.message || String(e2)); setBusy(false)
    }
  }

  return (
    <div className="editor">
      <label>Paste your list</label>
      <p className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        One person per line, or paste a whole column straight out of a spreadsheet.
        A CSV with headings works too — we'll pick up first name, last name, side and age.
      </p>
      <textarea
        rows={7}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'Ada Lovelace\nGrace Hopper\nAlan Turing'}
      />

      <div className="filerow">
        <label className="filebtn">
          Choose a CSV file
          <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={readFile} />
        </label>
      </div>

      {text.trim() !== '' && (
        parsed.rows.length > 0 ? (
          <div className="alert alert-ok">
            Found <strong>{parsed.rows.length}</strong>{' '}
            {parsed.rows.length === 1 ? 'person' : 'people'}
            {parsed.usedHeader && ' (using your column headings)'}.
            {' '}First few: {parsed.rows.slice(0, 3).map((r) => [r.first_name, r.last_name].filter(Boolean).join(' ')).join(', ')}
            {parsed.rows.length > 3 && '…'}
          </div>
        ) : (
          <div className="alert alert-warn">
            We couldn't find any names in that. Try one person per line.
          </div>
        )
      )}

      {err && <div className="alert alert-warn">{err}</div>}

      <div className="actions">
        <button className="btn-small" onClick={submit} disabled={busy || !parsed.rows.length}>
          {busy ? 'Adding…' : parsed.rows.length ? `Add ${parsed.rows.length}` : 'Add'}
        </button>
        <button className="btn-small ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
