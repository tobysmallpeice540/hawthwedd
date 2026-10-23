import { useEffect, useState } from 'react'
import { rpc, isMissingFunction } from './supabase.js'

// The people to phone on the day — the best man with the rings, whoever is
// looking after Granny, the person collecting the decorations. The venue team
// sees this list on the day's function sheet.
//
// Components that render inputs live at module scope — see Guests.jsx.

export default function KeyContacts() {
  const [contacts, setContacts] = useState(null)
  const [state, setState] = useState('loading')
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)

  async function load() {
    try { const d = await rpc('wp_get_key_contacts'); setContacts(d.contacts || []); setState('ready') }
    catch (e) {
      if (isMissingFunction(e)) { setState('absent'); return }
      setError(e.message || String(e)); setState('error')
    }
  }
  useEffect(() => { load() }, [])

  if (state === 'absent' || state === 'loading') return null
  if (state === 'error') {
    return (
      <section className="card">
        <h3>Key contacts on the day</h3>
        <div className="alert alert-warn" style={{ fontSize: 12 }}>{error}</div>
        <button className="btn-small" onClick={load}>Try again</button>
      </section>
    )
  }

  return (
    <section className="card">
      <div className="list-head">
        <div>
          <h3 style={{ marginBottom: 4 }}>Key contacts on the day</h3>
          <p className="muted" style={{ fontSize: 13 }}>
            Who should we phone on the day if we need something — and not you two?
            A best man, a parent, whoever is in charge of the decorations.
          </p>
        </div>
        <span className="count">{contacts.length}</span>
      </div>
      {contacts.length > 0 && (
        <div className="guests">
          {contacts.map((c) => <ContactRow key={c.id} contact={c} onChanged={load} />)}
        </div>
      )}
      {adding
        ? <ContactForm contact={null} onDone={() => { setAdding(false); load() }} onCancel={() => setAdding(false)} />
        : <div className="actions"><button className="btn-small" type="button" onClick={() => setAdding(true)}>Add a contact</button></div>}
    </section>
  )
}

function ContactRow({ contact, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function remove() {
    setBusy(true); setErr('')
    try { await rpc('wp_delete_key_contact', { p_id: contact.id }); await onChanged() }
    catch (e) { setErr(e.message || String(e)); setBusy(false); setConfirming(false) }
  }

  if (editing) return <ContactForm contact={contact} onDone={() => { setEditing(false); onChanged() }} onCancel={() => setEditing(false)} />

  return (
    <div className="guest">
      <div className="guest-main">
        <span className="guest-name">{contact.name}</span>
        {contact.role && <span className="guest-side">{contact.role}</span>}
        {contact.phone && <div className="guest-note">{contact.phone}</div>}
        {contact.note && <div className="guest-note">{contact.note}</div>}
        {err && <div className="guest-note err">{err}</div>}
      </div>
      <div className="guest-actions">
        {confirming ? (
          <>
            <button className="btn-small danger" type="button" onClick={remove} disabled={busy}>Remove</button>
            <button className="btn-small ghost" type="button" onClick={() => setConfirming(false)}>Keep</button>
          </>
        ) : (
          <>
            <button className="btn-small ghost" type="button" onClick={() => setEditing(true)}>Edit</button>
            <button className="btn-small ghost" type="button" onClick={() => setConfirming(true)}>Remove</button>
          </>
        )}
      </div>
    </div>
  )
}

function ContactForm({ contact, onDone, onCancel }) {
  const [name, setName] = useState(contact ? contact.name : '')
  const [role, setRole] = useState(contact && contact.role ? contact.role : '')
  const [phone, setPhone] = useState(contact && contact.phone ? contact.phone : '')
  const [note, setNote] = useState(contact && contact.note ? contact.note : '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      await rpc('wp_save_key_contact', { p_id: contact ? contact.id : null, p_name: name, p_role: role, p_phone: phone, p_note: note })
      onDone()
    } catch (e2) {
      setErr(e2.code === 'no_name' ? 'Who is it?' : e2.code === 'too_many' ? 'That is plenty — twenty is the most we keep.' : (e2.message || String(e2)))
      setBusy(false)
    }
  }

  return (
    <form className="editor" onSubmit={submit}>
      <div className="namegrid">
        <div>
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div>
          <label>Who they are <span className="opt">optional</span></label>
          <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Best man, mother of the bride…" />
        </div>
      </div>
      <label>Phone</label>
      <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <label style={{ marginTop: 12 }}>Anything we should know <span className="opt">optional</span></label>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Has the rings; collecting the decorations on Sunday…" />
      {err && <div className="alert alert-warn">{err}</div>}
      <div className="actions">
        <button className="btn-small" type="submit" disabled={busy}>{busy ? 'Saving…' : (contact ? 'Save' : 'Add')}</button>
        <button className="btn-small ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}
