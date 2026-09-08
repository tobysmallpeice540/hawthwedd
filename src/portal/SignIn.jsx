import { useState } from 'react'
import { supabase } from './supabase.js'

// Magic link, not a password. Couples plan a wedding over eighteen months on
// three devices; nobody wants to run password resets for them, and a password
// they set once and forget is worse than no password at all.
//
// shouldCreateUser is left at its default (true), so an invited couple can sign
// in the first time without anyone pre-creating an account. That does mean a
// stranger can create an empty account. It grants nothing: every read is gated
// on wp_access, and an uninvited account sees the "not linked" screen and
// nothing else — asserted in portal-phase00-access-test.sql. Closing signup
// properly means pre-creating accounts at invite time; that comes with the
// invite function.
export default function SignIn() {
  const [email, setEmail] = useState('')
  const [state, setState] = useState('idle')   // idle | sending | sent | error
  const [message, setMessage] = useState('')

  async function send(e) {
    e.preventDefault()
    const address = email.trim().toLowerCase()
    if (!address) return

    setState('sending')
    const { error } = await supabase.auth.signInWithOtp({
      email: address,
      options: { emailRedirectTo: window.location.origin + '/portal' },
    })

    if (error) {
      setState('error')
      setMessage(error.message || 'Something went wrong. Please try again.')
      return
    }
    setState('sent')
  }

  return (
    <div className="centre">
      <div className="wrap narrow" style={{ padding: 0 }}>
        <div className="card">
          <div style={{ marginBottom: 22 }}>
            <div className="brand">Hawthbush Farm</div>
            <div className="brand-sub">Wedding planner</div>
          </div>

          {state === 'sent' ? (
            <>
              <h2>Check your email</h2>
              <p className="muted" style={{ marginTop: 10 }}>
                We have sent a sign-in link to <strong>{email.trim().toLowerCase()}</strong>.
                Open it on any device and you will come straight in — there is no password
                to remember. The link is good for one use.
              </p>
              <button
                className="btn-quiet"
                style={{ marginTop: 18 }}
                onClick={() => { setState('idle'); setMessage('') }}
              >
                Use a different email address
              </button>
            </>
          ) : (
            <>
              <h2>Plan your day</h2>
              <p className="muted" style={{ marginTop: 10, marginBottom: 20 }}>
                Guests, timings, suppliers and your table plan, all in one place.
                Enter the email address we have for your booking and we will send
                you a link.
              </p>

              <form onSubmit={send}>
                <label htmlFor="email">Email address</label>
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
                <button className="btn" type="submit" disabled={state === 'sending'}>
                  {state === 'sending' ? 'Sending…' : 'Email me a link'}
                </button>
              </form>

              {state === 'error' && (
                <div className="alert alert-warn">{message}</div>
              )}
            </>
          )}
        </div>

        <p className="muted" style={{ textAlign: 'center', marginTop: 16, fontSize: 13 }}>
          Trouble getting in? Email us and we will sort it out.
        </p>
      </div>
    </div>
  )
}
