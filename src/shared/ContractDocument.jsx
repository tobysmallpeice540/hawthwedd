// The booking form on screen — one renderer for the couple's page in the
// portal and the office's preview on the Contract tab, so what staff check is
// what the couple sees. It draws a FROZEN contract body (see contractDoc.js).
//
// editable: the couple's boxes and choices can be changed (onAnswer(patch)).
// Otherwise everything is shown as answered.
//
// Inline styles only, in neutral colours: it is drawn inside two different
// apps with two different stylesheets. Every component that renders an input
// is at module scope (house rule: one defined inside another loses focus).

import React from 'react'
import { boldRuns, contractDate, contractMoney, answerWord, glampingChoice } from './contractDoc.js'

const C = { text: '#2d2a25', muted: '#7a7060', border: '#e2dbd0', soft: '#f6f2ec', warn: '#b45309', warnBg: '#fff7ed', ok: '#15803d', okBg: '#f0fdf4' }

const sx = {
  doc: { color: C.text, fontSize: 14.5, lineHeight: 1.6 },
  // Explicit about everything a host stylesheet might set on headings (the
  // portal's .card h3 is small capitals in grey, for instance).
  h1: { fontSize: 24, fontWeight: 700, margin: '4px 0 10px', lineHeight: 1.25, fontFamily: 'inherit', textTransform: 'none', letterSpacing: 'normal', color: C.text },
  h2: { fontSize: 19, fontWeight: 700, margin: '26px 0 8px', lineHeight: 1.3, fontFamily: 'inherit', textTransform: 'none', letterSpacing: 'normal', color: C.text },
  h3: { fontSize: 15.5, fontWeight: 700, margin: '18px 0 6px', lineHeight: 1.35, fontFamily: 'inherit', textTransform: 'none', letterSpacing: 'normal', color: C.text },
  p: { margin: '0 0 10px', whiteSpace: 'pre-line' },
  ul: { margin: '0 0 10px', paddingLeft: 22 },
  tableWrap: { overflowX: 'auto', margin: '6px 0 12px' },
  table: { borderCollapse: 'collapse', width: '100%', fontSize: 13.5 },
  td: { border: '1px solid ' + C.border, padding: '7px 9px', verticalAlign: 'top' },
  th: { border: '1px solid ' + C.border, padding: '7px 9px', verticalAlign: 'top', background: C.soft, textAlign: 'left', fontWeight: 700 },
  brk: { border: 'none', borderTop: '1px dashed ' + C.border, margin: '26px 0' },
  box: { border: '1px solid ' + C.border, borderRadius: 10, padding: '12px 14px', margin: '8px 0 12px', background: '#fff' },
  label: { display: 'block', fontSize: 12.5, fontWeight: 700, color: C.muted, margin: '0 0 4px' },
  input: { width: '100%', boxSizing: 'border-box', border: '1.5px solid ' + C.border, borderRadius: 8, padding: '9px 11px', fontSize: 15, fontFamily: 'inherit', color: C.text, background: '#fff' },
  muted: { color: C.muted, fontSize: 13 },
}

function Runs({ text }) {
  return boldRuns(text).map((r, i) => r.bold ? <strong key={i}>{r.text}</strong> : <React.Fragment key={i}>{r.text}</React.Fragment>)
}

function TextBox({ label, value, onChange, disabled, flag, multiline, type, autoComplete }) {
  const style = Object.assign({}, sx.input, flag ? { borderColor: C.warn, background: C.warnBg } : null, disabled ? { background: C.soft } : null)
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <span style={sx.label}>{label}{flag ? ' — needed' : ''}</span>
      {multiline
        ? <textarea rows={3} value={value || ''} disabled={disabled} style={Object.assign({}, style, { resize: 'vertical' })}
            onChange={(e) => onChange(e.target.value)} />
        : <input type={type || 'text'} value={value || ''} disabled={disabled} style={style} autoComplete={autoComplete}
            onChange={(e) => onChange(e.target.value)} />}
    </label>
  )
}

function Choice({ value, onPick, disabled, flag, name }) {
  const opts = [['yes', 'Yes'], ['hold', 'Hold'], ['no', 'No']]
  return (
    <div role="radiogroup" aria-label={name} style={{ display: 'flex', flexWrap: 'nowrap', gap: 6 }}>
      {opts.map(([k, l]) => {
        const on = value === k
        return (
          <button key={k} type="button" role="radio" aria-checked={on} disabled={disabled}
            onClick={() => onPick(k)}
            style={{ minWidth: 58, padding: '7px 12px', borderRadius: 8, fontFamily: 'inherit', fontSize: 14, fontWeight: 700,
              cursor: disabled ? 'default' : 'pointer',
              border: '1.5px solid ' + (on ? C.text : flag ? C.warn : C.border),
              background: on ? C.text : flag ? C.warnBg : '#fff', color: on ? '#fff' : C.text }}>
            {l}
          </button>
        )
      })}
    </div>
  )
}

function dates(from, to) {
  if (!from && !to) return ''
  return contractDate(from, true) + ' to ' + contractDate(to, true)
}

function AccomRow({ row, answers, editable, missing, onAnswer }) {
  const a = answers || {}
  const flag = missing.indexOf(row.key) !== -1
  if (row.key !== 'glamping') {
    return (
      <div style={Object.assign({}, sx.box, flag ? { borderColor: C.warn } : null)}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700 }}>{row.label}</div>
            <div style={sx.muted}>{dates(row.from, row.to)}{row.fee ? ' · ' + contractMoney(row.fee) + ' incl. VAT' : ''}</div>
          </div>
          {editable
            ? <Choice name={row.label} value={a[row.key]} flag={flag} onPick={(v) => onAnswer({ [row.key]: v })} />
            : <strong>{answerWord(a[row.key]) || '—'}</strong>}
        </div>
      </div>
    )
  }
  const ch = glampingChoice(row, a)
  const nightsFlag = missing.indexOf('glampingNights') !== -1
  const two = (row.options || []).length > 1
  return (
    <div style={Object.assign({}, sx.box, flag || nightsFlag ? { borderColor: C.warn } : null)}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontWeight: 700 }}>{row.label}</div>
        {editable
          ? <Choice name={row.label} value={a.glamping} flag={flag} onPick={(v) => onAnswer({ glamping: v })} />
          : <strong>{answerWord(a.glamping) || '—'}</strong>}
      </div>
      <div style={{ marginTop: 8 }}>
        {(row.options || []).map((o) => {
          const on = ch && Number(ch.nights) === Number(o.nights)
          const text = (o.nights === 1 ? '1 night' : o.nights + ' nights') + ' · ' + dates(o.from, o.to) + ' · ' + contractMoney(o.fee) + ' incl. VAT'
          if (!editable || !two) {
            return (
              <div key={o.nights} style={Object.assign({}, sx.muted, on && a.glamping && a.glamping !== 'no' ? { color: C.text, fontWeight: 700 } : null)}>
                {text}{!editable && on && a.glamping && a.glamping !== 'no' ? ' — chosen' : ''}
              </div>
            )
          }
          return (
            <label key={o.nights} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', cursor: 'pointer',
              color: a.glamping === 'no' ? C.muted : C.text, fontSize: 14 }}>
              <input type="radio" name="glamping-nights" checked={!!on} disabled={a.glamping === 'no'}
                onChange={() => onAnswer({ glampingNights: o.nights })} style={{ width: 17, height: 17 }} />
              {text}
            </label>
          )
        })}
        {editable && two && nightsFlag && <div style={{ color: C.warn, fontSize: 13 }}>Choose one night or two.</div>}
      </div>
    </div>
  )
}

function Signatures({ body, answers, signers, oneSigner, editable, missing, onAnswer }) {
  const a = answers || {}
  const venue = body.venue || {}
  const sig = (role) => (signers || []).find((s) => s.role === role) || null
  const party = (n) => {
    const role = 'client' + n
    const s = sig(role)
    return (
      <div key={role} style={sx.box}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>{n === 1 ? 'First party' : 'Second party'}</div>
        {editable ? (
          <>
            <TextBox label="Full name" value={a[role + 'Name']} flag={missing.indexOf(role + 'Name') !== -1}
              autoComplete="name" onChange={(v) => onAnswer({ [role + 'Name']: v })} />
            <TextBox label="Mobile" type="tel" value={a[role + 'Mobile']} flag={missing.indexOf(role + 'Mobile') !== -1}
              autoComplete="tel" onChange={(v) => onAnswer({ [role + 'Mobile']: v })} />
          </>
        ) : (
          <>
            <div><span style={sx.muted}>Name </span>{a[role + 'Name'] || (s && s.name) || '—'}</div>
            <div><span style={sx.muted}>Mobile </span>{a[role + 'Mobile'] || '—'}</div>
          </>
        )}
        <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: s && s.signed ? C.okBg : C.soft,
          color: s && s.signed ? C.ok : C.muted, fontSize: 13.5 }}>
          {s && s.signed
            ? <>Signed <em style={{ fontFamily: 'Georgia, serif', fontSize: 16, color: C.text }}>{s.signed_name}</em>{s.signed_at ? ' · ' + new Date(s.signed_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }) : ''}</>
            : 'Not signed yet' + (s ? ' — ' + s.name : '')}
        </div>
      </div>
    )
  }
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
        {party(1)}
        {!oneSigner && party(2)}
      </div>
      {editable
        ? <TextBox label="Correspondence address" multiline value={a.address} flag={missing.indexOf('address') !== -1}
            onChange={(v) => onAnswer({ address: v })} />
        : <div style={{ margin: '4px 0 10px' }}><span style={sx.muted}>Correspondence address </span><span style={{ whiteSpace: 'pre-line' }}>{a.address || '—'}</span></div>}
      <div style={Object.assign({}, sx.box, { background: C.soft })}>
        <div style={{ fontWeight: 700 }}>Hawthbush Farm Ltd</div>
        <div style={sx.muted}>
          {venue.name
            ? <>Signed for Hawthbush Farm Ltd by <strong style={{ color: C.text }}>{venue.name}</strong>{venue.signed_at ? ' on ' + contractDate(String(venue.signed_at).slice(0, 10)) : ''}</>
            : 'Signed for Hawthbush Farm Ltd when the form is sent'}
        </div>
      </div>
    </div>
  )
}

export default function ContractDocument({ body, answers, signers, oneSigner, editable, missing, onAnswer }) {
  if (!body || !Array.isArray(body.blocks)) return null
  const miss = missing || []
  const on = onAnswer || function () {}
  const a = answers || {}
  return (
    <div style={sx.doc}>
      {body.blocks.map((b, i) => {
        switch (b.t) {
          case 'h1': return <h1 key={i} style={sx.h1}><Runs text={b.text} /></h1>
          case 'h2': return <h2 key={i} style={sx.h2}><Runs text={b.text} /></h2>
          case 'h3': return <h3 key={i} style={sx.h3}><Runs text={b.text} /></h3>
          case 'p': return <p key={i} style={sx.p}><Runs text={b.text} /></p>
          case 'ul': return <ul key={i} style={sx.ul}>{b.items.map((t, j) => <li key={j}><Runs text={t} /></li>)}</ul>
          case 'break': return <hr key={i} style={sx.brk} />
          case 'table':
            return (
              <div key={i} style={sx.tableWrap}>
                <table style={sx.table}><tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j}>{r.map((c, k) => {
                      const head = b.head && j === 0
                      const Cell = head ? 'th' : 'td'
                      return <Cell key={k} style={head ? sx.th : Object.assign({}, sx.td, !b.head && k === 0 && r.length === 2 ? { color: C.muted, width: '45%' } : null)}><Runs text={c} /></Cell>
                    })}</tr>
                  ))}
                </tbody></table>
              </div>
            )
          case 'accommodation':
            return (
              <div key={i}>
                {(body.accommodation || []).map((row) => (
                  <AccomRow key={row.key} row={row} answers={a} editable={editable} missing={miss} onAnswer={on} />
                ))}
              </div>
            )
          case 'invoicing':
            return editable ? (
              <div key={i} style={sx.box}>
                <TextBox label="Name of the person to invoice (if not you)" value={a.invoiceName} onChange={(v) => on({ invoiceName: v })} />
                <TextBox label="Email of the person to be sent the invoice" type="email" value={a.invoiceEmail} onChange={(v) => on({ invoiceEmail: v })} />
              </div>
            ) : (
              <div key={i} style={sx.box}>
                <div><span style={sx.muted}>Invoice to </span>{a.invoiceName || '—'}</div>
                <div><span style={sx.muted}>Invoice email </span>{a.invoiceEmail || '—'}</div>
              </div>
            )
          case 'requirements':
            return editable
              ? <div key={i}><TextBox label="Special requirements (optional)" multiline value={a.requirements} onChange={(v) => on({ requirements: v })} /></div>
              : <div key={i} style={sx.box}><span style={{ whiteSpace: 'pre-line' }}>{a.requirements || 'None given.'}</span></div>
          case 'signatures':
            return <Signatures key={i} body={body} answers={a} signers={signers} oneSigner={oneSigner}
              editable={editable} missing={miss} onAnswer={on} />
          default: return null
        }
      })}
    </div>
  )
}
