import { useEffect, useState } from 'react'
import { rpc } from './supabase.js'

// Components that render inputs live at module scope — see Guests.jsx.
//
// The question set comes from the database, not from here, so it can change
// without a deploy. This renders whatever it is given.

export default function VenueForm() {
  const [data, setData] = useState(null)
  const [answers, setAnswers] = useState({})
  const [state, setState] = useState('loading')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  async function load() {
    try {
      const d = await rpc('wp_get_venue_form')
      setData(d)
      setAnswers(d.answers || {})
      setState('ready')
    } catch (e) {
      setError(e.message || String(e)); setState('error')
    }
  }
  useEffect(() => { load() }, [])

  function set(qkey, value) {
    setAnswers((p) => ({ ...p, [qkey]: value }))
    setSaved(false)
  }

  async function save(e) {
    e.preventDefault()
    setSaving(true); setError(''); setSaved(false)
    try {
      await rpc('wp_save_venue_form', { p_answers: answers })
      setSaved(true)
      await load()
    } catch (e2) {
      setError(e2.message || String(e2))
    } finally {
      setSaving(false)
    }
  }

  if (state === 'loading') return <section className="card"><p className="muted">Loading…</p></section>
  if (state === 'error') {
    return (
      <section className="card">
        <h2>We couldn't load the form</h2>
        <div className="alert alert-warn" style={{ fontSize: 12 }}>{error}</div>
        <button className="btn" onClick={load}>Try again</button>
      </section>
    )
  }

  // Group by section, preserving the order the database gave us.
  const sections = []
  for (const q of data.questions) {
    let s = sections.find((x) => x.name === q.section)
    if (!s) { s = { name: q.section, questions: [] }; sections.push(s) }
    s.questions.push(q)
  }

  const { answered, total } = data.progress

  return (
    <form onSubmit={save}>
      <section className="card">
        <h3>Things we need to know</h3>
        <p className="muted" style={{ fontSize: 14 }}>
          None of this is urgent, and you can come back and change any of it.
          Answer what you know and leave the rest.
        </p>
        <div className="progress-line" style={{ marginTop: 14 }}>
          <strong>{answered}</strong> of {total} answered
        </div>
      </section>

      {sections.map((s) => (
        <section className="card" key={s.name}>
          <h3>{s.name}</h3>
          <div className="qlist">
            {s.questions.map((q) => (
              <Question key={q.qkey} q={q} value={answers[q.qkey] ?? ''} onChange={set} />
            ))}
          </div>
        </section>
      ))}

      <section className="card">
        {error && <div className="alert alert-warn">{error}</div>}
        {saved && !saving && <div className="alert alert-ok">Saved. Thank you.</div>}
        <button className="btn" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save answers'}
        </button>
      </section>
    </form>
  )
}

function Question({ q, value, onChange }) {
  const id = 'q-' + q.qkey
  return (
    <div className="q">
      <label htmlFor={id}>{q.label}</label>
      {q.kind === 'yesno' && (
        <div className="yesno">
          <YesNoOption id={id} qkey={q.qkey} value={value} option="yes" label="Yes" onChange={onChange} />
          <YesNoOption qkey={q.qkey} value={value} option="no" label="No" onChange={onChange} />
          <YesNoOption qkey={q.qkey} value={value} option="unsure" label="Not sure yet" onChange={onChange} />
        </div>
      )}
      {/* 'choice' is the original name for a dropdown and is still in use, so
          it renders as one. 'radio' shows every option at once, which is what
          you want for three, and 'select' is the same list behind a click. */}
      {(q.kind === 'choice' || q.kind === 'select') && (
        <select id={id} value={value} onChange={(e) => onChange(q.qkey, e.target.value)}>
          <option value="">—</option>
          {(q.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      )}
      {q.kind === 'radio' && (
        <div className="yesno">
          {(q.options || []).map((o, i) => (
            <YesNoOption key={o} id={i === 0 ? id : undefined} qkey={q.qkey}
              value={value} option={o} label={o} onChange={onChange} />
          ))}
        </div>
      )}
      {q.kind === 'date' && (
        <input id={id} type="date" value={value} onChange={(e) => onChange(q.qkey, e.target.value)} />
      )}
      {q.kind === 'longtext' && (
        <textarea id={id} rows={3} value={value} onChange={(e) => onChange(q.qkey, e.target.value)} />
      )}
      {q.kind === 'time' && (
        <input id={id} type="time" value={value} onChange={(e) => onChange(q.qkey, e.target.value)} />
      )}
      {q.kind === 'number' && (
        <input id={id} type="number" min="0" inputMode="numeric" value={value} onChange={(e) => onChange(q.qkey, e.target.value)} />
      )}
      {q.kind === 'text' && (
        <input id={id} type="text" value={value} onChange={(e) => onChange(q.qkey, e.target.value)} />
      )}
      {q.help && <div className="hint">{q.help}</div>}
    </div>
  )
}

function YesNoOption({ id, qkey, value, option, label, onChange }) {
  return (
    <label className="radio">
      <input
        id={id}
        type="radio"
        name={qkey}
        checked={value === option}
        onChange={() => onChange(qkey, option)}
      />
      {label}
    </label>
  )
}
