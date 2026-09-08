import { useEffect, useState } from 'react'
import { supabase, rpc } from './supabase.js'

function fmt(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d)) return null
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

export default function Contract() {
  const [data, setData] = useState(null)
  const [state, setState] = useState('loading')
  const [error, setError] = useState('')

  async function load() {
    try {
      setData(await rpc('wp_my_documents'))
      setState('ready')
    } catch (e) {
      setError(e.message || String(e)); setState('error')
    }
  }
  useEffect(() => { load() }, [])

  if (state === 'loading') return <section className="card"><p className="muted">Loading…</p></section>
  if (state === 'error') {
    return (
      <section className="card">
        <h2>We couldn't load your paperwork</h2>
        <div className="alert alert-warn" style={{ fontSize: 12 }}>{error}</div>
        <button className="btn" onClick={load}>Try again</button>
      </section>
    )
  }

  const docs = data.documents || []
  const contract = data.contract

  return (
    <>
      <section className="card">
        <h3>Your booking form</h3>

        {docs.length > 0 ? (
          <div className="docs">
            {docs.map((d) => <Doc key={d.path} doc={d} />)}
          </div>
        ) : (
          // The nightly status check deliberately does not file the signed PDF —
          // it is applied by hand from the review panel. So between signing and
          // that review there is a real gap, and it should read as a wait
          // rather than as a fault.
          <p className="muted" style={{ fontSize: 14, marginTop: 10 }}>
            {contract && contract.status === 'Completed'
              ? 'Thank you for signing. Your copy will appear here shortly, once we have filed it.'
              : contract
                ? 'Your booking form is with you for signature. Once it is signed and filed, your copy will appear here.'
                : 'Nothing filed here yet. Your signed booking form will appear once it is done.'}
          </p>
        )}

        {contract && contract.sent_at && (
          <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>
            Sent {fmt(contract.sent_at)}
            {contract.status ? ' · ' + contract.status : ''}
          </p>
        )}
      </section>

      <section className="card">
        <h3>Terms and conditions</h3>
        <p className="muted" style={{ fontSize: 14 }}>
          The terms that go with your booking.
        </p>
        <div className="actions">
          <a className="btn-small ghost" href="/terms.html" target="_blank" rel="noreferrer">
            Read the terms
          </a>
        </div>
      </section>

      <section className="card">
        <p className="muted" style={{ fontSize: 13 }}>
          Anything look wrong? Tell us rather than working around it — it is much
          easier to fix now than in the last fortnight.
        </p>
      </section>
    </>
  )
}

function Doc({ doc }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // Links are minted on demand and last five minutes. Nothing durable is put
  // on the page, so a shared screenshot does not hand over the document.
  async function open() {
    setBusy(true); setErr('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Please sign in again.')

      const res = await fetch('/.netlify/functions/portal-file', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + session.access_token,
        },
        body: JSON.stringify({ path: doc.path }),
      })
      // res.ok checked before anything is believed — the house rule.
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'We could not open that just now.')
      }
      const { url } = await res.json()
      window.open(url, '_blank', 'noopener')
    } catch (e) {
      setErr(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="doc">
      <div className="doc-main">
        <div className="doc-name">{doc.doc_type || doc.name}</div>
        <div className="doc-meta">
          {doc.name}
          {doc.uploaded_at && ' · ' + (fmt(doc.uploaded_at) || '')}
        </div>
        {err && <div className="doc-meta err">{err}</div>}
      </div>
      <button className="btn-small" onClick={open} disabled={busy}>
        {busy ? 'Opening…' : 'Open'}
      </button>
    </div>
  )
}
