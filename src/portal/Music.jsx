import { useEffect, useState } from 'react'
import { rpc } from './supabase.js'

// Music: a description and a Spotify link, as many as they like. It starts with
// the moments that matter for the kind of event (arrival, first dance,
// dancefloor for a wedding) with the links left blank for them to fill in.
//
// Spotify only — it is what the venue plays from. The database refuses other
// links too, but saying so up front saves somebody pasting an Apple Music link
// and wondering why it will not save.
//
// Components that render inputs live at module scope — see Guests.jsx.

const SPOTIFY = /^https:\/\/(open\.spotify\.com|spotify\.link)\/[A-Za-z0-9/_?=&%.-]+$/

export default function Music() {
  const [data, setData] = useState(null)
  const [state, setState] = useState('loading')
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)

  async function load() {
    try { setData(await rpc('wp_get_music')); setState('ready') }
    catch (e) { setError(e.message || String(e)); setState('error') }
  }
  useEffect(() => { load() }, [])

  if (state === 'loading') return <section className="card"><p className="muted">Loading…</p></section>
  if (state === 'error') {
    return (
      <section className="card">
        <h2>We couldn't load your music</h2>
        <div className="alert alert-warn" style={{ fontSize: 12 }}>{error}</div>
        <button className="btn" onClick={load}>Try again</button>
      </section>
    )
  }

  return (
    <section className="card">
      <h3>Your music</h3>
      <p className="muted" style={{ fontSize: 14 }}>
        Add a Spotify link for each moment — a playlist or a single song. Add anything
        else you would like us to know, with or without a link.
      </p>
      <div className="alert alert-warn" style={{ fontSize: 13 }}>
        Links must be <strong>Spotify</strong>. We can't play Apple Music, Amazon Music,
        YouTube or other links. In Spotify, use <em>Share → Copy link</em> and paste it here.
      </div>

      {data.items.length > 0 && (
        <div className="guests">
          {data.items.map((it) => <MusicRow key={it.id} item={it} onChanged={load} />)}
        </div>
      )}

      {adding
        ? <MusicForm item={null} onDone={() => { setAdding(false); load() }} onCancel={() => setAdding(false)} />
        : <div className="actions"><button className="btn-small" onClick={() => setAdding(true)}>Add a line</button></div>}
    </section>
  )
}

function MusicRow({ item, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function remove() {
    setBusy(true); setErr('')
    try { await rpc('wp_delete_music_item', { p_id: item.id }); await onChanged() }
    catch (e) { setErr(e.message || String(e)); setBusy(false); setConfirming(false) }
  }

  if (editing) {
    return <MusicForm item={item} onDone={() => { setEditing(false); onChanged() }} onCancel={() => setEditing(false)} />
  }

  return (
    <div className="guest">
      <div className="guest-main">
        <span className="guest-name">{item.description}</span>
        {item.url
          ? <a className="chip chip-go link-chip" href={item.url} target="_blank" rel="noreferrer">Spotify ↗</a>
          : <span className="chip">No link yet</span>}
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
            <button className="btn-small ghost" onClick={() => setEditing(true)}>{item.url ? 'Edit' : 'Add link'}</button>
            <button className="btn-small ghost" onClick={() => setConfirming(true)}>Remove</button>
          </>
        )}
      </div>
    </div>
  )
}

function MusicForm({ item, onDone, onCancel }) {
  const [desc, setDesc] = useState(item ? item.description : '')
  const [url, setUrl] = useState(item && item.url ? item.url : '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const link = url.trim()
  const looksWrong = link && !SPOTIFY.test(link)

  async function submit(e) {
    e.preventDefault()
    if (looksWrong) { setErr('That is not a Spotify link. Copy it from Spotify with Share → Copy link.'); return }
    setBusy(true); setErr('')
    try {
      await rpc('wp_save_music_item', { p_id: item ? item.id : null, p_description: desc, p_url: link || null })
      onDone()
    } catch (e2) {
      setErr(e2.code === 'not_spotify' ? 'That is not a Spotify link. Copy it from Spotify with Share → Copy link.'
        : e2.code === 'no_description' ? 'Say what it is for — "First dance", "Background music"…'
        : (e2.message || String(e2)))
      setBusy(false)
    }
  }

  return (
    <form className="editor" onSubmit={submit}>
      <label>What it is for</label>
      <input value={desc} onChange={(e) => setDesc(e.target.value)} autoFocus={!item}
        placeholder="First dance, background music, a request for the DJ…" />
      <label style={{ marginTop: 12 }}>Spotify link <span className="opt">optional</span></label>
      <input value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url"
        placeholder="https://open.spotify.com/…" />
      {looksWrong && <p className="hint" style={{ color: 'var(--warn)' }}>This doesn't look like a Spotify link.</p>}
      {err && <div className="alert alert-warn">{err}</div>}
      <div className="actions">
        <button className="btn-small" type="submit" disabled={busy}>{busy ? 'Saving…' : (item ? 'Save' : 'Add')}</button>
        <button className="btn-small ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}
