import { useEffect, useState } from 'react'
import { rpc } from './supabase.js'

// The inspiration board.
//
// A LINK, NOT AN EMBED, and deliberately. Pinterest's board widget works by
// loading their JavaScript into this page — and this page holds a guest list,
// names, access needs and a live session. A third-party script here could read
// all of it. That is a real trade for a prettier tab, and not one to make
// quietly, so the board opens in its own window instead.
//
// The URL is checked server-side against Pinterest's own domains before it is
// stored. It gets rendered as a link that staff click from the admin side, so
// an unchecked one would be somewhere to hang a phishing page under the venue's
// branding. See wp_set_pinterest().

export default function Pinterest() {
  const [url, setUrl] = useState(null)          // null = still loading
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function load() {
    try {
      const r = await rpc('wp_get_pinterest')
      setUrl(r.url || '')
      setDraft(r.url || '')
    } catch (e) { setErr(e.message || String(e)); setUrl('') }
  }
  useEffect(() => { load() }, [])

  async function save(e) {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      await rpc('wp_set_pinterest', { p_url: draft })
      setEditing(false)
      await load()
    } catch (e2) {
      setErr(e2.code === 'not_a_pinterest_link'
        ? 'That does not look like a Pinterest link. It should start with https://www.pinterest.co.uk/ or https://pinterest.com/.'
        : (e2.message || String(e2)))
    } finally { setBusy(false) }
  }

  if (url === null) return <section className="card"><p className="muted">Loading…</p></section>

  return (
    <section className="card">
      <h3>Inspiration</h3>
      <p className="muted" style={{ fontSize: 14 }}>
        If you are collecting ideas on a Pinterest board, put the link here and we
        will see it too. It saves describing a colour over email, and it is often
        the quickest way to show us what you are after.
      </p>

      {url && !editing && (
        <>
          <div className="actions" style={{ marginTop: 16 }}>
            <a className="btn" href={url} target="_blank" rel="noopener noreferrer">
              Open your board
            </a>
            <button className="btn-small ghost" onClick={() => { setDraft(url); setEditing(true) }}>
              Change
            </button>
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 12, wordBreak: 'break-all' }}>{url}</p>
        </>
      )}

      {(!url || editing) && (
        <form onSubmit={save} style={{ marginTop: 16 }}>
          <label>Your board's address</label>
          <input
            type="url"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="https://www.pinterest.co.uk/yourname/our-wedding/"
            autoFocus={editing}
          />
          <p className="hint">
            Open your board in Pinterest and copy what is in the address bar. If the
            board is secret, only people you have shared it with will be able to open
            it — including us.
          </p>
          {err && <div className="alert alert-warn">{err}</div>}
          <div className="actions">
            <button className="btn-small" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            {url && (
              <>
                <button className="btn-small ghost" type="button" onClick={() => { setEditing(false); setDraft(url); setErr('') }}>
                  Cancel
                </button>
                <button className="btn-small ghost" type="button" disabled={busy}
                  onClick={() => { setDraft(''); setBusy(true); rpc('wp_set_pinterest', { p_url: '' })
                    .then(() => { setEditing(false); return load() })
                    .catch((e2) => setErr(e2.message || String(e2)))
                    .finally(() => setBusy(false)) }}>
                  Remove
                </button>
              </>
            )}
          </div>
        </form>
      )}
    </section>
  )
}
