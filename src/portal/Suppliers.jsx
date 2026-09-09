import { useEffect, useState } from 'react'
import { rpc } from './supabase.js'

// Components that render inputs live at module scope — see Guests.jsx.

export default function Suppliers() {
  const [data, setData] = useState(null)
  const [state, setState] = useState('loading')
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [browsing, setBrowsing] = useState(false)

  async function load() {
    try {
      setData(await rpc('wp_get_suppliers'))
      setState('ready')
    } catch (e) { setError(e.message || String(e)); setState('error') }
  }
  useEffect(() => { load() }, [])

  if (state === 'loading') return <section className="card"><p className="muted">Loading…</p></section>
  if (state === 'error') {
    return (
      <section className="card">
        <h2>We couldn't load your suppliers</h2>
        <div className="alert alert-warn" style={{ fontSize: 12 }}>{error}</div>
        <button className="btn" onClick={load}>Try again</button>
      </section>
    )
  }

  const labelOf = (slug) => (data.categories.find((c) => c.slug === slug) || {}).label || slug
  const chosenIds = new Set(data.chosen.map((c) => c.supplier_id))
  const available = data.directory.filter((d) => !chosenIds.has(d.id))

  return (
    <>
      <section className="card">
        <div className="list-head">
          <div>
            <h3 style={{ marginBottom: 4 }}>Your suppliers</h3>
            <p className="muted" style={{ fontSize: 13 }}>
              Everyone coming to work on your day. Knowing who to expect means we can
              let them in, point them somewhere sensible, and check their paperwork
              well before the morning.
            </p>
          </div>
          <span className="count">{data.chosen.length}</span>
        </div>

        {data.chosen.length === 0 ? (
          <p className="muted" style={{ fontSize: 14, padding: '12px 0' }}>
            None added yet.
          </p>
        ) : (
          <div className="docs">
            {data.chosen.map((c) => (
              <Chosen key={c.id} chosen={c} label={labelOf(c.category)} onChanged={load} />
            ))}
          </div>
        )}

        {!adding && !browsing && (
          <div className="actions">
            <button className="btn-small" onClick={() => setBrowsing(true)}>
              Suppliers who know the Grain Store
            </button>
            <button className="btn-small ghost" onClick={() => setAdding(true)}>
              Add your own
            </button>
          </div>
        )}
      </section>

      {browsing && (
        <Directory
          available={available}
          labelOf={labelOf}
          onChanged={load}
          onClose={() => setBrowsing(false)}
        />
      )}

      {adding && (
        <section className="card">
          <h3>Add your own supplier</h3>
          <AddOwn
            categories={data.categories}
            onDone={() => { setAdding(false); load() }}
            onCancel={() => setAdding(false)}
          />
        </section>
      )}
    </>
  )
}

function Chosen({ chosen, label, onChanged }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // Offering a supplier to other couples. Deliberately worded as an offer,
  // because that is what it is: the Grain Store list is the venue's own
  // recommendation and every supplier on it has agreed to be there, so this
  // puts them in front of Hawthbush rather than straight onto the list.
  // Promising otherwise would be the easy thing to write and a lie.
  async function toggleShare(on) {
    setBusy(true); setErr('')
    try { await rpc('wp_offer_supplier', { p_id: chosen.supplier_id, p_share: on }); await onChanged() }
    catch (e) { setErr(e.message || String(e)) }
    finally { setBusy(false) }
  }

  async function remove() {
    setBusy(true); setErr('')
    try {
      await rpc('wp_unchoose_supplier', { p_id: chosen.id })
      await onChanged()
    } catch (e) { setErr(e.message || String(e)); setBusy(false); setConfirming(false) }
  }

  const bits = [chosen.contact_name, chosen.phone, chosen.email].filter(Boolean)

  return (
    <div className="doc">
      <div className="doc-main">
        <div className="doc-name">
          {chosen.name}
          {chosen.mine && <span className="chip" style={{ marginLeft: 8 }}>Yours</span>}
        </div>
        <div className="doc-meta">{label}{bits.length ? ' · ' + bits.join(' · ') : ''}</div>
        {chosen.website && (
          <div className="doc-meta">
            <a href={chosen.website.startsWith('http') ? chosen.website : 'https://' + chosen.website}
               target="_blank" rel="noreferrer">{chosen.website}</a>
          </div>
        )}
        {chosen.notes && <div className="doc-meta">{chosen.notes}</div>}
        {chosen.mine && (
          <label className="check" style={{ marginTop: 8, fontSize: 13 }}>
            <input type="checkbox" checked={!!chosen.shared} disabled={busy}
              onChange={(e) => toggleShare(e.target.checked)} />
            Happy for us to suggest them to other couples
          </label>
        )}
        {chosen.mine && chosen.shared && (
          <div className="doc-meta">
            Thank you — we will check with them before adding them to the list.
          </div>
        )}
        {err && <div className="doc-meta err">{err}</div>}
      </div>
      <div className="guest-actions">
        {confirming ? (
          <>
            <button className="btn-small danger" onClick={remove} disabled={busy}>Remove</button>
            <button className="btn-small ghost" onClick={() => setConfirming(false)}>Keep</button>
          </>
        ) : (
          <button className="btn-small ghost" onClick={() => setConfirming(true)}>Remove</button>
        )}
      </div>
    </div>
  )
}

function Directory({ available, labelOf, onChanged, onClose }) {
  const [busyId, setBusyId] = useState(null)
  const [err, setErr] = useState('')

  async function choose(id) {
    setBusyId(id); setErr('')
    try {
      await rpc('wp_choose_supplier', { p_supplier_id: id })
      await onChanged()
    } catch (e) { setErr(e.message || String(e)) } finally { setBusyId(null) }
  }

  const groups = []
  for (const s of available) {
    let g = groups.find((x) => x.slug === s.category)
    if (!g) { g = { slug: s.category, items: [] }; groups.push(g) }
    g.items.push(s)
  }

  return (
    <section className="card">
      <div className="list-head">
        <div>
          <h3 style={{ marginBottom: 4 }}>Suppliers who know the Grain Store</h3>
          <p className="muted" style={{ fontSize: 13 }}>
            People we have worked with here before. You are under no obligation to
            use any of them — it is a starting point, not a list you must pick from.
          </p>
        </div>
        <button className="btn-small ghost" onClick={onClose}>Close</button>
      </div>

      {err && <div className="alert alert-warn">{err}</div>}

      {groups.length === 0 ? (
        <p className="muted" style={{ fontSize: 14, padding: '12px 0' }}>
          Nothing left to add from our list — you already have them all.
        </p>
      ) : (
        groups.map((g) => (
          <div key={g.slug} style={{ marginTop: 16 }}>
            <h3 style={{ marginBottom: 8 }}>{labelOf(g.slug)}</h3>
            <div className="docs">
              {g.items.map((s) => (
                <div className="doc" key={s.id}>
                  <div className="doc-main">
                    <div className="doc-name">
                      {s.name}
                      {/* An aggregate, and the most useful line on the page —
                          "eleven weddings here have used them" beats any blurb.
                          It says nothing about any individual wedding, which is
                          why it is allowed through a payload that otherwise
                          withholds insurance status and internal notes. */}
                      {s.used_by > 0 && (
                        <span className="chip" style={{ marginLeft: 8 }}>
                          {s.used_by} wedding{s.used_by === 1 ? '' : 's'}
                        </span>
                      )}
                    </div>
                    {s.blurb && <div className="doc-meta">{s.blurb}</div>}
                    {s.website && (
                      <div className="doc-meta">
                        <a href={s.website.startsWith('http') ? s.website : 'https://' + s.website}
                           target="_blank" rel="noreferrer">{s.website}</a>
                      </div>
                    )}
                  </div>
                  <button className="btn-small" onClick={() => choose(s.id)} disabled={busyId === s.id}>
                    {busyId === s.id ? 'Adding…' : 'Add'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </section>
  )
}

const BLANK_SUP = { name: '', category: '', contact_name: '', email: '', phone: '', website: '', notes: '' }

function AddOwn({ categories, onDone, onCancel }) {
  const [v, setV] = useState(BLANK_SUP)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (k, val) => setV((p) => ({ ...p, [k]: val }))

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      await rpc('wp_add_own_supplier', {
        p_name: v.name, p_category: v.category,
        p_contact_name: v.contact_name || null, p_email: v.email || null,
        p_phone: v.phone || null, p_website: v.website || null, p_notes: v.notes || null,
      })
      onDone()
    } catch (e2) {
      setErr(
        e2.code === 'no_name' ? 'Give them a name first.'
        : e2.code === 'bad_category' ? 'Pick what kind of supplier they are.'
        : (e2.message || String(e2))
      )
      setBusy(false)
    }
  }

  return (
    <form className="editor" onSubmit={submit}>
      <div className="namegrid">
        <div>
          <label>Name</label>
          <input value={v.name} onChange={(e) => set('name', e.target.value)} autoFocus placeholder="Who are they?" />
        </div>
        <div>
          <label>What do they do</label>
          <select value={v.category} onChange={(e) => set('category', e.target.value)}>
            <option value="">—</option>
            {categories.map((c) => <option key={c.slug} value={c.slug}>{c.label}</option>)}
          </select>
        </div>
      </div>
      <div className="namegrid">
        <div>
          <label>Contact <span className="opt">optional</span></label>
          <input value={v.contact_name} onChange={(e) => set('contact_name', e.target.value)} />
        </div>
        <div>
          <label>Phone <span className="opt">optional</span></label>
          <input value={v.phone} onChange={(e) => set('phone', e.target.value)} />
        </div>
      </div>
      <div className="namegrid">
        <div>
          <label>Email <span className="opt">optional</span></label>
          <input type="email" value={v.email} onChange={(e) => set('email', e.target.value)} />
        </div>
        <div>
          <label>Website <span className="opt">optional</span></label>
          <input value={v.website} onChange={(e) => set('website', e.target.value)} />
        </div>
      </div>
      <label>Anything we should know <span className="opt">optional</span></label>
      <input value={v.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Arriving early, needs power, that sort of thing" />

      {err && <div className="alert alert-warn">{err}</div>}
      <div className="actions">
        <button className="btn-small" type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add'}</button>
        <button className="btn-small ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}
