import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { supabase } from './supabase.js'
import SignIn from './SignIn.jsx'
import Portal from './Portal.jsx'
import './portal.css'

// ── Coming in from a sign-in link ───────────────────────────────────────────
//
// The link lands here carrying a one-use token in the fragment, and this page
// exchanges it for a session itself. It does NOT go via Supabase's own verify
// endpoint, which redirects to whatever URL it is handed and quietly falls back
// to the project's Site URL when that URL is not on the redirect allowlist. The
// first invite ever sent went to localhost that way, and spent its token doing
// it. See mintLink() in netlify/functions/portal-auth.js.
//
// Both of these run once, at module scope, and that is load-bearing:
//
//   · the token is taken out of the address bar before React renders, so it
//     cannot survive into a screenshot or a browser history entry;
//   · the exchange is a single promise, so React 18's double-invoked effects
//     cannot spend a one-use token twice and fail the second attempt.
function takeTokenFromUrl() {
  const m = /[#&]t=([^&]*)/.exec(window.location.hash || '')
  if (!m || !m[1]) return null
  window.history.replaceState({}, '', window.location.pathname)
  try { return decodeURIComponent(m[1]) } catch (e) { return m[1] }
}

const LINK_TOKEN = takeTokenFromUrl()
const LINK_SIGN_IN = LINK_TOKEN
  ? supabase.auth.verifyOtp({ token_hash: LINK_TOKEN, type: 'magiclink' })
  : null

function App() {
  const [session, setSession] = useState(undefined)   // undefined = still checking
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let off = false
    let unsub = null

    ;(async () => {
      // Finish the link exchange BEFORE anything decides which screen to show.
      // Subscribing first would deliver a null session a moment before the
      // token resolves, flashing the sign-in form at somebody who has just
      // signed in — and inviting them to ask for a second link.
      if (LINK_SIGN_IN) {
        let error = null
        try { error = (await LINK_SIGN_IN).error } catch (e) { error = e }
        if (off) return
        if (error) {
          setNotice(
            'That link has already been used or has expired — they are good for one ' +
            'use. Enter your email address and we will send you a fresh one.'
          )
        }
      }

      const { data } = await supabase.auth.getSession()
      if (off) return
      setSession(data.session ?? null)

      const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
        if (!off) setSession(s ?? null)
      })
      unsub = sub.subscription
    })()

    return () => { off = true; if (unsub) unsub.unsubscribe() }
  }, [])

  if (session === undefined) {
    return <div className="centre"><p className="muted">One moment…</p></div>
  }
  return session ? <Portal session={session} /> : <SignIn notice={notice} />
}

createRoot(document.getElementById('portal-root')).render(
  <StrictMode><App /></StrictMode>
)
