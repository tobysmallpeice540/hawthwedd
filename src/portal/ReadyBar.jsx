import { useState } from 'react'
import { rpc } from './supabase.js'

// The tabs a client can tell us are finished, and how each is named in the bar.
export const READY_LABEL = {
  guests:    'your guest list',
  food:      'your food choices',
  drinks:    'your drinks order',
  bar:       'your bar choices',
  timeline:  'your timeline',
  music:     'your music',
  photos:    'your photo and film links',
  uploads:   'your uploads',
  suppliers: 'your suppliers',
  layout:    'your table plan',
  items:     'the list of things you are bringing',
  details:   'your details',
}

function fmt(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
}

// "We're done with this." It tells us, and it locks nothing: everything stays
// editable, and a change made afterwards shows on our side as "changed since".
// That is the same rule as double bookings — the venue warns, it never refuses.
export default function ReadyBar({ section, sections, onChange }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const s = (sections || []).find((x) => x.section === section)
  const what = READY_LABEL[section]

  async function set(ready) {
    setBusy(true); setErr('')
    try {
      const r = await rpc('wp_set_section_ready', { p_section: section, p_ready: ready })
      onChange(r.sections || [])
    } catch (e) { setErr(e.message || String(e)) }
    finally { setBusy(false) }
  }

  return (
    <section className={'card ready-bar' + (s && s.state === 'reopened' ? ' is-back' : s ? ' is-sent' : '')}>
      {!s && (
        <>
          <div>
            <div className="ready-title">Happy with {what}?</div>
            <div className="ready-detail">Let us know and we will look it over. You can still change things afterwards.</div>
          </div>
          <button className="btn-small" disabled={busy} onClick={() => set(true)}>
            {busy ? 'Sending…' : "We're done with this"}
          </button>
        </>
      )}
      {s && s.state === 'ready' && (
        <>
          <div>
            <div className="ready-title">Sent to us{s.ready_at ? ' on ' + fmt(s.ready_at) : ''}</div>
            <div className="ready-detail">
              {s.changed_since
                ? 'You have changed things since — we will see that too.'
                : 'Thank you. If anything changes, just edit it here.'}
            </div>
          </div>
          <button className="btn-small ghost" disabled={busy} onClick={() => set(false)}>
            I'm still working on it
          </button>
        </>
      )}
      {s && s.state === 'reopened' && (
        <>
          <div>
            <div className="ready-title">We have asked for a change</div>
            {s.reopen_note && <div className="ready-note">“{s.reopen_note}”</div>}
            <div className="ready-detail">Once it is sorted, send it back to us.</div>
          </div>
          <button className="btn-small" disabled={busy} onClick={() => set(true)}>
            {busy ? 'Sending…' : "Done — send it back"}
          </button>
        </>
      )}
      {err && <div className="alert alert-warn" style={{ flexBasis: '100%' }}>{err}</div>}
    </section>
  )
}
