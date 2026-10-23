import { useEffect, useState } from 'react'
import { rpc, isMissingFunction } from './supabase.js'

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

  const [plan, setPlan] = useState(null)

  async function load() {
    try { setData(await rpc('wp_my_invoices')); setState('ready') }
    catch (e) { setError(e.message || String(e)); setState('error') }
    // The payments still to come. Optional: if it will not load, the invoices
    // above still stand on their own, so it is simply left out.
    try { setPlan(await rpc('wp_my_statement')) }
    catch (e) { if (!isMissingFunction(e)) console.warn('statement: ' + (e.message || e)); setPlan(null) }
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
                {outstanding > 0 ? 'still to pay'
                  : plan && (plan.schedule || []).length ? 'nothing due right now — thank you'
                  : 'nothing outstanding — thank you'}
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

      {plan && (plan.schedule || []).length > 0 && <ToCome plan={plan} />}

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

// One word for where an invoice stands. Overdue outranks part paid: a part
// payment on a late invoice is still late.
export function invoiceStatus(inv, paid) {
  if (paid) return { text: 'Paid', cls: 'chip-go' }
  if (inv.overdue) return { text: 'Overdue', cls: 'chip-bad' }
  if (Number(inv.amount_paid || 0) > 0) return { text: 'Part paid', cls: '' }
  return { text: 'Due', cls: '' }
}

function Invoice({ inv }) {
  const paid = inv.status === 'PAID' || Number(inv.amount_due || 0) <= 0
  const st = invoiceStatus(inv, paid)

  return (
    <div className="doc">
      <div className="doc-main">
        <div className="doc-name">
          {inv.invoice_number || 'Invoice'}
          <span className={'chip ' + st.cls} style={{ marginLeft: 8 }}>{st.text}</span>
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

// What is still to come, as the venue's diary has it today. Everything here is
// provisional: the second and final invoices move with your numbers and with
// anything added along the way, so the invoice itself is the figure to pay.
function ToCome({ plan }) {
  const rows = plan.schedule || []
  const total = rows.filter((r) => !r.refundable).reduce((a, r) => a + Number(r.amount || 0), 0)
  return (
    <section className="card">
      <h3>Payments to come</h3>
      <p className="muted" style={{ fontSize: 14 }}>
        A guide to what is still to be invoiced, as things stand today. These figures
        are <strong>provisional</strong> — they are subject to your final numbers and
        to any additions, and will change if those do. Please pay from the invoice
        when it arrives rather than from this list.
      </p>
      <div className="docs" style={{ marginTop: 10 }}>
        {rows.map((r, i) => <PlanRow key={i} r={r} />)}
      </div>
      {rows.filter((r) => !r.refundable).length > 1 && (
        <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
          Still to be invoiced, provisionally: <strong>{money(total)}</strong>
        </p>
      )}
    </section>
  )
}

function PlanRow({ r }) {
  const [open, setOpen] = useState(false)
  const lines = r.lines || []
  return (
    <div className="doc" style={{ flexWrap: 'wrap' }}>
      <div className="doc-main">
        <div className="doc-name">
          {r.label}
          <span className="chip" style={{ marginLeft: 8 }}>{r.refundable ? 'Refundable' : 'Provisional'}</span>
        </div>
        <div className="doc-meta">
          {money(r.amount)}
          {r.due_on && <> · {r.refundable ? 'due by around ' : 'invoiced around '}{fmtDate(r.due_on)}</>}
        </div>
      </div>
      {lines.length > 0 && (
        <button type="button" className="btn-small ghost" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'What it is'}</button>
      )}
      {open && (
        <div style={{ flexBasis: '100%', fontSize: 13, marginTop: 6 }}>
          {lines.map((l, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '2px 0' }}>
              <span className="muted">{l.desc}</span><span>{money(l.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
