import { useEffect, useState } from 'react'
import { rpc } from './supabase.js'

// Food, where Hawthbush caters — wakes and parties. The menus we offer
// everyone (set in Portal settings), priced per head, plus any menu we have
// written for this event alone — that one is theirs and nobody else sees it.
// Then the numbers, and anything the kitchen needs to know.
//
// Components that render inputs live at module scope — see Guests.jsx.

function money(v) {
  if (v === null || v === undefined || v === '') return null
  return '£' + Number(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
// Prices are held inc VAT throughout — the VAT is only ever worked out for Xero.
function incVat(v) {
  return v === null || v === undefined || v === '' ? null : Number(v)
}
const hhmm = (t) => (t ? String(t).slice(0, 5) : '')

export default function Food({ onGo }) {
  const [data, setData] = useState(null)
  const [state, setState] = useState('loading')
  const [error, setError] = useState('')

  async function load() {
    try { setData(await rpc('wp_get_food')); setState('ready') }
    catch (e) { setError(e.message || String(e)); setState('error') }
  }
  useEffect(() => { load() }, [])

  if (state === 'loading') return <section className="card"><p className="muted">Loading…</p></section>
  if (state === 'error') {
    return (
      <section className="card">
        <h2>We couldn't load the food</h2>
        <div className="alert alert-warn" style={{ fontSize: 12 }}>{error}</div>
        <button className="btn" onClick={load}>Try again</button>
      </section>
    )
  }

  // Not keyed on the saved data: remounting after a save would throw away the
  // "Saved" message, and the form already holds what was saved.
  return <FoodForm data={data} onSaved={load} onGo={onGo} />
}

function FoodForm({ data, onSaved, onGo }) {
  const c = data.choice || {}
  const [pkg, setPkg] = useState(c.package_id || '')
  const [numbers, setNumbers] = useState(c.numbers ?? data.guest_numbers ?? '')
  const [serve, setServe] = useState(hhmm(c.serve_time))
  const [dietary, setDietary] = useState(c.dietary || '')
  const [notes, setNotes] = useState(c.notes || '')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState('')

  const packages = data.packages || []
  // The package they chose may have been retired since; it still shows as
  // theirs, at the price they chose it at.
  const retired = c.package_id && !packages.some((p) => p.id === c.package_id)
  const chosen = packages.find((p) => p.id === pkg)
  const pp = chosen
    ? (pkg === c.package_id && c.price_pp !== null && c.price_pp !== undefined
        ? incVat(c.price_pp, c.vat_rate)
        : (chosen.price_on_request ? null : incVat(chosen.price_pp_inc_vat, chosen.vat_rate)))
    : (retired && pkg === c.package_id ? incVat(c.price_pp, c.vat_rate) : null)
  const n = parseInt(numbers, 10)

  async function save(e) {
    e.preventDefault()
    setBusy(true); setErr(''); setSaved(false)
    try {
      await rpc('wp_save_food', {
        p_package_id: pkg || null,
        p_numbers: Number.isFinite(n) ? n : null,
        p_serve_time: serve || null,
        p_dietary: dietary, p_notes: notes,
      })
      setSaved(true)
      await onSaved()
    } catch (e2) {
      setErr(e2.code === 'not_available' ? 'That package is no longer offered — please choose another.' : (e2.message || String(e2)))
    } finally { setBusy(false) }
  }

  return (
    <form onSubmit={save}>
      <section className="card">
        <h3>Choose your food</h3>
        {packages.length === 0 && !retired ? (
          <p className="muted" style={{ fontSize: 14 }}>
            We are putting our menus together — they will appear here shortly. Talk to us in
            the meantime if you would like to know more.
          </p>
        ) : (
          <div className="choice-list">
            {retired && (
              <label className={'choice' + (pkg === c.package_id ? ' is-on' : '')}>
                <input type="radio" name="pkg" checked={pkg === c.package_id} onChange={() => setPkg(c.package_id)} />
                <span>
                  <span className="choice-name">{c.package_name}</span>
                  <span className="choice-meta">Your choice{c.price_pp !== null ? ' · ' + money(incVat(c.price_pp, c.vat_rate)) + ' a head inc VAT' : ''}</span>
                </span>
              </label>
            )}
            {packages.map((p) => (
              <label key={p.id} className={'choice' + (pkg === p.id ? ' is-on' : '')}>
                <input type="radio" name="pkg" checked={pkg === p.id} onChange={() => setPkg(p.id)} />
                <span>
                  <span className="choice-name">{p.name}{p.bespoke && <span className="chip" style={{ marginLeft: 8 }}>Made for you</span>}</span>
                  <span className="choice-meta">
                    {p.price_on_request ? 'Price on request' : money(incVat(p.price_pp_inc_vat, p.vat_rate)) + ' a head inc VAT'}
                  </span>
                  {p.description && <span className="choice-desc">{p.description}</span>}
                </span>
              </label>
            ))}
          </div>
        )}
        <p className="muted" style={{ fontSize: 13, marginTop: 14 }}>
          Tea and coffee come with every menu. The bar is a pay bar — your guests buy
          their own drinks. If you would like to put money behind it, see the evening bar page.
        </p>
        {onGo && <div className="actions"><button type="button" className="btn-small ghost" onClick={() => onGo('bar')}>The evening bar</button></div>}
      </section>

      <section className="card">
        <h3>The details</h3>
        <div className="namegrid">
          <div>
            <label>How many people</label>
            <input type="number" min="0" max="2000" value={numbers} onChange={(e) => setNumbers(e.target.value)} />
            {data.guest_numbers !== null && data.guest_numbers !== undefined && Number(numbers) !== data.guest_numbers && (
              <p className="hint">Your guest numbers say {data.guest_numbers}.</p>
            )}
          </div>
          <div>
            <label>Roughly when to serve <span className="opt">optional</span></label>
            <input type="time" value={serve} onChange={(e) => setServe(e.target.value)} />
          </div>
        </div>
        <label>Dietary needs and allergies <span className="opt">optional</span></label>
        <textarea rows="3" value={dietary} onChange={(e) => setDietary(e.target.value)}
          placeholder="For example: 3 vegetarian, 1 coeliac, 1 nut allergy" />
        <p className="hint">Numbers are enough — we don't need names.</p>
        <label style={{ marginTop: 12 }}>Anything else <span className="opt">optional</span></label>
        <textarea rows="2" value={notes} onChange={(e) => setNotes(e.target.value)} />

        {pp !== null && Number.isFinite(n) && n > 0 && (
          <div className="totals-line">
            Roughly <strong>{money(pp * n)}</strong> inc VAT
            <span className="dot">·</span>{n} × {money(pp)}
          </div>
        )}
        {err && <div className="alert alert-warn">{err}</div>}
        {saved && !err && <div className="alert alert-ok">Saved — thank you.</div>}
        <div className="actions">
          <button className="btn-small" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
          The figure is a guide. Your invoice is the final word.
        </p>
      </section>
    </form>
  )
}
