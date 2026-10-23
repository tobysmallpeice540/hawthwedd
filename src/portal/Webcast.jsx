import { useEffect, useState } from 'react'
import { rpc } from './supabase.js'

// The webcast: the stream address and password we set up for this event, for
// the client to pass on to anyone watching from home. The tab only appears
// once the webcast has been confirmed as an extra.

export default function Webcast() {
  const [data, setData] = useState(null)
  const [state, setState] = useState('loading')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')

  async function load() {
    try { setData(await rpc('wp_get_webcast')); setState('ready') }
    catch (e) {
      if (e.code === 'not_available') { setState('none'); return }
      setError(e.message || String(e)); setState('error')
    }
  }
  useEffect(() => { load() }, [])

  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(''), 2000) }
    catch (e) { /* the text is on screen to copy by hand */ }
  }

  if (state === 'loading') return <section className="card"><p className="muted">Loading…</p></section>
  if (state === 'none') return <section className="card"><p className="muted">The webcast isn't set up for this booking.</p></section>
  if (state === 'error') {
    return (
      <section className="card">
        <h2>We couldn't load the webcast details</h2>
        <div className="alert alert-warn" style={{ fontSize: 12 }}>{error}</div>
        <button className="btn" onClick={load}>Try again</button>
      </section>
    )
  }

  return (
    <section className="card">
      <h3>The webcast</h3>
      {!data.stream_url ? (
        <p className="muted" style={{ fontSize: 14 }}>
          We are setting it up. The link and password will appear here before the day.
        </p>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 14, marginBottom: 14 }}>
            Share these with anyone who would like to watch from home.
          </p>
          <div className="rows">
            <div className="row">
              <span className="k">Link</span>
              <span className="v" style={{ wordBreak: 'break-all' }}>
                <a href={data.stream_url} target="_blank" rel="noreferrer">{data.stream_url}</a>
              </span>
            </div>
            {data.password && (
              <div className="row"><span className="k">Password</span><span className="v">{data.password}</span></div>
            )}
          </div>
          <div className="actions">
            <button className="btn-small" onClick={() => copy(data.stream_url, 'link')}>{copied === 'link' ? 'Copied' : 'Copy link'}</button>
            {data.password && (
              <button className="btn-small ghost" onClick={() => copy(data.password, 'password')}>{copied === 'password' ? 'Copied' : 'Copy password'}</button>
            )}
          </div>
          {data.notes && <p className="muted" style={{ fontSize: 14, marginTop: 14 }}>{data.notes}</p>}
        </>
      )}
    </section>
  )
}
