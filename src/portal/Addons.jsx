import { useEffect, useState } from 'react'
import { rpc } from './supabase.js'

// Extras a client can ask for. Asking is a request, not a purchase: we confirm
// it and it goes on an invoice in the ordinary way. Nothing is charged here.
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

const STATUS = {
  requested: { text: 'Asked for', cls: '' },
  approved:  { text: 'Confirmed', cls: 'chip-go' },
  declined:  { text: 'Not possible', cls: 'chip-warn' },
}

export default function Addons() {
  const [data, setData] = useState(null)
  const [state, setState] = useState('loading')
  const [error, setError] = useState('')

  async function load() {
    try { setData(await rpc('wp_get_addons')); setState('ready') }
    catch (e) { setError(e.message || String(e)); setState('error') }
  }
  useEffect(() => { load() }, [])

  if (state === 'loading') return <section className="card"><p className="muted">Loading…</p></section>
  if (state === 'error') {
    return (
      <section className="card">
        <h2>We couldn't load the extras</h2>
        <div className="alert alert-warn" style={{ fontSize: 12 }}>{error}</div>
        <button className="btn" onClick={load}>Try again</button>
      </section>
    )
  }

  const requests = data.requests || []
  const open = {}
  for (const r of requests) if (r.status === 'requested' && r.addon_id) open[r.addon_id] = r

  return (
    <>
      {requests.length > 0 && (
        <section className="card">
          <h3>What you have asked for</h3>
          <div className="docs">
            {requests.map((r) => <RequestRow key={r.id} r={r} onChanged={load} />)}
          </div>
          <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>
            Prices include VAT. Confirmed extras go on your next invoice.
          </p>
        </section>
      )}

      <section className="card">
        <h3>Extras you can add</h3>
        {(data.catalogue || []).length === 0 ? (
          <p className="muted" style={{ fontSize: 14 }}>Nothing to add just now. If you have something in mind, ask us.</p>
        ) : (
          <div className="docs">
            {data.catalogue.map((a) => <AddonRow key={a.id} a={a} open={open[a.id]} onChanged={load} />)}
          </div>
        )}
      </section>
    </>
  )
}

function RequestRow({ r, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const st = STATUS[r.status] || STATUS.requested
  const each = incVat(r.unit_price, r.vat_rate)

  async function cancel() {
    setBusy(true); setErr('')
    try { await rpc('wp_cancel_addon', { p_id: r.id }); await onChanged() }
    catch (e) { setErr(e.code === 'already_decided' ? 'We have already confirmed this — talk to us to change it.' : (e.message || String(e))); setBusy(false) }
  }

  return (
    <div className="doc">
      <div className="doc-main">
        <div className="doc-name">
          {r.name}{r.qty > 1 && <> × {r.qty}</>}
          <span className={'chip ' + st.cls} style={{ marginLeft: 8 }}>{st.text}</span>
        </div>
        <div className="doc-meta">
          {each !== null ? money(each * r.qty) + (r.qty > 1 ? ' (' + money(each) + ' ' + r.unit_label + ')' : '') : 'We will confirm the price'}
          {r.note && <> · {r.note}</>}
        </div>
        {r.staff_note && <div className="doc-meta">From us: {r.staff_note}</div>}
        {err && <div className="doc-meta err">{err}</div>}
      </div>
      {r.status === 'requested' && (
        <button className="btn-small ghost" onClick={cancel} disabled={busy}>Withdraw</button>
      )}
    </div>
  )
}

function AddonRow({ a, open, onChanged }) {
  const [asking, setAsking] = useState(false)
  const [qty, setQty] = useState(open ? open.qty : 1)
  const [note, setNote] = useState(open && open.note ? open.note : '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const each = a.price_on_request ? null : incVat(a.price_inc_vat, a.vat_rate)

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      await rpc('wp_request_addon', { p_addon_id: a.id, p_qty: Number(qty) || 1, p_note: note || null })
      setAsking(false); await onChanged()
    } catch (e2) { setErr(e2.code === 'not_available' ? 'That is no longer available.' : (e2.message || String(e2))) }
    finally { setBusy(false) }
  }

  return (
    <div className="doc" style={{ flexWrap: 'wrap' }}>
      <div className="doc-main">
        <div className="doc-name">{a.name}</div>
        <div className="doc-meta">
          {each !== null ? money(each) + ' ' + a.unit_label + ' inc VAT' : 'Price on request'}
          {a.description && <> · {a.description}</>}
        </div>
      </div>
      {!asking && (
        <button className="btn-small" onClick={() => setAsking(true)}>{open ? 'Change' : 'Ask for this'}</button>
      )}
      {asking && (
        <form className="editor" onSubmit={submit} style={{ flexBasis: '100%', marginTop: 4 }}>
          {a.max_qty > 1 && (
            <>
              <label>How many <span className="opt">up to {a.max_qty}</span></label>
              <input type="number" min="1" max={a.max_qty} value={qty} onChange={(e) => setQty(e.target.value)} />
            </>
          )}
          <label style={{ marginTop: a.max_qty > 1 ? 12 : 0 }}>Anything we should know <span className="opt">optional</span></label>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
          {err && <div className="alert alert-warn">{err}</div>}
          <div className="actions">
            <button className="btn-small" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send to us'}</button>
            <button className="btn-small ghost" type="button" onClick={() => setAsking(false)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  )
}
