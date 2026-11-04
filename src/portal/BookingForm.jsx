import { useEffect, useRef, useState } from 'react'
import { supabase, rpc } from './supabase.js'
import ContractDocument from '../shared/ContractDocument.jsx'
import { contractMissing, CONTRACT_MISSING_LABELS } from '../shared/contractDoc.js'

// The couple's booking form: read it, fill in the boxes, sign it.
//
// `data` is what ct_my_contract() returned (Portal.jsx reads it, because it
// also decides whether this tab is shown). Answers save themselves a moment
// after each change (ct_save_answers — the database cleans and checks them),
// and signing goes through the contract-sign function, which records who,
// when and from where, and — when the last person signs — makes the signed
// copy and emails it to everyone.

function fmt(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d)) return ''
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' })
}

async function callSign(payload) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Please sign in again.')
  const res = await fetch('/.netlify/functions/contract-sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
    body: JSON.stringify(payload),
  })
  const body = await res.json().catch(() => ({}))
  // res.ok checked before anything is believed — the house rule.
  if (!res.ok) {
    const e = new Error(body.error || 'Something went wrong — please try again.')
    e.missing = body.missing || []
    throw e
  }
  return body
}

export default function BookingForm({ data, onChanged }) {
  const c = data && data.contract
  const [answers, setAnswers] = useState(() => (c && c.answers) || {})
  const [saveState, setSaveState] = useState('')     // '' | saving | saved | error
  const [saveErr, setSaveErr] = useState('')
  const pending = useRef({})
  const timer = useRef(null)
  const [name, setName] = useState('')
  const [agree, setAgree] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(null)
  const signRef = useRef(null)

  // A fresh copy from the server (after signing, or another tab) replaces ours
  // only when nothing is waiting to be saved.
  useEffect(() => {
    if (c && !Object.keys(pending.current).length) setAnswers(c.answers || {})
  }, [c && c.id, c && c.status, c && c.locked, c && c.signers && c.signers.filter((s) => s.signed).length])

  useEffect(() => {
    if (!c || !c.my_role) return
    setName((n) => n || (c.answers || {})[c.my_role + 'Name'] || '')
  }, [c && c.id])

  useEffect(() => () => clearTimeout(timer.current), [])

  if (!c) return null

  const editable = c.status === 'out' && !c.locked && !!c.my_role
  const missing = contractMissing(c.body, c.one_signer, answers)
  const signers = c.signers || []
  const waitingFor = signers.filter((s) => !s.signed).map((s) => s.name)

  async function flush() {
    clearTimeout(timer.current)
    const patch = pending.current
    if (!Object.keys(patch).length) return true
    pending.current = {}
    setSaveState('saving')
    try {
      const r = await rpc('ct_save_answers', { p_answers: patch })
      setSaveState('saved'); setSaveErr('')
      // Keep anything typed while this save was on its way.
      setAnswers((a) => Object.assign({}, r.answers || a, pending.current))
      return true
    } catch (e) {
      // Give the patch back so the next try includes it.
      pending.current = Object.assign({}, patch, pending.current)
      setSaveState('error')
      setSaveErr(e.code === 'locked' ? 'The details were locked when the first person signed — ask us if anything needs changing.'
        : 'Not saved — ' + (e.message || e) + '. We will try again with your next change.')
      return false
    }
  }

  function onAnswer(patch) {
    if (!editable) return
    setAnswers((a) => Object.assign({}, a, patch))
    pending.current = Object.assign({}, pending.current, patch)
    setSaveState('')
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, 700)
  }

  async function sign() {
    setErr(''); setBusy(true)
    try {
      const saved = await flush()
      if (!saved) throw new Error('Your last change has not saved yet — check your connection and try again.')
      const r = await callSign({ action: 'sign', name: name, agree: agree === true })
      setDone(r)
      if (onChanged) await onChanged()
      window.scrollTo(0, 0)
    } catch (e) {
      setErr(e.message || String(e))
    }
    setBusy(false)
  }

  async function download() {
    setErr('')
    try {
      const r = await callSign({ action: 'download' })
      window.open(r.url, '_blank', 'noopener')
    } catch (e) { setErr(e.message || String(e)) }
  }

  const me = signers.find((s) => s.role === c.my_role)
  const iSigned = me && me.signed

  return (
    <>
      <section className="card">
        <h3>Your booking form</h3>
        {c.status === 'signed' ? (
          <>
            <div className="alert alert-ok" style={{ marginTop: 0 }}>
              Signed by everyone{c.signed_at ? ' on ' + fmt(c.signed_at) : ''}. Thank you — a copy has been emailed to you.
            </div>
            <div className="actions" style={{ marginTop: 12 }}>
              {c.pdf_ready
                ? <button className="btn-small" onClick={download}>Download the signed copy</button>
                : <span className="muted" style={{ fontSize: 13 }}>The signed copy is being made — it will be ready in a minute.</span>}
            </div>
          </>
        ) : iSigned ? (
          <div className="alert alert-ok" style={{ marginTop: 0 }}>
            Thank you — you have signed. {waitingFor.length ? 'We are waiting for ' + waitingFor.join(' and ') + ' to sign; ' : ''}
            once everyone has, we will email you both the signed copy.
          </div>
        ) : c.can_sign ? (
          <>
            <p className="muted" style={{ fontSize: 14.5 }}>
              Please read it all the way through. Fill in the boxes marked for you, choose yes, hold or no for any
              accommodation, and sign at the bottom by typing your name. Everything saves as you go.
            </p>
            <div className="actions" style={{ marginTop: 10 }}>
              <button className="btn-small" onClick={() => signRef.current && signRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                Go to signing
              </button>
            </div>
          </>
        ) : (
          <p className="muted">This is the booking form we have sent for {signers.map((s) => s.name).join(' and ')} to sign.</p>
        )}
        <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>
          Version {c.version} · sent {fmt(c.sent_at)}
          {signers.map((s) => ' · ' + s.name + (s.signed ? ' signed ' + fmt(s.signed_at) : ' not signed yet')).join('')}
        </p>
        {done && done.complete && !c.pdf_ready && (
          <p className="muted" style={{ fontSize: 13 }}>Everyone has signed. Your copy is on its way by email.</p>
        )}
      </section>

      <section className="card">
        <ContractDocument body={c.body} answers={answers} signers={signers} oneSigner={c.one_signer}
          editable={editable} missing={editable ? missing : []} onAnswer={onAnswer} />
        {editable && saveState && (
          <p className="muted" style={{ fontSize: 12.5, marginTop: 6, color: saveState === 'error' ? '#b45309' : undefined }}>
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveErr}
          </p>
        )}
      </section>

      {c.can_sign && (
        <section className="card" ref={signRef}>
          <h3>Sign</h3>
          {missing.length > 0 ? (
            <div className="alert alert-warn" style={{ marginTop: 0 }}>
              Before you can sign, please fill in: {missing.map((k) => CONTRACT_MISSING_LABELS[k] || k).join(', ')}.
              The boxes are marked above.
            </div>
          ) : (
            <>
              <label style={{ display: 'block', marginBottom: 12 }}>
                <span className="muted" style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Type your full name</span>
                <input type="text" value={name} autoComplete="name" onChange={(e) => setName(e.target.value)}
                  style={{ fontFamily: 'Georgia, serif', fontStyle: 'italic', fontSize: 20 }} />
              </label>
              <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 14.5, lineHeight: 1.5, cursor: 'pointer' }}>
                <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)}
                  style={{ width: 20, height: 20, marginTop: 2, flex: '0 0 auto' }} />
                <span>I have read this booking form and the terms and conditions above, and I agree to them on behalf of
                  myself and everyone in my party. I understand that typing my name here is my signature.</span>
              </label>
              <button className="btn" style={{ marginTop: 16 }} onClick={sign}
                disabled={busy || !agree || name.trim().length < 2}>
                {busy ? 'Signing…' : 'Sign the booking form'}
              </button>
            </>
          )}
          {err && <div className="alert alert-warn">{err}</div>}
        </section>
      )}
      {!c.can_sign && err && <div className="alert alert-warn">{err}</div>}
    </>
  )
}
