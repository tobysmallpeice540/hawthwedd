import { useEffect, useState } from 'react'
import { rpc } from './supabase.js'

// Components that render inputs live at module scope — see Guests.jsx.

function fmtDue(iso) {
  if (!iso) return null
  const d = new Date(iso + 'T12:00:00')
  if (isNaN(d)) return iso
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function dueState(iso, done) {
  if (done || !iso) return null
  const days = Math.round(
    (new Date(iso + 'T12:00:00') - new Date(new Date().toDateString())) / 86400000
  )
  if (days < 0)  return { cls: 'late', text: days === -1 ? 'yesterday' : Math.abs(days) + ' days ago' }
  if (days === 0) return { cls: 'soon', text: 'today' }
  if (days <= 14) return { cls: 'soon', text: 'in ' + days + ' day' + (days === 1 ? '' : 's') }
  return null
}

export default function Checklist() {
  const [data, setData] = useState(null)
  const [state, setState] = useState('loading')
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)

  async function load() {
    try {
      setData(await rpc('wp_get_checklist'))
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
        <h2>We couldn't load your checklist</h2>
        <div className="alert alert-warn" style={{ fontSize: 12 }}>{error}</div>
        <button className="btn" onClick={load}>Try again</button>
      </section>
    )
  }

  const { done, total } = data.progress
  const pct = total ? Math.round((done / total) * 100) : 0
  const todo = data.items.filter((i) => !i.done)
  const complete = data.items.filter((i) => i.done)

  return (
    <>
      <section className="card">
        <h3>Where you are</h3>
        <div className="progress-line">
          <strong>{done}</strong> of {total} done
        </div>
        <div className="bar" role="img" aria-label={pct + '% complete'}>
          <div className="bar-fill" style={{ width: pct + '%' }} />
        </div>
        <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
          The items we've added are the things we need from you, with the dates we
          need them by. Add your own alongside them — anything at all.
        </p>
      </section>

      <section className="card">
        <div className="list-head">
          <h3 style={{ marginBottom: 0 }}>To do</h3>
          <span className="count">{todo.length}</span>
        </div>

        {/* Above the list, not below it. A list of nine items pushes the
            button off the screen, and by the time you have scrolled past
            everything we need from you, adding your own feels like an
            afterthought — which is the opposite of the intention. */}
        {adding
          ? <AddTask onDone={() => { setAdding(false); load() }} onCancel={() => setAdding(false)} />
          : <div className="actions" style={{ marginTop: 0, marginBottom: 4 }}>
              <button className="btn-small" onClick={() => setAdding(true)}>Add your own</button>
            </div>}

        {todo.length === 0 ? (
          <p className="muted" style={{ fontSize: 14, padding: '12px 0' }}>
            Nothing outstanding. That is a rare and lovely thing.
          </p>
        ) : (
          <div className="tasks">
            {todo.map((t) => <Task key={t.id} task={t} onChanged={load} />)}
          </div>
        )}
      </section>

      {complete.length > 0 && (
        <section className="card">
          <div className="list-head">
            <h3 style={{ marginBottom: 0 }}>Done</h3>
            <span className="count">{complete.length}</span>
          </div>
          <div className="tasks">
            {complete.map((t) => <Task key={t.id} task={t} onChanged={load} />)}
          </div>
        </section>
      )}
    </>
  )
}

function Task({ task, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [err, setErr] = useState('')

  async function toggle() {
    setBusy(true); setErr('')
    try {
      await rpc('wp_set_task_done', { p_id: task.id, p_done: !task.done })
      await onChanged()
    } catch (e) { setErr(e.message || String(e)) } finally { setBusy(false) }
  }

  async function remove() {
    setBusy(true); setErr('')
    try {
      await rpc('wp_delete_task', { p_id: task.id })
      await onChanged()
    } catch (e) { setErr(e.message || String(e)); setBusy(false); setConfirming(false) }
  }

  if (editing) {
    return <EditTask task={task} onDone={() => { setEditing(false); onChanged() }} onCancel={() => setEditing(false)} />
  }

  const due = dueState(task.due_on, task.done)

  return (
    <div className={'task' + (task.done ? ' is-done' : '')}>
      <input
        type="checkbox"
        className="tick"
        checked={task.done}
        disabled={busy}
        onChange={toggle}
        aria-label={task.title}
      />
      <div className="task-main">
        <div className="task-title">{task.title}</div>
        {task.detail && <div className="task-detail">{task.detail}</div>}
        <div className="task-meta">
          {task.due_on && <span>{fmtDue(task.due_on)}</span>}
          {due && <span className={'due ' + due.cls}>{due.text}</span>}
          {task.locked && <span className="chip">From us</span>}
        </div>
        {err && <div className="task-detail err">{err}</div>}
      </div>

      {/* Venue items are ours: tickable, but not editable or removable. */}
      {!task.locked && (
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
      )}
    </div>
  )
}

function TaskFields({ title, setTitle, due, setDue }) {
  return (
    <>
      <label>What needs doing</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="Book a cake tasting" />
      <label style={{ marginTop: 12 }}>By when <span className="opt">optional</span></label>
      <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
    </>
  )
}

function AddTask({ onDone, onCancel }) {
  const [title, setTitle] = useState('')
  const [due, setDue] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      await rpc('wp_add_task', { p_title: title, p_due_on: due || null })
      onDone()
    } catch (e2) {
      setErr(e2.code === 'no_title' ? 'Give it a name first.' : (e2.message || String(e2)))
      setBusy(false)
    }
  }

  return (
    <form className="editor" onSubmit={submit}>
      <TaskFields title={title} setTitle={setTitle} due={due} setDue={setDue} />
      {err && <div className="alert alert-warn">{err}</div>}
      <div className="actions">
        <button className="btn-small" type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add'}</button>
        <button className="btn-small ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function EditTask({ task, onDone, onCancel }) {
  const [title, setTitle] = useState(task.title || '')
  const [due, setDue] = useState(task.due_on || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      await rpc('wp_update_task', { p_id: task.id, p_title: title, p_due_on: due || null })
      onDone()
    } catch (e2) { setErr(e2.message || String(e2)); setBusy(false) }
  }

  return (
    <form className="editor" onSubmit={submit}>
      <TaskFields title={title} setTitle={setTitle} due={due} setDue={setDue} />
      {err && <div className="alert alert-warn">{err}</div>}
      <div className="actions">
        <button className="btn-small" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button className="btn-small ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}
