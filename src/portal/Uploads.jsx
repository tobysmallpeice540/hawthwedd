import { useEffect, useState } from 'react'
import { supabase, rpc, SUPABASE_URL, SUPABASE_ANON } from './supabase.js'

// Photos and films a client sends us — for a wake, the pictures for the
// slideshow and any film for the screen.
//
// Each file goes straight from the browser to private storage with a one-use
// upload token from netlify/functions/portal-upload.js, which asks the
// database first and lets the database choose where the file goes. The file
// never passes through the function (they take 6MB; a film is hundreds), and
// it only appears in the list once the function has checked it arrived.
//
// Components that render inputs live at module scope — see Guests.jsx.

const EXT_TYPE = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm',
}

// Some browsers give a HEIC photo or a .mov no type at all.
function typeOf(file) {
  if (file.type) return file.type
  const ext = String(file.name.split('.').pop() || '').toLowerCase()
  return EXT_TYPE[ext] || ''
}

function size(bytes) {
  const b = Number(bytes) || 0
  if (b >= 1048576 * 1024) return (b / 1048576 / 1024).toFixed(1) + ' GB'
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB'
  return Math.max(1, Math.round(b / 1024)) + ' KB'
}

async function call(action, payload) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Please sign in again.')
  const res = await fetch('/.netlify/functions/portal-upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
    body: JSON.stringify(Object.assign({ action }, payload)),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e = new Error(body.error || 'Something went wrong — please try again.')
    e.code = body.code; e.max_mb = body.max_mb
    throw e
  }
  return body
}

// The upload itself, with progress — fetch cannot report progress, XHR can.
function put(slot, file, type, onProgress) {
  return new Promise(async (resolve, reject) => {
    const { data: { session } } = await supabase.auth.getSession()
    const url = SUPABASE_URL + '/storage/v1/object/upload/sign/' + slot.bucket + '/' +
      slot.path.split('/').map(encodeURIComponent).join('/') + '?token=' + encodeURIComponent(slot.token)
    const form = new FormData()
    form.append('cacheControl', '3600')
    form.append('', new File([file], file.name, { type }))
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('apikey', SUPABASE_ANON)
    xhr.setRequestHeader('Authorization', 'Bearer ' + (session ? session.access_token : SUPABASE_ANON))
    xhr.setRequestHeader('x-upsert', 'false')
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total) }
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('The upload was refused (' + xhr.status + ').')))
    xhr.onerror = () => reject(new Error('The connection dropped — please try that one again.'))
    xhr.send(form)
  })
}

export default function Uploads() {
  const [data, setData] = useState(null)
  const [state, setState] = useState('loading')
  const [error, setError] = useState('')
  const [queue, setQueue] = useState([])     // [{key, name, progress, status, error}]
  const [busy, setBusy] = useState(false)

  async function load() {
    try { setData(await rpc('wp_get_uploads')); setState('ready') }
    catch (e) { setError(e.message || String(e)); setState('error') }
  }
  useEffect(() => { load() }, [])

  function patch(key, p) { setQueue((q) => q.map((x) => (x.key === key ? Object.assign({}, x, p) : x))) }

  // One at a time: several films at once over a home connection is slower for
  // all of them, and a failure is easier to understand on its own.
  async function send(files) {
    const list = Array.from(files || []).map((f, i) => ({ key: Date.now() + '-' + i, file: f, name: f.name, progress: 0, status: 'waiting' }))
    if (!list.length) return
    setQueue((q) => q.concat(list))
    setBusy(true)
    for (const item of list) {
      const type = typeOf(item.file)
      try {
        patch(item.key, { status: 'sending' })
        const slot = await call('start', { name: item.file.name, size: item.file.size, type })
        await put(slot, item.file, type, (p) => patch(item.key, { progress: p }))
        patch(item.key, { status: 'checking', progress: 1 })
        await call('finish', { id: slot.id })
        patch(item.key, { status: 'done' })
      } catch (e) {
        patch(item.key, { status: 'failed',
          error: e.code === 'too_big' ? 'Too large — the limit is ' + (e.max_mb || data.max_mb) + ' MB a file.' : (e.message || String(e)) })
      }
    }
    setBusy(false)
    await load()
    setQueue((q) => q.filter((x) => x.status !== 'done'))
  }

  if (state === 'loading') return <section className="card"><p className="muted">Loading…</p></section>
  if (state === 'error') {
    return (
      <section className="card">
        <h2>We couldn't load your photos and films</h2>
        <div className="alert alert-warn" style={{ fontSize: 12 }}>{error}</div>
        <button className="btn" onClick={load}>Try again</button>
      </section>
    )
  }

  return (
    <>
      <section className="card">
        <h3>Send us photos and films</h3>
        <p className="muted" style={{ fontSize: 14 }}>
          Pictures for the slideshow, or a film to play on the screen. Photos as JPEG, PNG or
          HEIC (straight from a phone is fine); films as MP4 or MOV, up to {data.max_mb} MB each.
          Add a caption if it helps us get the order or the names right.
        </p>
        <div className="actions">
          <label className={'filebtn' + (busy ? ' is-busy' : '')}>
            <input type="file" multiple accept="image/*,video/*,.heic,.heif,.mov" disabled={busy}
              onChange={(e) => { const f = e.target.files; send(f); e.target.value = '' }} />
            {busy ? 'Sending…' : 'Choose photos or films'}
          </label>
        </div>
        {queue.length > 0 && (
          <div className="guests">
            {queue.map((q) => (
              <div className="guest" key={q.key}>
                <div className="guest-main" style={{ flex: 1 }}>
                  <span className="guest-name">{q.name}</span>
                  <span className="guest-side">
                    {q.status === 'waiting' ? 'waiting' : q.status === 'sending' ? Math.round(q.progress * 100) + '%'
                      : q.status === 'checking' ? 'checking it arrived…' : q.status === 'failed' ? 'not sent' : 'sent'}
                  </span>
                  {q.status === 'sending' && (
                    <div className="bar" style={{ flexBasis: '100%' }}><div className="bar-fill" style={{ width: Math.round(q.progress * 100) + '%' }} /></div>
                  )}
                  {q.error && <div className="guest-note err">{q.error}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="list-head">
          <h3 style={{ marginBottom: 0 }}>What you have sent</h3>
          <span className="count">{data.uploads.length}</span>
        </div>
        {data.uploads.length === 0 ? (
          <p className="muted" style={{ fontSize: 14, padding: '10px 0' }}>Nothing yet.</p>
        ) : (
          <div className="guests">
            {data.uploads.map((u) => <UploadRow key={u.id} u={u} onChanged={load} />)}
          </div>
        )}
      </section>
    </>
  )
}

function UploadRow({ u, onChanged }) {
  const [caption, setCaption] = useState(u.caption || '')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [err, setErr] = useState('')

  async function open() {
    setBusy(true); setErr('')
    // Opened before the request so a phone browser does not block it as a pop-up.
    const w = window.open('', '_blank')
    try {
      const r = await call('view', { id: u.id })
      if (w) w.location = r.url; else window.location.href = r.url
    } catch (e) { if (w) w.close(); setErr(e.message || String(e)) }
    finally { setBusy(false) }
  }
  async function saveCaption() {
    if ((u.caption || '') === caption.trim()) return
    try { await rpc('wp_set_upload_caption', { p_id: u.id, p_caption: caption }); await onChanged() }
    catch (e) { setErr(e.message || String(e)) }
  }
  async function remove() {
    setBusy(true); setErr('')
    try { await call('delete', { id: u.id }); await onChanged() }
    catch (e) { setErr(e.message || String(e)); setBusy(false); setConfirming(false) }
  }

  return (
    <div className="guest">
      <div className="guest-main" style={{ flex: 1 }}>
        <span className="chip">{u.kind === 'video' ? 'Film' : 'Photo'}</span>
        <span className="guest-name">{u.name}</span>
        <span className="guest-side">{size(u.size_bytes)}</span>
        <input className="caption" value={caption} placeholder="Caption (optional)"
          onChange={(e) => setCaption(e.target.value)} onBlur={saveCaption}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
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
            <button className="btn-small ghost" onClick={open} disabled={busy}>View</button>
            <button className="btn-small ghost" onClick={() => setConfirming(true)}>Remove</button>
          </>
        )}
      </div>
    </div>
  )
}
