import { useEffect, useState } from 'react'
import { rpc } from './supabase.js'

// The figures here are a copy of what Xero held when we last looked, so they can
// be a little behind. Two things follow from that, and both are deliberate:
// the page says when it last checked, and every invoice links out to Xero,
// which is always current. The numbers are the summary; the link is the truth.

function money(v, currency) {
  const n = Number(v || 0)
  try {
    return n.toLocaleString('en-GB', { style: 'currency', currency: currency || 'GBP' })
  } catch (e) {
    return '£' + n.toFixed(2)
  }
}

function fmtDate(iso) {
  if (!iso) return null
  const d = new Date(String(iso).length <= 10 ? iso + 'T12:00:00' : iso)
  if (isNaN(d)) return String(iso)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function Money() {
  const [data, setData] = useState(null)
  const [state, setState] = useState('loading')
  const [error, setError] = useState('')

  async function load() {
    try { setData(await rpc('wp_my_invoices')); setState('ready') }
    catch (e) { setError(e.message || String(e)); setState('error') }
  }
  useEffect(() => { load() }, [])

  if (state === 'loading') return <section className="card"><p className="muted">Loading…</p></section>
  if (state === 'error') {
    return (
      <section className="card">
        <h2>We couldn't load your invoices</h2>
        <div className="alert alert-warn" style={{ fontSize: 12 }}>{error}</div>
        <button className="btn" onClick={load}>Try again</button>
      </section>
    )
  }

  const invoices = data.invoices || []
  const outstanding = Number(data.outstanding || 0)
  const overdue = invoices.filter((i) => i.overdue)

  return (
    <>
      <section className="card">
        <h3>What is outstanding</h3>
        {invoices.length === 0 ? (
          <p className="muted" style={{ fontSize: 14, marginTop: 8 }}>
            Nothing here yet. Invoices will appear as we raise them.
          </p>
        ) : (
          <>
            <div className="hero" style={{ marginTop: 6 }}>
              <div className="couple" style={{ fontSize: 32 }}>{money(outstanding)}</div>
              <div className="when" style={{ color: outstanding > 0 ? undefined : 'var(--go)' }}>
                {outstanding > 0 ? 'still to pay' : 'nothing outstanding — thank you'}
              </div>
            </div>
            {overdue.length > 0 && (
              <div className="alert alert-warn" style={{ marginTop: 16 }}>
                {overdue.length === 1
                  ? 'One invoice is past its due date.'
                  : overdue.length + ' invoices are past their due date.'}
                {' '}If you have already paid, please ignore this — it can take a few days to show.
              </div>
            )}
          </>
        )}
      </section>

      {invoices.length > 0 && (
        <section className="card">
          <h3>Your invoices</h3>
          <div className="docs">
            {invoices.map((inv) => <Invoice key={inv.invoice_number || inv.online_url} inv={inv} />)}
          </div>
        </section>
      )}

      <section className="card">
        <h3>A note on timing</h3>
        <p className="muted" style={{ fontSize: 14 }}>
          Payments can take a few working days to appear here — bank transfers in
          particular. If you have just paid, it may still show as outstanding for a
          little while, and there is nothing to worry about.
        </p>
        <p className="muted" style={{ fontSize: 14, marginTop: 10 }}>
          Opening an invoice always shows its current state, even when the summary
          above has not caught up.
          {data.checked_at && <> These figures were last checked on <strong>{fmtDate(data.checked_at)}</strong>.</>}
        </p>
        <p className="muted" style={{ fontSize: 14, marginTop: 10 }}>
          If something looks wrong, tell us rather than paying it — we would far
          rather sort it out first.
        </p>
      </section>
    </>
  )
}

function Invoice({ inv }) {
  const paid = inv.status === 'PAID' || Number(inv.amount_due || 0) <= 0

  return (
    <div className="doc">
      <div className="doc-main">
        <div className="doc-name">
          {inv.invoice_number || 'Invoice'}
          {paid && <span className="chip" style={{ marginLeft: 8 }}>Paid</span>}
          {inv.overdue && <span className="chip" style={{ marginLeft: 8, background: '#fef2f2', color: '#b91c1c' }}>Overdue</span>}
        </div>
        <div className="doc-meta">
          {money(inv.total, inv.currency)}
          {!paid && Number(inv.amount_due || 0) > 0 && <> · {money(inv.amount_due, inv.currency)} due</>}
          {inv.due_date && <> · due {fmtDate(inv.due_date)}</>}
        </div>
      </div>
      {inv.online_url ? (
        // A link Xero gives us for this invoice. It opens the live document, so
        // it is right even when the summary above is a day or two behind.
        <a className="btn-small" href={inv.online_url} target="_blank" rel="noreferrer">
          {paid ? 'View' : 'View & pay'}
        </a>
      ) : (
        <span className="doc-meta">Link coming</span>
      )}
    </div>
  )
}
