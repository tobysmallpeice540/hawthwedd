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

// The eight tabs from the build spec. Only Overview is built; the rest declare
// themselves honestly rather than pretending. Order matches the order a couple
// actually needs them in, not the order they get built.
const TABS = [
  { key: 'overview',  label: 'Overview',      ready: true  },
  { key: 'guests',    label: 'Guests',        ready: true  },
  { key: 'checklist', label: 'Checklist',     ready: true  },
  { key: 'timeline',  label: 'Timeline',      ready: true  },
  { key: 'suppliers', label: 'Suppliers',     ready: true  },
  { key: 'layout',    label: 'Table plan',    ready: true  },
  { key: 'money',     label: 'Payments',      ready: true  },
  { key: 'details',   label: 'Details',       ready: true  },
  { key: 'contract',  label: 'Contract',      ready: true  },
  { key: 'pinterest', label: 'Inspiration',   ready: true  },
]

function fmtDate(iso) {
  if (!iso) return null
  const d = new Date(iso + 'T12:00:00')
  if (isNaN(d)) return iso
  return d.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })
}

function daysUntil(iso) {
  if (!iso) return null
  const then = new Date(iso + 'T12:00:00')
  if (isNaN(then)) return null
  const now = new Date()
  return Math.round((then - new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12)) / 86400000)
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
  const [state, setState] = useState('loading')   // loading | ready | no_access | error
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // Links this sign-in to the invitation and stamps the visit. Failure
        // here is not fatal — wp_my_event() answers the same question.
        try { await rpc('wp_touch_access') } catch (e) { /* no access; handled below */ }

        const data = await rpc('wp_my_event')
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
    return <div className="centre"><p className="muted">Opening your wedding…</p></div>
  }

  if (state === 'no_access') {
    return (
      <div className="centre">
        <div className="wrap narrow" style={{ padding: 0 }}>
          <div className="card">
            <div className="brand">Hawthbush Farm</div>
            <div className="brand-sub">Wedding planner</div>
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
              We couldn't load your wedding just now. Please try again in a moment —
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

  const days = daysUntil(event.date)
  const active = TABS.find((t) => t.key === tab)

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
              <div className="brand-sub">Wedding planner</div>
            </div>
          </div>
          <div className="who">
            <span>{session.user.email}</span>
            <button className="btn-quiet" onClick={signOut}>Sign out</button>
          </div>
        </div>
      </header>

      <nav className="tabs" role="tablist" aria-label="Your wedding">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className="tab"
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {!t.ready && <span className="soon">soon</span>}
          </button>
        ))}
      </nav>

      <main className="wrap">
        {tab === 'overview' && <Overview event={event} days={days} />}
        {tab === 'guests'    && <Guests accommodation={event.accommodation} />}
        {tab === 'checklist' && <Checklist />}
        {tab === 'details'   && <VenueForm />}
        {tab === 'contract'  && <Contract />}
        {tab === 'suppliers' && <Suppliers />}
        {tab === 'timeline'  && <Timeline />}
        {tab === 'money'     && <Money />}
        {tab === 'layout'    && <Layout />}
        {tab === 'pinterest' && <Pinterest />}
        {!['overview', 'guests', 'checklist', 'details', 'contract', 'suppliers', 'timeline', 'money', 'layout'].includes(tab) && <Soon label={active.label} />}
      </main>
    </>
  )
}

function Overview({ event, days }) {
  const a = event.accommodation || {}
  const n = event.venue_numbers || {}
  const anyAccom = ['amly', 'hamlet', 'camping'].some((k) => a[k] === 'yes' || a[k] === 'hold')

  return (
    <>
      <section className="card hero">
        <div className="couple">{event.couple || 'Your wedding'}</div>
        {event.date && <div className="when">{fmtDate(event.date)}</div>}
        {days !== null && (
          <div className="countdown">
            {days > 1 ? days + ' days to go'
              : days === 1 ? 'Tomorrow'
              : days === 0 ? 'Today'
              : 'We hope it was wonderful'}
          </div>
        )}
      </section>

      <section className="card">
        <h3>Your booking</h3>
        <div className="rows">
          <div className="row"><span className="k">Type</span><span className="v">{event.event_type}</span></div>
          {event.status && (
            <div className="row"><span className="k">Status</span><span className="v">{event.status}</span></div>
          )}
          {event.ceremony && (
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
            <div className="row"><span className="k">Amly</span><span className="v">{accomLabel(a.amly)}</span></div>
            <div className="row"><span className="k">The Hamlet</span><span className="v">{accomLabel(a.hamlet)}</span></div>
            <div className="row"><span className="k">Glamping</span><span className="v">{accomLabel(a.camping)}</span></div>
          </div>
          <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
            You will be able to put names to rooms here once the guest list is open.
          </p>
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
            These are the numbers we have written down. You will be able to update them
            yourself when the guest list opens.
          </p>
        </section>
      )}
    </>
  )
}

function Soon({ label }) {
  return (
    <section className="card">
      <div className="soon-panel">
        <span className="serif">{label}</span>
        Not open yet. We are building this a piece at a time, and it will appear here
        when it is ready.
      </div>
    </section>
  )
}
