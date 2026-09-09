import { useState } from 'react'

// Magic link, not a password. Couples plan a wedding over eighteen months on
// three devices; nobody wants to run password resets for them, and a password
// they set once and forget is worse than no password at all.
//
// The link is minted and sent by our own function rather than by Supabase's
// mailer, which is unbranded, heavily rate-limited and lands in spam often
// enough that a couple would simply never get in. Ours goes out through Resend
// with the same shell as every other email from the farm, and appears in Recent
// Automated Emails.
//
// It also closes the open-signup gap the first version had: the function sends
// a link only to an address that already has portal access, so typing a
// stranger's address no longer creates an account. It answers identically
// either way, so this form cannot be used to find out who is on the system —
// which is why there is no "we don't have that address" state below.
export default function SignIn({ notice }) {
  const [email, setEmail] = useState('')
  const [state, setState] = useState('idle')   // idle | sending | sent | error
  const [message, setMessage] = useState('')

  async function send(e) {
    e.preventDefault()
    const address = email.trim().toLowerCase()
    if (!address) return

    setState('sending')
    try {
      const res = await fetch('/.netlify/functions/portal-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request-link', email: address }),
      })
      if (!res.ok) {
        const text = await res.text()
        let data = null
        try { data = text ? JSON.parse(text) : null } catch (e) { /* not JSON */ }
        setState('error')
        setMessage((data && data.error) || 'Something went wrong. Please try again.')
        return
      }
    } catch (e) {
      setState('error')
      setMessage('We could not reach the farm just now. Please try again in a moment.')
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
                If <strong>{email.trim().toLowerCase()}</strong> is the address on your
                booking, a sign-in link is on its way. Open it on any device and you will
                come straight in — there is no password to remember, and the link is good
                for one use.
              </p>
              <p className="muted" style={{ marginTop: 10 }}>
                If we sent you one in the last minute — an invitation, say — that one is
                still the live link and no second email will follow. Have a look for it
                before asking again.
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

              {notice && <div className="alert alert-warn" style={{ marginBottom: 16 }}>{notice}</div>}

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
