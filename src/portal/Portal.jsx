import { useEffect, useState } from 'react'
import { supabase, rpc } from './supabase.js'
import Guests from './Guests.jsx'
import Checklist from './Checklist.jsx'
import VenueForm from './VenueForm.jsx'
import Contract from './Contract.jsx'
import Suppliers from './Suppliers.jsx'
import Timeline from './Timeline.jsx'
import Money from './Money.jsx'
import Layout from './Layout.jsx'
import Pinterest from './Pinterest.jsx'
import Items from './Items.jsx'
import Addons from './Addons.jsx'
import Food from './Food.jsx'
import Music from './Music.jsx'
import Drinks from './Drinks.jsx'
import Uploads from './Uploads.jsx'
import Webcast from './Webcast.jsx'
import ReadyBar, { READY_LABEL } from './ReadyBar.jsx'
import Icon from './Icon.jsx'

// Every tab the portal can draw. Which of them an event actually shows is the
// venue's choice, per event type and per event (wp_visible_sections). Overview
// is always first and always shown.
const TABS = {
  overview:    { label: 'Overview' },
  guests:      { label: 'Guests' },
  food:        { label: 'Food' },
  drinks:      { label: 'Drinks' },
  checklist:   { label: 'Checklist' },
  timeline:    { label: 'Timeline' },
  music:       { label: 'Music' },
  uploads:     { label: 'Photos & films' },
  webcast:     { label: 'Webcast' },
  suppliers:   { label: 'Suppliers' },
  layout:      { label: 'Table plan' },
  items:       { label: 'Bringing' },
  addons:      { label: 'Extras' },
  money:       { label: 'Payments' },
  details:     { label: 'Details' },
  documents:   { label: 'Documents' },
  inspiration: { label: 'Inspiration' },
}

// What the portal showed before sections could be chosen. Used if the newer
// database functions are not there yet — so pushing this code before the
// migration is applied leaves couples with exactly what they had, not a
// broken page.
const LEGACY_TABS = ['guests', 'checklist', 'timeline', 'suppliers', 'layout', 'money', 'details', 'documents', 'inspiration']

// The words that change with the kind of event. A wake is not "your wedding",
// and "we hope it was wonderful" is not the line to end one on.
const WORDS = {
  Wedding: { planner: 'Wedding planner', yours: 'Your wedding', loading: 'Opening your wedding…',
             after: 'We hope it was wonderful' },
  Party:   { planner: 'Party planner', yours: 'Your party', loading: 'Opening your party…',
             after: 'We hope you had a brilliant time' },
  Wake:    { planner: 'Planning the day', yours: 'The day', loading: 'Opening your plans…',
             after: 'Thank you for spending the day with us' },
  Other:   { planner: 'Event planner', yours: 'Your event', loading: 'Opening your plans…',
             after: 'Thank you for spending the day with us' },
}

export function kindOf(raw) {
  const k = String(raw || '').replace(/\s*\(.*?\)\s*$/, '').trim()
  return WORDS[k] ? k : 'Other'
}

function fmtDate(iso) {
  if (!iso) return null
  const d = new Date(iso + 'T12:00:00')
  if (isNaN(d)) return iso
  return d.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })
}

function hhmm(t) { return t ? String(t).slice(0, 5) : '' }

// Days, hours and minutes to the start of the day — the ceremony if we know
// it, otherwise midday, which is near enough for a countdown.
function countdown(dateIso, timeStr, now) {
  if (!dateIso) return null
  const target = new Date(dateIso + 'T' + (timeStr ? hhmm(timeStr) : '12:00') + ':00')
  if (isNaN(target)) return null
  const ms = target - now
  if (ms <= 0) {
    const sameDay = new Date(dateIso + 'T12:00:00').toDateString() === now.toDateString()
    return { past: !sameDay, today: sameDay }
  }
  const mins = Math.floor(ms / 60000)
  return { days: Math.floor(mins / 1440), hours: Math.floor((mins % 1440) / 60), minutes: mins % 60 }
}

// One place to stay: what it is, whether it is booked, and how full it is.
//
// The count is only shown for somewhere actually booked or held. On a place
// they have not taken, "0 of 6" invites the reading that they have six beds
// going spare — which is the opposite of true.
//
// Over capacity WARNS and never refuses. Somebody may well know something we
// do not: a travel cot, a child sharing, two people in a single. The house rule
// throughout is that the venue flags and the couple decides.
function AccomRow({ place }) {
  const taken = place.status === 'yes' || place.status === 'hold'
  const over = taken && place.allocated > place.sleeps
  return (
    <div className="row">
      <span className="k">{place.label}</span>
      <span className="v">
        {accomLabel(place.status)}
        {taken && place.sleeps > 0 && (
          <>
            <span className="dot">·</span>
            <span className={over ? 'over' : undefined}>
              {place.allocated} of {place.sleeps}
            </span>
            {place.sleeps_children > 0 && (
              <span className="muted" style={{ fontSize: 12 }}>
                {' '}({place.sleeps_adults} + {place.sleeps_children} child)
              </span>
            )}
          </>
        )}
      </span>
    </div>
  )
}

// "yes" / "no" / "undecided" as the diary stores them, in words a couple reads.
function accomLabel(v) {
  if (v === 'yes')  return 'Booked'
  if (v === 'hold') return 'Held'
  if (v === 'no')   return 'Not booked'
  return 'Not decided'
}

export default function Portal({ session }) {
  const [tab, setTab] = useState('overview')
  const [event, setEvent] = useState(null)
  const [home, setHome] = useState(null)        // null = the newer functions are not there
  const [state, setState] = useState('loading') // loading | ready | no_access | error
  const [error, setError] = useState('')

  async function loadHome() {
    try { setHome(await rpc('wp_get_home')) }
    catch (e) {
      // Not fatal: the portal falls back to the tabs it always had. Said in the
      // console rather than silently, so it is findable.
      console.warn('wp_get_home unavailable — showing the standard tabs:', e.message || e)
      setHome(null)
    }
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // Links this sign-in to the invitation and stamps the visit. Failure
        // here is not fatal — wp_my_event() answers the same question.
        try { await rpc('wp_touch_access') } catch (e) { /* no access; handled below */ }

        const data = await rpc('wp_my_event')
        if (cancelled) return
        await loadHome()
        if (cancelled) return
        setEvent(data)
        setState('ready')
      } catch (e) {
        if (cancelled) return
        if (e.code === 'no_access') { setState('no_access'); return }
        setError(e.message || String(e))
        setState('error')
      }
    })()
    return () => { cancelled = true }
  }, [])

  async function signOut() {
    await supabase.auth.signOut()
    window.location.reload()
  }

  if (state === 'loading') {
    return <div className="centre"><p className="muted">One moment…</p></div>
  }

  if (state === 'no_access') {
    return (
      <div className="centre">
        <div className="wrap narrow" style={{ padding: 0 }}>
          <div className="card">
            <div className="brand">Hawthbush Farm</div>
            <div className="brand-sub">Planning your day</div>
            <h2 style={{ marginTop: 20 }}>We can't find a booking</h2>
            <p className="muted" style={{ marginTop: 10 }}>
              You are signed in as <strong>{session.user.email}</strong>, but that address
              isn't linked to a booking with us. If you booked under a different email,
              sign in with that one. Otherwise drop us a line and we will add you.
            </p>
            <button className="btn-quiet" style={{ marginTop: 18 }} onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="centre">
        <div className="wrap narrow" style={{ padding: 0 }}>
          <div className="card">
            <h2>Something went wrong</h2>
            <p className="muted" style={{ marginTop: 10 }}>
              We couldn't load your booking just now. Please try again in a moment —
              and if it keeps happening, tell us and we will look into it.
            </p>
            <div className="alert alert-warn" style={{ fontSize: 12 }}>{error}</div>
            <button className="btn" onClick={() => window.location.reload()}>Try again</button>
            <button className="btn-quiet" style={{ marginTop: 14 }} onClick={signOut}>Sign out</button>
          </div>
        </div>
      </div>
    )
  }

  const kind = home ? kindOf(home.event_type) : kindOf(event.event_type)
  const words = WORDS[kind]
  const visible = ['overview'].concat(home ? (home.visible || []) : LEGACY_TABS)
  const current = visible.includes(tab) ? tab : 'overview'
  const sections = home ? (home.sections || []) : null

  function setSections(list) { setHome((h) => (h ? { ...h, sections: list } : h)) }

  // The "we're done with this" bar, under every tab that has one — only when
  // the database knows about it.
  const ready = sections && READY_LABEL[current]
    ? <ReadyBar section={current} sections={sections} onChange={setSections} />
    : null

  return (
    <>
      <header className="top">
        <div className="top-in">
          <div className="brand-row">
            {/* Served from this same site, so it works wherever the portal is
                hosted and needs no third-party request. */}
            <img className="brand-logo" src="/email-logo.png" alt="" aria-hidden="true" />
            <div>
              <div className="brand">Hawthbush Farm</div>
              <div className="brand-sub">{words.planner}</div>
            </div>
          </div>
          <div className="who">
            <span>{session.user.email}</span>
            <button className="btn-quiet" onClick={signOut}>Sign out</button>
          </div>
        </div>
      </header>

      <div className="tabs-bar">
        <nav className="tabs" role="tablist" aria-label={words.yours}>
          {visible.map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={current === k}
              className="tab"
              onClick={() => setTab(k)}
            >
              <Icon name={k} size={16} />
              {TABS[k].label}
              {sections && READY_LABEL[k] && <TabMark section={k} sections={sections} />}
            </button>
          ))}
        </nav>
      </div>

      <main className="wrap">
        {current === 'overview'    && <Overview event={event} home={home} words={words} visible={visible}
                                                onGo={setTab} onHome={loadHome} />}
        {current === 'guests'      && <Guests accommodation={event.accommodation} />}
        {current === 'food'        && <Food />}
        {current === 'drinks'      && <Drinks />}
        {current === 'checklist'   && <Checklist />}
        {current === 'timeline'    && <Timeline kind={kind} />}
        {current === 'music'       && <Music />}
        {current === 'uploads'     && <Uploads />}
        {current === 'webcast'     && <Webcast />}
        {current === 'suppliers'   && <Suppliers />}
        {current === 'layout'      && <Layout />}
        {current === 'items'       && <Items />}
        {current === 'addons'      && <Addons />}
        {current === 'money'       && <Money />}
        {current === 'details'     && <VenueForm />}
        {current === 'documents'   && <Contract />}
        {current === 'inspiration' && <Pinterest />}
        {ready}
      </main>
    </>
  )
}

// A small mark on a tab: a tick once it is sent to us, a dot if we have handed
// it back.
function TabMark({ section, sections }) {
  const s = sections.find((x) => x.section === section)
  if (!s) return null
  if (s.state === 'reopened') return <span className="tab-mark is-back" title="We have asked for a change" />
  return <Icon name="done" size={13} className="tab-tick" />
}

function Overview({ event, home, words, visible, onGo, onHome }) {
  const a = event.accommodation || {}
  const n = event.venue_numbers || {}
  const anyAccom = ['amly', 'hamlet', 'camping'].some((k) => a[k] === 'yes' || a[k] === 'hold')
  const [accom, setAccom] = useState(null)
  const [tasks, setTasks] = useState(null)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    if (!anyAccom) return
    let off = false
    rpc('wp_get_accommodation')
      .then((r) => { if (!off) setAccom(r) })
      .catch(() => { /* the panel falls back to booked/held on its own */ })
    return () => { off = true }
  }, [anyAccom])

  const showChecklist = visible.includes('checklist')
  useEffect(() => {
    if (!showChecklist) return
    let off = false
    rpc('wp_get_checklist')
      .then((r) => { if (!off) setTasks(r.items || []) })
      .catch(() => { if (!off) setTasks([]) })
    return () => { off = true }
  }, [showChecklist])

  // Once a minute is plenty for a countdown that shows minutes.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000)
    return () => clearInterval(t)
  }, [])

  const cd = countdown(event.date, home && home.ceremony_time, now)
  const cover = home && home.cover_url

  return (
    <>
      <section className={'card hero hero-photo' + (cover ? '' : ' no-photo')}
        style={cover ? { backgroundImage: 'url("' + cover.replace(/"/g, '%22') + '")' } : undefined}>
        <div className="hero-shade">
          <div className="couple">{event.couple || words.yours}</div>
          {event.date && <div className="when">{fmtDate(event.date)}</div>}
          {cd && !cd.past && !cd.today && (
            <div className="cd" aria-label={cd.days + ' days, ' + cd.hours + ' hours and ' + cd.minutes + ' minutes to go'}>
              <div className="cd-box"><span className="cd-n">{cd.days}</span><span className="cd-l">{cd.days === 1 ? 'day' : 'days'}</span></div>
              <div className="cd-box"><span className="cd-n">{cd.hours}</span><span className="cd-l">{cd.hours === 1 ? 'hour' : 'hours'}</span></div>
              <div className="cd-box"><span className="cd-n">{cd.minutes}</span><span className="cd-l">mins</span></div>
            </div>
          )}
          {cd && cd.today && <div className="countdown">Today</div>}
          {cd && cd.past && <div className="countdown">{words.after}</div>}
        </div>
      </section>

      {home && <ToDo home={home} tasks={showChecklist ? tasks : []} visible={visible} onGo={onGo} />}

      <section className="card">
        <h3>Your booking</h3>
        <div className="rows">
          <div className="row"><span className="k">Type</span><span className="v">{event.event_type}</span></div>
          {event.status && (
            <div className="row"><span className="k">Status</span><span className="v">{event.status}</span></div>
          )}
          {home && home.ceremony_time ? (
            <div className="row"><span className="k">Ceremony</span><span className="v">{hhmm(home.ceremony_time)}</span></div>
          ) : event.ceremony && (
            <div className="row"><span className="k">Ceremony</span><span className="v">{event.ceremony}</span></div>
          )}
          {event.guest_arrival && (
            <div className="row"><span className="k">Guests arrive</span><span className="v">{event.guest_arrival}</span></div>
          )}
        </div>
      </section>

      {anyAccom && (
        <section className="card">
          <h3>Staying with us</h3>
          <div className="rows">
            {(accom && accom.places ? accom.places : []).map((p) => (
              <AccomRow key={p.slug} place={p} />
            ))}
            {/* Until the counts load, the booked/held status on its own is
                still worth showing — it is the part that never changes. */}
            {!accom && (
              <>
                <div className="row"><span className="k">Amly</span><span className="v">{accomLabel(a.amly)}</span></div>
                <div className="row"><span className="k">The Hamlet</span><span className="v">{accomLabel(a.hamlet)}</span></div>
                <div className="row"><span className="k">Glamping</span><span className="v">{accomLabel(a.camping)}</span></div>
              </>
            )}
          </div>

          {accom && accom.unplaced > 0 && (
            <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
              <strong>{accom.unplaced}</strong>{' '}
              {accom.unplaced === 1 ? 'person is' : 'people are'} down as staying without
              somewhere to sleep yet — say where on the Guests tab.
            </p>
          )}
          {accom && accom.unplaced === 0 && (
            <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
              Everyone staying has somewhere to sleep. Names to actual rooms come later —
              we will sort that with you nearer the time.
            </p>
          )}
        </section>
      )}

      {(n.meal_guests || n.evening_total) && (
        <section className="card">
          <h3>Numbers we hold</h3>
          <div className="rows">
            {n.meal_guests   && <div className="row"><span className="k">Seated</span><span className="v">{n.meal_guests}</span></div>}
            {n.meal_children && <div className="row"><span className="k">Children</span><span className="v">{n.meal_children}</span></div>}
            {n.meal_babies   && <div className="row"><span className="k">Babies</span><span className="v">{n.meal_babies}</span></div>}
            {n.evening_total && <div className="row"><span className="k">Evening</span><span className="v">{n.evening_total}</span></div>}
          </div>
          <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
            These are the numbers we have written down.
            {visible.includes('guests') ? ' To change them, use the Guests tab.' : ' If they have changed, tell us.'}
          </p>
        </section>
      )}

      {home && <KeepInTouch ok={home.marketing_ok !== false} onSaved={onHome} />}
    </>
  )
}

// What still needs doing, in the order it matters: anything we have handed
// back first, then checklist deadlines that are late or close, then the tabs
// nobody has told us are finished.
function ToDo({ home, tasks, visible, onGo }) {
  const status = {}
  for (const s of home.sections || []) status[s.section] = s

  const rows = []
  for (const s of home.sections || []) {
    if (s.state === 'reopened' && visible.includes(s.section)) {
      rows.push({ key: 'r-' + s.section, icon: 'alert', warn: true, go: s.section,
        title: TABS[s.section].label + ' — we have asked for a change',
        detail: s.reopen_note })
    }
  }

  const today = new Date(new Date().toDateString())
  const open = (tasks || []).filter((t) => !t.done && t.due_on)
    .map((t) => ({ t, days: Math.round((new Date(t.due_on + 'T12:00:00') - today) / 86400000) }))
    .filter((x) => x.days <= 60)
    .sort((x, y) => x.days - y.days)
    .slice(0, 4)
  for (const { t, days } of open) {
    rows.push({ key: 't-' + t.id, icon: 'checklist', warn: days < 0, go: 'checklist', title: t.title,
      detail: days < 0 ? 'Was due ' + Math.abs(days) + ' day' + (Math.abs(days) === 1 ? '' : 's') + ' ago'
            : days === 0 ? 'Due today' : 'Due in ' + days + ' day' + (days === 1 ? '' : 's') })
  }

  const notSent = visible.filter((k) => READY_LABEL[k] && !status[k])
  if (notSent.length) {
    rows.push({ key: 'not-sent', icon: 'arrow', go: notSent[0],
      title: 'Not sent to us yet',
      detail: notSent.map((k) => TABS[k].label).join(', ') + '. When one is finished, press "We\'re done" at the bottom of that tab.' })
  }

  const sent = (home.sections || []).filter((s) => s.state === 'ready' && visible.includes(s.section))

  return (
    <section className="card">
      <h3>Still to do</h3>
      {rows.length === 0 ? (
        <p className="muted" style={{ fontSize: 14 }}>Nothing outstanding. Lovely.</p>
      ) : (
        <div className="todo">
          {rows.map((r) => (
            <button key={r.key} type="button" className={'todo-row' + (r.warn ? ' is-warn' : '')} onClick={() => onGo(r.go)}>
              <Icon name={r.icon} size={18} />
              <span className="todo-main">
                <span className="todo-title">{r.title}</span>
                {r.detail && <span className="todo-detail">{r.detail}</span>}
              </span>
              <span className="todo-go" aria-hidden="true">›</span>
            </button>
          ))}
        </div>
      )}
      {sent.length > 0 && (
        <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
          With us: {sent.map((s) => TABS[s.section].label + (s.changed_since ? ' (changed since)' : '')).join(', ')}.
        </p>
      )}
    </section>
  )
}

// Ticked to begin with. This is the "you can say no" that emailing a customer
// on the soft opt-in basis requires — not a request for consent, which a
// pre-ticked box could never be. The wording says what unticking does.
function KeepInTouch({ ok, onSaved }) {
  const [on, setOn] = useState(ok)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function change(v) {
    setOn(v); setBusy(true); setErr('')
    try { await rpc('wp_set_marketing', { p_ok: v }); await onSaved() }
    catch (e) { setOn(!v); setErr(e.message || String(e)) }
    finally { setBusy(false) }
  }

  return (
    <section className="card">
      <h3>Keeping in touch</h3>
      <label className="check" style={{ marginBottom: 6 }}>
        <input type="checkbox" checked={on} disabled={busy} onChange={(e) => change(e.target.checked)} />
        Send me the occasional email about events and offers at Hawthbush Farm
      </label>
      <p className="hint" style={{ marginTop: 0 }}>
        Untick if you would rather not. It makes no difference to anything about your
        booking — we will still email you about that. Every email also has an
        unsubscribe link.
      </p>
      {err && <div className="alert alert-warn">{err}</div>}
    </section>
  )
}
