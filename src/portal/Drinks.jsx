import { useEffect, useState } from 'react'
import { supabase, rpc } from './supabase.js'

// Drinks. For a wedding: the Classic Drinks Package or bring-your-own with
// corkage — plus a bespoke package, but only once we have written one for
// this event (bespoke_offered); otherwise it is not on the page at all. The evening bar is its own tab
// (part="bar"): whether they want a pay bar, how busy they expect it to be,
// and money behind it if they want.
//
// Every price here is inc VAT — that is how the whole system holds money.
// The arithmetic is done once, in the database (wp_drinks_summary); this page
// only shows what it says.
//
// Components that render inputs live at module scope — see Guests.jsx.

function money(v) {
  if (v === null || v === undefined || v === '') return '—'
  return '£' + Number(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00')
  return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')) }

const MOMENTS = {
  reception: { title: 'Drinks reception', per: (s) => s.reception_per_adult + ' drinks per adult' },
  wine:      { title: 'Wedding breakfast', per: (s) => s.wine_bottles_per_adult + ' bottle of wine per adult' },
  toast:     { title: 'The toast', per: (s) => s.toast_per_adult + ' glass per adult' },
}

export default function Drinks({ part = 'package', barTab = false, onGo }) {
  const [data, setData] = useState(null)
  const [state, setState] = useState('loading')
  const [error, setError] = useState('')

  async function load() {
    try { setData(await rpc('wp_get_drinks')); setState('ready') }
    catch (e) { setError(e.message || String(e)); setState('error') }
  }
  useEffect(() => { load() }, [])

  if (state === 'loading') return <section className="card"><p className="muted">Loading…</p></section>
  if (state === 'error') {
    return (
      <section className="card">
        <h2>We couldn't load your {part === 'bar' ? 'bar' : 'drinks'}</h2>
        <div className="alert alert-warn" style={{ fontSize: 12 }}>{error}</div>
        <button className="btn" onClick={load}>Try again</button>
      </section>
    )
  }

  if (part === 'bar') return <Bar data={data} onChanged={load} />

  const o = data.order || {}
  const sm = data.summary || {}
  const locked = !!sm.locked

  return (
    <>
      {!data.packages_offered && barTab && (
        <section className="card">
          <h3>Drinks</h3>
          <p className="muted" style={{ fontSize: 14 }}>
            Our drinks packages are for weddings. Your evening bar has its own page.
          </p>
          {onGo && <div className="actions"><button className="btn-small" onClick={() => onGo('bar')}>Go to the evening bar</button></div>}
        </section>
      )}
      {data.packages_offered && (
        <>
          <RouteChoice data={data} locked={locked} onChanged={load} />
          {locked && (
            <div className="alert alert-warn">
              Your drinks order is now final — it was due {fmtDate(sm.lock_date)}. If something needs to
              change, talk to us and we can reopen it.
            </div>
          )}
          {!locked && sm.lock_date && o.route && (
            <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
              Your order can be changed here until <strong>{fmtDate(sm.lock_date)}</strong>, when it becomes final.
            </p>
          )}
          {(o.route === 'classic' || o.route === 'corkage') && (
            <>
              <NumbersLine sm={sm} />
              {['reception', 'wine', 'toast'].map((m) => (
                <MomentCard key={m} moment={m} data={data} locked={locked} onChanged={load} />
              ))}
              <ExtrasCard data={data} locked={locked} onChanged={load} />
              <DetailsCard data={data} locked={locked} onChanged={load} />
              <TotalCard sm={sm} route={o.route} />
            </>
          )}
          {o.route === 'bespoke' && (
            <>
              <section className="card">
                <h3>{o.bespoke_name || 'Your bespoke package'}</h3>
                <p className="muted" style={{ fontSize: 14, whiteSpace: 'pre-line' }}>
                  {o.bespoke_note || 'The package we have agreed with you.'}
                </p>
              </section>
              {o.bespoke_pp !== null && o.bespoke_pp !== undefined && <NumbersLine sm={sm} />}
              <DetailsCard data={data} locked={locked} onChanged={load} />
              {o.bespoke_pp !== null && o.bespoke_pp !== undefined && <TotalCard sm={sm} route={o.route} />}
            </>
          )}
        </>
      )}

      {/* Without its own tab (the bar migration not applied yet, or the venue
          has switched the tab off for this event) the bar stays here, so
          nothing a client could do before disappears. */}
      {!barTab && <Bar data={data} onChanged={load} />}
    </>
  )
}

function RouteChoice({ data, locked, onChanged }) {
  const o = data.order || {}
  const s = data.settings
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [confirming, setConfirming] = useState(null)

  async function choose(route) {
    if (route === o.route) return
    if (o.route && (data.lines || []).length > 0 && confirming !== route) {
      setConfirming(route); return
    }
    setBusy(true); setErr(''); setConfirming(null)
    try { await rpc('wp_set_drinks_route', { p_route: route }); await onChanged() }
    catch (e) {
      setErr(e.code === 'locked' ? 'Your order is now final — talk to us to change it.'
        : e.code === 'not_offered' ? 'That package is not available — talk to us.'
        : (e.message || String(e)))
    }
    finally { setBusy(false) }
  }

  const options = [
    { k: 'classic', name: 'Classic Drinks Package', price: money(s.classic_pp) + ' a head',
      desc: 'Two reception drinks, half a bottle of house wine with the meal and a glass of Prosecco for the toast, per guest. Tea and coffee after dinner. Glassware, chilling and service included.' },
    { k: 'corkage', name: 'Bring your own (corkage)', price: money(s.corkage_pp) + ' a head',
      desc: 'You supply the drinks — up to two before the meal, half a bottle of wine with it and a glass of fizz for the toast, per guest. We chill, pour and serve. Anything more is charged by the bottle.' },
  ]
  // A bespoke package appears only once we have written one for this event —
  // or if they already chose it under the old wording.
  if (o.bespoke_offered || o.route === 'bespoke') {
    const priced = o.bespoke_pp !== null && o.bespoke_pp !== undefined
    options.push({ k: 'bespoke', name: o.bespoke_name || 'Your bespoke package', made: true,
      price: priced ? money(o.bespoke_pp) + ' a head' : 'As agreed with us',
      desc: o.bespoke_note || 'The package we have put together with you.' })
  }

  return (
    <section className="card">
      <h3>How would you like to do the drinks?</h3>
      <div className="choice-list">
        {options.map((x) => (
          <label key={x.k} className={'choice' + (o.route === x.k ? ' is-on' : '')}>
            <input type="radio" name="route" checked={o.route === x.k} disabled={busy || locked} onChange={() => choose(x.k)} />
            <span>
              <span className="choice-name">{x.name}{x.made && <span className="chip" style={{ marginLeft: 8 }}>Made for you</span>}</span>
              <span className="choice-meta">{x.price}{x.k !== 'bespoke' ? ' inc VAT · children ' + (Number(s.child_pp) > 0 ? money(s.child_pp) : 'free') + ' · infants free'
                : (o.bespoke_pp !== null && o.bespoke_pp !== undefined ? ' inc VAT, per adult' : '')}</span>
              <span className="choice-desc" style={{ whiteSpace: 'pre-line' }}>{x.desc}</span>
            </span>
          </label>
        ))}
      </div>
      {confirming && (
        <div className="alert alert-warn">
          Changing package clears the choices you have made under the current one.{' '}
          <button className="btn-small" onClick={() => choose(confirming)} disabled={busy}>Change anyway</button>{' '}
          <button className="btn-small ghost" onClick={() => setConfirming(null)}>Keep it</button>
        </div>
      )}
      {err && <div className="alert alert-warn">{err}</div>}
    </section>
  )
}

function NumbersLine({ sm }) {
  return (
    <section className="card">
      <h3>Who it is for</h3>
      {sm.numbers_missing ? (
        <p className="muted" style={{ fontSize: 14 }}>
          Tell us your numbers on the Guests tab first — the allowances are worked out from them.
        </p>
      ) : (
        <p style={{ fontSize: 15 }}>
          <strong>{plural(sm.adults, 'adult')}</strong> at {money(sm.rate_pp)}
          {sm.children > 0 && <> · {plural(sm.children, 'child', 'children')} at {Number(sm.child_rate_pp) > 0 ? money(sm.child_rate_pp) : 'no charge'}</>}
          {sm.infants > 0 && <> · {plural(sm.infants, 'infant')} free</>}
        </p>
      )}
      <p className="hint">Evening-only guests are not included — the package ends with the wedding breakfast. Children have soft drinks.</p>
    </section>
  )
}

// One allowance — reception, the meal or the toast — and what it is spent on.
function MomentCard({ moment, data, locked, onChanged }) {
  const o = data.order
  const route = o.route
  const sm = data.summary
  const info = (sm.moments || []).find((x) => x.moment === moment) || { allowance: 0, used: 0, cost: 0, lines: [] }
  const lines = (data.lines || []).filter((l) => l.moment === moment)
  const options = (data.catalogue || []).filter((c) => c.route === route && c.moment === moment)
  const allowedOptions = options.filter((c) => c.allowed)
  const notAllowed = options.filter((c) => !c.allowed)
  const over = Number(info.used) - Number(info.allowance)
  const overByLine = {}
  for (const x of info.lines || []) overByLine[x.id] = x
  // Under corkage the bottle that runs past the allowance is free (we round up
  // to a full bottle), so being a few drinks over is not a warning — only a
  // whole bottle beyond it is.
  const charged = route === 'corkage'
    ? (info.lines || []).some((x) => Number(x.over_units) > 0)
    : over > 0

  return (
    <section className="card">
      <div className="list-head">
        <div>
          <h3 style={{ marginBottom: 4 }}>{MOMENTS[moment].title}</h3>
          <p className="muted" style={{ fontSize: 13 }}>
            {route === 'classic' ? 'Your allowance' : 'You can bring'}: <strong>{info.allowance} {info.unit}</strong>
            {' '}({MOMENTS[moment].per(data.settings)}).
            {route === 'classic' ? ' Choose how it is split.' : ' Tell us what you are bringing.'}
          </p>
        </div>
        <span className={'count' + (charged ? ' count-warn' : '')}>{Number(info.used)} / {info.allowance}</span>
      </div>

      {lines.length > 0 && (
        <div className="guests">
          {lines.map((l) => (
            <LineRow key={l.id} line={l} locked={locked} route={route} over={overByLine[l.id]} onChanged={onChanged} />
          ))}
        </div>
      )}

      {route === 'classic' && over > 0 && (
        <p className="hint" style={{ color: 'var(--warn)' }}>
          That is {over} {info.unit} more than the package includes. For more, add extra drinks below.
        </p>
      )}
      {route === 'classic' && over < 0 && lines.length > 0 && (
        <p className="hint">{-over} {info.unit} still to choose.</p>
      )}
      {route === 'corkage' && lines.length > 0 && (
        <p className="hint">
          We round up to a full bottle: the bottle that takes you past your allowance is on us.
          Only whole bottles beyond it are charged.
        </p>
      )}
      {route === 'corkage' && Number(info.cost) > 0 && (
        <p className="hint" style={{ color: 'var(--warn)' }}>
          More than the allowance — additional corkage of {money(info.cost)} (shown against each line).
        </p>
      )}

      {!locked && allowedOptions.length > 0 && <AddLine options={allowedOptions} route={route} onChanged={onChanged} />}
      {notAllowed.length > 0 && (
        <p className="hint">Not allowed: {notAllowed.map((c) => c.name.toLowerCase()).join(', ')}.</p>
      )}
    </section>
  )
}

function LineRow({ line, locked, route, over, onChanged }) {
  const [qty, setQty] = useState(String(line.qty))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function save(v) {
    const n = parseInt(v, 10)
    if (!Number.isFinite(n) || n < 1 || n === line.qty) { setQty(String(line.qty)); return }
    setBusy(true); setErr('')
    try { await rpc('wp_save_drinks_line', { p_id: line.id, p_catalogue_id: null, p_qty: n }); await onChanged() }
    catch (e) { setErr(e.code === 'locked' ? 'Your order is now final.' : (e.message || String(e))); setQty(String(line.qty)) }
    finally { setBusy(false) }
  }
  async function remove() {
    setBusy(true); setErr('')
    try { await rpc('wp_delete_drinks_line', { p_id: line.id }); await onChanged() }
    catch (e) { setErr(e.code === 'locked' ? 'Your order is now final.' : (e.message || String(e))); setBusy(false) }
  }

  const priceText = line.unit_price === null || line.unit_price === undefined
    ? 'price to be confirmed'
    : line.moment === 'extra' || line.moment === 'soft'
      ? money(line.unit_price) + ' a ' + line.unit
    : route === 'classic'
      ? (Number(line.unit_price) > 0 ? '+' + money(line.unit_price) + ' a ' + line.unit : 'included')
      : null

  return (
    <div className="guest">
      <div className="guest-main">
        <span className="guest-name">{line.name}</span>
        <span className="guest-side">
          {line.unit}s{route === 'corkage' && Number(line.drinks_per_unit) !== 1 ? ' · ' + Number(line.drinks_per_unit) + ' a ' + line.unit : ''}
          {priceText ? ' · ' + priceText : ''}
        </span>
        {over && over.over_units > 0 && (
          <div className="guest-note" style={{ color: 'var(--warn)' }}>
            {plural(over.over_units, line.unit)} over the allowance{over.over_cost > 0 ? ' — ' + money(over.over_cost) + ' additional corkage' : ' — price to be confirmed'}
          </div>
        )}
        {err && <div className="guest-note err">{err}</div>}
      </div>
      <div className="guest-actions">
        <input className="qty" type="number" min="1" value={qty} disabled={locked || busy} aria-label={'How many ' + line.name}
          onChange={(e) => setQty(e.target.value)} onBlur={(e) => save(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
        {!locked && <button className="btn-small ghost" onClick={remove} disabled={busy}>Remove</button>}
      </div>
    </div>
  )
}

function AddLine({ options, route, onChanged }) {
  const [pick, setPick] = useState('')
  const [qty, setQty] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function add(e) {
    e.preventDefault()
    const n = parseInt(qty, 10)
    if (!pick) { setErr('Choose one first.'); return }
    if (!Number.isFinite(n) || n < 1) { setErr('How many?'); return }
    setBusy(true); setErr('')
    try {
      await rpc('wp_save_drinks_line', { p_id: null, p_catalogue_id: pick, p_qty: n })
      setPick(''); setQty(''); await onChanged()
    } catch (e2) {
      setErr(e2.code === 'locked' ? 'Your order is now final.' : e2.code === 'not_allowed' ? 'That is not allowed, sorry.' : (e2.message || String(e2)))
    } finally { setBusy(false) }
  }

  const chosen = options.find((c) => c.id === pick)
  return (
    <form className="add-line" onSubmit={add}>
      <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Choose a drink">
        <option value="">{route === 'classic' ? 'Add a choice…' : 'Add something you are bringing…'}</option>
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {route === 'classic' ? (c.price_on_request ? ' (price on request)' : Number(c.price) > 0 ? ' (+' + money(c.price) + ')' : '') : ''}
          </option>
        ))}
      </select>
      <input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} placeholder={chosen ? chosen.unit + 's' : 'How many'} />
      <button className="btn-small" type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add'}</button>
      {err && <div className="alert alert-warn" style={{ flexBasis: '100%' }}>{err}</div>}
    </form>
  )
}

// Classic: extras and upgrades by the unit. Corkage: soft-drink jugs.
function ExtrasCard({ data, locked, onChanged }) {
  const route = data.order.route
  const moment = route === 'classic' ? 'extra' : 'soft'
  const lines = (data.lines || []).filter((l) => l.moment === moment)
  const options = (data.catalogue || []).filter((c) => c.route === route && c.moment === moment && c.allowed)
  if (!options.length && !lines.length) return null
  return (
    <section className="card">
      <h3 style={{ marginBottom: 4 }}>{route === 'classic' ? 'Make it yours' : 'Soft drinks'}</h3>
      <p className="muted" style={{ fontSize: 13 }}>
        {route === 'classic'
          ? 'Add to your package — extra fizz or beer, a beer trough, an after-dinner cocktail. Priced by what you choose; anything marked "price on request" we will confirm.'
          : 'We provide water. Sparkling elderflower and squash can be added by the jug.'}
      </p>
      {lines.length > 0 && (
        <div className="guests">
          {lines.map((l) => <LineRow key={l.id} line={l} locked={locked} route="classic" onChanged={onChanged} />)}
        </div>
      )}
      {!locked && <AddLine options={options} route="classic" onChanged={onChanged} />}
    </section>
  )
}

function DetailsCard({ data, locked, onChanged }) {
  const o = data.order
  const [soft, setSoft] = useState(o.soft_choice || 'elderflower')
  const [notes, setNotes] = useState(o.notes || '')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState('')

  async function save(e) {
    e.preventDefault()
    setBusy(true); setErr(''); setSaved(false)
    try {
      await rpc('wp_save_drinks_details', { p_soft_choice: o.route === 'classic' ? soft : '', p_notes: notes })
      setSaved(true); await onChanged()
    } catch (e2) { setErr(e2.code === 'locked' ? 'Your order is now final.' : (e2.message || String(e2))) }
    finally { setBusy(false) }
  }

  return (
    <form className="card" onSubmit={save}>
      <h3>Anything else</h3>
      {o.route === 'classic' && (
        <>
          <label>On the tables, with water</label>
          <div className="yesno" style={{ marginBottom: 14 }}>
            <label className="radio"><input type="radio" checked={soft === 'elderflower'} disabled={locked} onChange={() => setSoft('elderflower')} /> Sparkling elderflower</label>
            <label className="radio"><input type="radio" checked={soft === 'squash'} disabled={locked} onChange={() => setSoft('squash')} /> Squash instead</label>
          </div>
        </>
      )}
      <label>Notes for us <span className="opt">optional</span></label>
      <textarea rows="3" value={notes} disabled={locked} onChange={(e) => setNotes(e.target.value)}
        placeholder={o.route === 'classic' ? 'Which wines, a favourite cocktail…'
          : o.route === 'corkage' ? 'When the drinks will arrive, anything we should know…' : 'Anything we should know…'} />
      {err && <div className="alert alert-warn">{err}</div>}
      {saved && !err && <div className="alert alert-ok">Saved.</div>}
      {!locked && <div className="actions"><button className="btn-small" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>}
    </form>
  )
}

function TotalCard({ sm, route }) {
  return (
    <section className="card">
      <h3>So far</h3>
      <div className="totals-line">
        <strong>{money(sm.total)}</strong> inc VAT
        <span className="dot">·</span>includes {money(sm.vat)} VAT
      </div>
      {sm.unpriced > 0 && (
        <p className="hint" style={{ color: 'var(--warn)' }}>
          Plus {plural(sm.unpriced, 'item')} we still need to price for you.
        </p>
      )}
      <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
        {route === 'corkage' ? 'Corkage is invoiced once your order is final. ' : 'Your drinks are invoiced once your order is final. '}
        The figure moves with your numbers until then. Your invoice is the final word.
      </p>
    </section>
  )
}

// The evening bar. A tick to say they want one; how busy they expect it, which
// is what the staffing is planned from; and money behind it.
//
// Nothing here has a Save button. The tick and the choice save as they are
// made, the rules when the box is left. Money behind the bar: they choose an
// amount, pay on a Stripe page made for exactly that amount, and Stripe tells
// us — so what shows here is only ever money that has actually arrived, with
// the date, and nobody records it by hand.
const USAGE = [
  { k: 'less',    label: 'Less than average' },
  { k: 'average', label: 'Average' },
  { k: 'more',    label: 'More than average' },
]

function Bar({ data, onChanged }) {
  const o = data.order || {}
  const s = data.settings || {}
  // Older database: none of the new fields come back, and the old form is the
  // honest thing to show.
  const hasPrefs = 'pay_bar' in o
  const [payBar, setPayBar] = useState(o.pay_bar === true)
  const [usage, setUsage] = useState(o.bar_usage || '')
  const [rules, setRules] = useState(o.bar_rules || '')
  const [busy, setBusy] = useState(false)
  const [savedWhat, setSavedWhat] = useState('')
  const [err, setErr] = useState('')
  const [email, setEmail] = useState('')
  const [opened, setOpened] = useState(false)

  useEffect(() => { supabase.auth.getSession().then(({ data: d }) => setEmail((d.session && d.session.user.email) || '')) }, [])

  async function save(args, what, undo) {
    setBusy(true); setErr(''); setSavedWhat('')
    try {
      await rpc('wp_save_bar_prefs', Object.assign({ p_pay_bar: null, p_usage: null, p_rules: null }, args))
      setSavedWhat(what); await onChanged()
    } catch (e) { if (undo) undo(); setErr(e.message || String(e)) }
    finally { setBusy(false) }
  }

  // Their event goes along as client_reference_id, so the payment can be
  // matched to the booking in Stripe; the amount is chosen on Stripe's page.
  const payUrl = s.bar_link_url
    ? s.bar_link_url + (s.bar_link_url.includes('?') ? '&' : '?') +
      'client_reference_id=event-' + data.event_id + (email ? '&prefilled_email=' + encodeURIComponent(email) : '')
    : null
  const added = Number(o.bar_paid_amount) > 0
  // Newer database: payments are recorded by Stripe itself (bar-checkout.js
  // and the ticket webhook), and listed here. Older: the payment link above.
  const hasPayments = Array.isArray(o.bar_payments)
  const [returned] = useState(() => readReturn())

  // Back from Stripe: the webhook usually lands within seconds, so look again
  // a few times rather than asking them to refresh.
  useEffect(() => {
    if (returned !== 'thanks') return
    let n = 0
    const t = setInterval(() => { n += 1; onChanged(); if (n >= 8) clearInterval(t) }, 4000)
    return () => clearInterval(t)
  }, [returned])

  if (!hasPrefs) return <OldBarCard data={data} onChanged={onChanged} />
  const pays = hasPayments ? o.bar_payments : []
  const paid = pays.filter((p) => p.status === 'paid')
  const pending = pays.filter((p) => p.status === 'pending')
  const refunds = paid.filter((p) => Number(p.refunded_amount) > 0)

  return (
    <>
      <section className="card">
        <h3>The evening bar</h3>
        <label className="check" style={{ marginBottom: 10 }}>
          <input type="checkbox" checked={payBar} disabled={busy}
            onChange={(e) => {
              const v = e.target.checked
              setPayBar(v)
              save({ p_pay_bar: v }, v ? 'pay bar' : 'no bar', () => setPayBar(!v))
            }} />
          <strong style={{ fontWeight: 500 }}>We would like a pay bar</strong>
        </label>
        <p className="muted" style={{ fontSize: 14 }}>
          A pay bar is where your guests buy their own drinks. If you would like to treat
          them, you can put money behind the bar as well.
        </p>
        {s.bar_menu_url && (
          <div className="actions">
            <a className="btn-small ghost" href={s.bar_menu_url} target="_blank" rel="noreferrer">Our bar menu and prices ↗</a>
          </div>
        )}
        {s.bar_note && <p className="hint" style={{ marginTop: 10 }}>{s.bar_note}</p>}
        {savedWhat === 'pay bar' && <div className="alert alert-ok">Noted — you would like a pay bar.</div>}
        {savedWhat === 'no bar' && <div className="alert alert-ok">Noted — no bar for now.</div>}
        {err && <div className="alert alert-warn">{err}</div>}
      </section>

      {payBar && (
        <section className="card">
          <h3>How busy will the bar be?</h3>
          <p className="muted" style={{ fontSize: 14 }}>
            We staff your bar according to the number of adults in the evening. Let us know
            here if you think your crowd will use the bar less than average, average or more
            than average — just put average if you are unsure. It helps us get the staffing right.
          </p>
          <div className="yesno" style={{ marginTop: 12 }}>
            {USAGE.map((u) => (
              <label key={u.k} className="radio">
                <input type="radio" name="bar_usage" checked={usage === u.k} disabled={busy}
                  onChange={() => {
                    const was = usage
                    setUsage(u.k)
                    save({ p_usage: u.k }, 'usage', () => setUsage(was))
                  }} />
                {u.label}
              </label>
            ))}
          </div>
          {savedWhat === 'usage' && <p className="hint" style={{ color: 'var(--accent)' }}>Thank you — noted.</p>}
        </section>
      )}

      {payBar && (
        <section className="card">
          <h3>Put money behind the bar</h3>
          {returned === 'cancelled' && (
            <div className="alert alert-warn" style={{ marginTop: 0 }}>The payment was cancelled — nothing was taken.</div>
          )}
          {hasPayments ? (
            <AddMoney added={paid.length > 0} />
          ) : payUrl ? (
            <>
              <div className="actions">
                <a className="btn-small" href={payUrl} target="_blank" rel="noreferrer" onClick={() => setOpened(true)}>
                  {added ? 'Add more now' : 'Pay now'}
                </a>
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                Opens our secure card payment page, where you choose the amount.
                {opened ? ' Once it reaches us it will show here — usually within a day.' : ''}
              </p>
            </>
          ) : (
            <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
              We will send you a way to pay this nearer the time.
            </p>
          )}

          <label style={{ marginTop: 16 }}>Any rules <span className="opt">optional</span></label>
          <input value={rules} disabled={busy} onChange={(e) => setRules(e.target.value)}
            onBlur={() => { if (rules !== (o.bar_rules || '')) save({ p_rules: rules }, 'rules') }}
            placeholder="e.g. beer and wine only, no spirits" />
          {savedWhat === 'rules' && <p className="hint" style={{ color: 'var(--accent)' }}>Saved.</p>}
          <p className="hint" style={{ marginTop: 10 }}>
            When the tab runs out, the bar goes back to pay as you go. Anything left over is refunded
            to the card you paid with.
          </p>
        </section>
      )}

      {(payBar || paid.length > 0 || added) && (
        <section className="card">
          <h3>Paid</h3>
          {returned === 'thanks' && pending.length > 0 && (
            <div className="alert alert-ok" style={{ marginTop: 0 }}>
              Thank you — we're just waiting for the card payment to confirm. It will show here in a moment.
            </div>
          )}
          {hasPayments ? <BarPaid paid={paid} pending={pending} returned={returned} />
            : added ? (
              <div className="alert alert-ok" style={{ marginTop: 0 }}>
                <strong>{money(o.bar_paid_amount)}</strong> behind the bar
                {o.bar_paid_at ? ' — received ' + fmtDate(o.bar_paid_at) : ''}. Thank you.
              </div>
            ) : <p className="muted" style={{ fontSize: 14 }}>Nothing paid yet.</p>}
        </section>
      )}

      {hasPayments && (payBar || paid.length > 0) && (
        <section className="card">
          <h3>Refunded</h3>
          <BarRefunded refunds={refunds} />
        </section>
      )}
    </>
  )
}

// ?bar=thanks / ?bar=cancelled on the way back from Stripe. Read once, then
// taken out of the address bar so a reload does not say it again.
function readReturn() {
  try {
    const q = new URLSearchParams(window.location.search)
    const v = q.get('bar')
    if (v) {
      q.delete('bar')
      const rest = q.toString()
      window.history.replaceState(null, '', window.location.pathname + (rest ? '?' + rest : '') + window.location.hash)
    }
    return v === 'thanks' || v === 'cancelled' ? v : null
  } catch (e) { return null }
}

function BarPaid({ paid, pending, returned }) {
  const gross = paid.reduce((t, p) => t + Number(p.amount || 0), 0)
  const back = paid.reduce((t, p) => t + Number(p.refunded_amount || 0), 0)
  return (
    <>
      {paid.length === 0 ? (
        <p className="muted" style={{ fontSize: 14 }}>Nothing paid yet.</p>
      ) : (
        <div className="rows">
          {paid.map((p) => (
            <div className="row" key={p.id}>
              <span className="k">{fmtDate(p.paid_at)}{p.source === 'staff' ? ' · recorded by us' : ' · by card'}</span>
              <span className="v">{money(p.amount)}</span>
            </div>
          ))}
          {paid.length > 1 && (
            <div className="row"><span className="k"><strong>Paid in all</strong></span><span className="v"><strong>{money(gross)}</strong></span></div>
          )}
          {back > 0 && (
            <div className="row"><span className="k"><strong>Behind the bar after refunds</strong></span><span className="v"><strong>{money(gross - back)}</strong></span></div>
          )}
        </div>
      )}
      {pending.length > 0 && returned !== 'thanks' && (
        <p className="hint">{pending.map((p) => money(p.amount)).join(', ')} started on the card page and not finished — it will disappear if it isn't completed.</p>
      )}
      {paid.length > 0 && <p className="hint" style={{ marginTop: 8 }}>We email you a receipt each time.</p>}
    </>
  )
}

function BarRefunded({ refunds }) {
  if (refunds.length === 0) {
    return <p className="muted" style={{ fontSize: 14 }}>Nothing has been refunded.</p>
  }
  const total = refunds.reduce((t, p) => t + Number(p.refunded_amount || 0), 0)
  return (
    <>
      <div className="rows">
        {refunds.map((p) => (
          <div className="row" key={p.id}>
            <span className="k">
              {p.refunded_at ? fmtDate(p.refunded_at) : 'Refunded'}
              <span className="muted"> · from {money(p.amount)} paid {fmtDate(p.paid_at)}</span>
            </span>
            <span className="v">{money(p.refunded_amount)}</span>
          </div>
        ))}
        {refunds.length > 1 && (
          <div className="row"><span className="k"><strong>Refunded in all</strong></span><span className="v"><strong>{money(total)}</strong></span></div>
        )}
      </div>
      <p className="hint" style={{ marginTop: 8 }}>Refunds go back to the card that paid, and can take a few working days to arrive.</p>
    </>
  )
}

const PRESETS = [100, 250, 500, 1000]

function AddMoney({ added }) {
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function go(e) {
    e.preventDefault()
    const n = Math.round(Number(amount) * 100) / 100
    if (!Number.isFinite(n) || n < 10 || n > 5000) { setErr('Choose an amount between £10 and £5,000.'); return }
    setBusy(true); setErr('')
    try {
      const { data: d } = await supabase.auth.getSession()
      const token = d.session && d.session.access_token
      const res = await fetch('/.netlify/functions/bar-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || '') },
        body: JSON.stringify({ amount: n }),
      })
      const text = await res.text()
      let body = null; try { body = text ? JSON.parse(text) : null } catch (x) { body = null }
      if (!res.ok || !body || !body.url) throw new Error((body && body.error) || 'The payment page could not be opened (' + res.status + ').')
      window.location.assign(body.url)
    } catch (e2) { setErr(e2.message || String(e2)); setBusy(false) }
  }

  return (
    <form onSubmit={go} style={{ marginTop: 4 }}>
      <label>{added ? 'Add more' : 'How much would you like to put behind the bar?'} <span className="opt">£</span></label>
      <div className="add-line">
        <input type="number" min="10" max="5000" step="1" inputMode="decimal" value={amount}
          onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 500" aria-label="Amount in pounds" />
        <button className="btn-small" type="submit" disabled={busy}>{busy ? 'Opening…' : 'Pay now'}</button>
      </div>
      <div className="actions" style={{ marginTop: 8 }}>
        {PRESETS.map((v) => (
          <button key={v} type="button" className="btn-small ghost" onClick={() => setAmount(String(v))}>£{v}</button>
        ))}
      </div>
      {err && <div className="alert alert-warn">{err}</div>}
      <p className="hint" style={{ marginTop: 8 }}>
        Takes you to our secure card payment page for that amount, then straight back here.
        It shows under Paid as soon as it goes through, and we email you a receipt.
      </p>
    </form>
  )
}

// Before the 23 Oct (c) migration: the form as it was, so pushing the code first
// changes nothing for anybody.
function OldBarCard({ data, onChanged }) {
  const o = data.order || {}
  const s = data.settings || {}
  const [amount, setAmount] = useState(o.bar_amount ?? '')
  const [rules, setRules] = useState(o.bar_rules || '')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState('')
  const [email, setEmail] = useState('')

  useEffect(() => { supabase.auth.getSession().then(({ data: d }) => setEmail((d.session && d.session.user.email) || '')) }, [])

  async function save(e) {
    e.preventDefault()
    setBusy(true); setErr(''); setSaved(false)
    try {
      await rpc('wp_save_bar_tab', { p_amount: amount === '' ? null : Number(amount), p_rules: rules })
      setSaved(true); await onChanged()
    } catch (e2) { setErr(e2.message || String(e2)) }
    finally { setBusy(false) }
  }

  // Their event goes along as client_reference_id, so the payment can be
  // matched to the booking in Stripe; the amount is chosen on Stripe's page.
  let payUrl = null
  if (s.bar_link_url && Number(o.bar_amount) > 0) {
    payUrl = s.bar_link_url + (s.bar_link_url.includes('?') ? '&' : '?') +
      'client_reference_id=event-' + data.event_id + (email ? '&prefilled_email=' + encodeURIComponent(email) : '')
  }
  const prices = (s.bar_prices || []).filter((p) => p && p.name)

  return (
    <>
      <section className="card">
        <h3>The evening bar</h3>
        <p className="muted" style={{ fontSize: 14 }}>
          The bar is a pay bar — your guests buy their own drinks. If you would like to treat
          them, you can put money behind the bar.
        </p>
        {prices.length > 0 && (
          <div className="rows" style={{ marginTop: 12 }}>
            {prices.map((p, i) => (
              <div className="row" key={i}><span className="k">{p.name}</span><span className="v">{p.price === null || p.price === undefined || p.price === '' ? '—' : money(p.price)}</span></div>
            ))}
          </div>
        )}
        {s.bar_note && <p className="hint" style={{ marginTop: 10 }}>{s.bar_note}</p>}
      </section>

      <form className="card" onSubmit={save}>
        <h3>Money behind the bar</h3>
        <div className="namegrid">
          <div>
            <label>How much <span className="opt">£</span></label>
            <input type="number" min="0" step="10" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 500" />
          </div>
          <div>
            <label>Any rules <span className="opt">optional</span></label>
            <input value={rules} onChange={(e) => setRules(e.target.value)} placeholder="e.g. beer and wine only, no spirits" />
          </div>
        </div>
        {err && <div className="alert alert-warn">{err}</div>}
        {saved && !err && <div className="alert alert-ok">Saved.</div>}
        <div className="actions">
          <button className="btn-small" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          {payUrl && !o.bar_paid_amount && (
            <a className="btn-small ghost" href={payUrl} target="_blank" rel="noreferrer">Pay {money(o.bar_amount)} by card</a>
          )}
        </div>
        {o.bar_paid_amount ? (
          <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>
            <strong>{money(o.bar_paid_amount)}</strong> received{o.bar_paid_at ? ' on ' + fmtDate(o.bar_paid_at) : ''} — thank you.
          </p>
        ) : Number(o.bar_amount) > 0 && !s.bar_link_url ? (
          <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>We will send you a way to pay this nearer the time.</p>
        ) : null}
        <p className="hint" style={{ marginTop: 10 }}>
          When the tab runs out, the bar goes back to pay as you go. Anything left over is refunded
          to the card you paid with.
        </p>
      </form>
    </>
  )
}
