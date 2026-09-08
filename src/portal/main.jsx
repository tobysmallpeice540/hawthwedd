import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { supabase } from './supabase.js'
import SignIn from './SignIn.jsx'
import Portal from './Portal.jsx'
import './portal.css'

function App() {
  const [session, setSession] = useState(undefined)   // undefined = still checking

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s ?? null))
    return () => sub.subscription.unsubscribe()
  }, [])

  // A magic link lands with the token in the fragment. Once supabase-js has
  // consumed it, tidy the address bar so a shared screenshot or a browser
  // history entry does not carry a usable credential.
  useEffect(() => {
    if (session && window.location.hash.includes('access_token')) {
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [session])

  if (session === undefined) {
    return <div className="centre"><p className="muted">One moment…</p></div>
  }
  return session ? <Portal session={session} /> : <SignIn />
}

createRoot(document.getElementById('portal-root')).render(
  <StrictMode><App /></StrictMode>
)
