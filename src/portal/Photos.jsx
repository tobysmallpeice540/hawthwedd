import { useEffect, useState } from 'react'
import { rpc, isMissingFunction } from './supabase.js'

// Photos and films, as LINKS — a slideshow, a shared album, a film on YouTube
// or Vimeo, a Dropbox or WeTransfer folder. The files stay wherever the client
// keeps them, so we are never the ones holding them. (Uploading the files
// themselves is the separate Uploads section, where the venue offers it.)
//
// Components that render inputs live at module scope — see Guests.jsx.

const LINK = /^https:\/\/[^\s/]+\.[^\s]+$/

export default function Photos() {
  const [data, setData] = useState(null)
  const [state, setState] = useState('loading')
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)

  async function load() {
    try { setData(await rpc('wp_get_media_links')); setState('ready') }
    catch (e) { setError(e.message || String(e)); setState(isMissingFunction(e) ? 'absent' : 'error') }
  }
  useEffect(() => { load() }, [])

  if (state === 'loading') return <section className="card"><p className="muted">Loading…</p></section>
  if (state === 'absent') {
    return <section className="card"><h3>Photos &amp; films</h3><p className="muted">This page is on its way — please look again shortly.</p></section>
  }
  if (state === 'error') {
    return (
      <section className="card">
        <h2>We couldn't load your links</h2>
        <div className="alert alert-warn" style={{ fontSize: 12 }}>{error}</div>
        <button className="btn" onClick={load}>Try again</button>
      </section>
    )
  }

  return (
    <section className="card">
      <h3>Photos &amp; films</h3>
      <p className="muted" style={{ fontSize: 14 }}>
        Send us a link to your slideshow, photos or film — a shared album, YouTube or Vimeo,
        Dropbox, Google Drive, WeTransfer or similar. Say what each one is for, and make
        sure anyone with the link can open it.
      </p>
      <p className="hint">
        Please check each link plays or opens on a computer other than your own before the day.
        We play what is at the link; we don't keep a copy.
      </p>

      {data.links.length > 0 && (
        <div className="guests">
          {data.links.map((it) => <LinkRow key={it.id} item={it} onChanged={load} />)}
        </div>
      )}
      {data.links.length === 0 && !adding && (
        <p className="muted" style={{ fontSize: 14, padding: '10px 0' }}>No links yet.</p>
      )}

      {adding
        ? <LinkForm item={null} onDone={() => { setAdding(false); load() }} onCancel={() => setAdding(false)} />
        : <div className="actions"><button className="btn-small" onClick={() => setAdding(true)}>Add a link</button></div>}
    </section>
  )
}

function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch (e) { return 'link' }
}

function LinkRow({ item, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function remove() {
    setBusy(true); setErr('')
    try { await rpc('wp_delete_media_link', { p_id: item.id }); await onChanged() }
    catch (e) { setErr(e.message || String(e)); setBusy(false); setConfirming(false) }
  }

  if (editing) {
    return <LinkForm item={item} onDone={() => { setEditing(false); onChanged() }} onCancel={() => setEditing(false)} />
  }

  return (
    <div className="guest">
      <div className="guest-main">
        <span className="guest-name">{item.description}</span>
        <a className="chip chip-go link-chip" href={item.url} target="_blank" rel="noopener noreferrer">{host(item.url)} ↗</a>
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
            <button className="btn-small ghost" onClick={() => setConfirming(true)}>Remove</button>
          </>
        )}
      </div>
    </div>
  )
}

function LinkForm({ item, onDone, onCancel }) {
  const [desc, setDesc] = useState(item ? item.description : '')
  const [url, setUrl] = useState(item ? item.url : '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const link = url.trim()
  const looksWrong = link && !LINK.test(link)

  async function submit(e) {
    e.preventDefault()
    if (!link) { setErr('Paste the link first.'); return }
    if (looksWrong) { setErr('That does not look like a web link — it should start with https://'); return }
    setBusy(true); setErr('')
    try {
      await rpc('wp_save_media_link', { p_id: item ? item.id : null, p_description: desc, p_url: link })
      onDone()
    } catch (e2) {
      setErr(e2.code === 'bad_link' ? 'That does not look like a web link — it should start with https://'
        : e2.code === 'no_description' ? 'Say what it is — "Slideshow during the meal", "Film for the screen"…'
        : e2.code === 'too_many' ? 'That is a lot of links — could some go in one shared folder?'
        : (e2.message || String(e2)))
      setBusy(false)
    }
  }

  return (
    <form className="editor" onSubmit={submit}>
      <label>What it is</label>
      <input value={desc} onChange={(e) => setDesc(e.target.value)} autoFocus={!item}
        placeholder="Slideshow during the meal, film for the screen…" />
      <label style={{ marginTop: 12 }}>The link</label>
      <input value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url"
        placeholder="https://…" />
      {looksWrong && <p className="hint" style={{ color: 'var(--warn)' }}>This doesn't look like a web link.</p>}
      {err && <div className="alert alert-warn">{err}</div>}
      <div className="actions">
        <button className="btn-small" type="submit" disabled={busy}>{busy ? 'Saving…' : (item ? 'Save' : 'Add')}</button>
        <button className="btn-small ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}
