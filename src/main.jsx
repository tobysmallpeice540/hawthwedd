import { StrictMode, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { createClient } from '@supabase/supabase-js'
import App, { setSessionToken } from './App.jsx'

// Polyfill for Claude artifact storage API — maps to localStorage when running outside Claude
if (typeof window.storage === 'undefined') {
  window.storage = {
    get: async (key) => {
      try {
        const value = localStorage.getItem(key)
        return value ? { key, value } : null
      } catch { return null }
    },
    set: async (key, value) => {
      try {
        localStorage.setItem(key, value)
        return { key, value }
      } catch { return null }
    },
    delete: async (key) => {
      try {
        localStorage.removeItem(key)
        return { key, deleted: true }
      } catch { return null }
    },
    list: async (prefix) => {
      try {
        const keys = Object.keys(localStorage).filter(k => !prefix || k.startsWith(prefix))
        return { keys }
      } catch { return { keys: [] } }
    }
  }
}

// ─── Authentication ──────────────────────────────────────────────────────────
// Real accounts, checked by Supabase. This replaces three shared passwords that
// were compiled into the bundle, where anyone could read them with View Source.
//
// What that changes, and what it doesn't:
//   · one account per person, so a leaver is revoked without a deploy
//   · the role comes from the profiles table, not from sessionStorage, so it
//     can't be edited from the browser console
//   · every read and write now carries the signed-in user (see App.jsx)
//
// It does NOT yet stop someone reading the anon key out of this bundle and
// querying app_data directly. That closes when row level security goes on,
// which needs this phase in place first.
//
// The library is used for sign-in and token refresh only. Reads and writes stay
// hand-rolled fetch, exactly as they were — refresh handling is the fiddly part
// and not worth owning.
const SUPABASE_URL = 'https://rkqbyisfmvwulsyxzwjz.supabase.co'
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJrcWJ5aXNmbXZ3dWxzeXh6d2p6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NTI0MzgsImV4cCI6MjA5NjUyODQzOH0._CsyhvFrtHFC0KrfiLzbrLUaKcvxtbWlHydaH20tvfo'

// persistSession keeps people signed in across visits — bar staff should not be
// typing a password during service — and autoRefreshToken renews it quietly
// before it expires.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
})

const T = { blue: '#1e4d8c', border: '#c8d9ef', text: '#1a2d4a', muted: '#7a9bbf', red: '#dc2626' }

const field = (bad) => ({
  width: '100%', padding: '10px 13px', border: `1.5px solid ${bad ? T.red : T.border}`,
  borderRadius: 8, fontSize: 15, color: T.text, background: '#f8fafd',
  outline: 'none', boxSizing: 'border-box',
})
const label = { display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: '#3d5a7a', marginBottom: 6 }

function LoginScreen({ onAuth }) {
  const [email, setEmail]   = useState('')
  const [pass, setPass]     = useState('')
  const [error, setError]   = useState('')
  const [busy, setBusy]     = useState(false)
  const [showPass, setShow] = useState(false)
  const [mode, setMode]     = useState('signin')   // 'signin' | 'reset'
  const [sent, setSent]     = useState(false)

  const attempt = async () => {
    if (busy) return
    setBusy(true); setError('')
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password: pass,
    })
    if (error) {
      // Deliberately vague: saying which half was wrong tells someone probing
      // whether an address has an account here.
      setError('That email address and password don’t match.')
      setPass(''); setBusy(false)
      return
    }
    await onAuth(data.session)
    setBusy(false)
  }

  const sendReset = async () => {
    if (busy || !email.trim()) return
    setBusy(true); setError('')
    // Always reports success, for the same reason the sign-in error is vague.
    await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: window.location.origin,
    })
    setSent(true); setBusy(false)
  }

  const onKey = e => { if (e.key === 'Enter') mode === 'reset' ? sendReset() : attempt() }

  return (
    <div style={{
      minHeight: '100vh', background: '#f0f6ff',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'system-ui, -apple-system, sans-serif', padding: 20,
    }}>
      <div style={{
        background: '#fff', borderRadius: 16, padding: '48px 44px',
        boxShadow: '0 8px 40px rgba(37,99,235,.12)', width: '100%', maxWidth: 400,
        border: `1px solid ${T.border}`,
      }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: T.blue, borderRadius: 12, width: 64, height: 64, marginBottom: 16,
          }}>
            <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
              <rect x="4" y="4" width="4" height="28" fill="white" opacity=".9"/>
              <rect x="28" y="4" width="4" height="28" fill="white" opacity=".9"/>
              <text x="18" y="15" textAnchor="middle" fill="white" fontSize="7" fontWeight="bold" fontFamily="system-ui">HAWTH</text>
              <text x="18" y="23" textAnchor="middle" fill="white" fontSize="7" fontWeight="bold" fontFamily="system-ui">BUSH</text>
              <text x="18" y="31" textAnchor="middle" fill="white" fontSize="7" fontWeight="bold" fontFamily="system-ui">FARM</text>
            </svg>
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: T.text }}>Hawthbush Farm</div>
          <div style={{ fontSize: 13, color: T.muted, marginTop: 4 }}>Management</div>
        </div>

        {sent ? (
          <div>
            <div style={{ background: '#dcfce7', border: '1px solid #86efac', color: '#166534', borderRadius: 8, padding: '12px 14px', fontSize: 13, lineHeight: 1.6 }}>
              If there’s an account for that address, a link to set a new password is on its way. It expires after an hour.
            </div>
            <button onClick={() => { setSent(false); setMode('signin') }}
              style={{ width: '100%', marginTop: 18, padding: 12, background: 'none', color: T.blue, border: `1.5px solid ${T.border}`, borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
              Back to sign in
            </button>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 16 }}>
              <label style={label}>Email</label>
              <input
                value={email} onChange={e => { setEmail(e.target.value); setError('') }}
                onKeyDown={onKey} autoFocus autoComplete="username" type="email"
                placeholder="you@hawthbushfarm.co.uk"
                style={field(false)}
              />
            </div>

            {mode === 'signin' && (
              <div style={{ marginBottom: 24 }}>
                <label style={label}>Password</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showPass ? 'text' : 'password'}
                    value={pass} onChange={e => { setPass(e.target.value); setError('') }}
                    onKeyDown={onKey} autoComplete="current-password"
                    style={{ ...field(!!error), paddingRight: 42 }}
                  />
                  <button onClick={() => setShow(s => !s)}
                    style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: T.muted, fontSize: 13, padding: 0 }}>
                    {showPass ? 'Hide' : 'Show'}
                  </button>
                </div>
                {error && <div style={{ marginTop: 8, fontSize: 12, color: T.red, fontWeight: 500 }}>{error}</div>}
              </div>
            )}

            <button
              onClick={mode === 'reset' ? sendReset : attempt}
              disabled={busy}
              style={{ width: '100%', padding: 12, background: T.blue, color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: busy ? 'default' : 'pointer', opacity: busy ? .6 : 1, boxShadow: '0 2px 8px rgba(30,77,140,.25)', letterSpacing: .3 }}
            >
              {busy ? 'Please wait…' : mode === 'reset' ? 'Email me a reset link' : 'Sign in'}
            </button>

            <div style={{ textAlign: 'center', marginTop: 14 }}>
              <button onClick={() => { setMode(mode === 'reset' ? 'signin' : 'reset'); setError('') }}
                style={{ background: 'none', border: 'none', color: T.muted, fontSize: 12.5, cursor: 'pointer', textDecoration: 'underline' }}>
                {mode === 'reset' ? 'Back to sign in' : 'Forgotten your password?'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Splash({ children }) {
  return (
    <div style={{ minHeight: '100vh', background: '#f0f6ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif', color: T.muted, fontSize: 14 }}>
      {children}
    </div>
  )
}

function Root() {
  const [session, setSession] = useState(null)
  const [role, setRole]       = useState(null)
  const [ready, setReady]     = useState(false)
  const [problem, setProblem] = useState('')

  // The role is read from the database, never from anything the browser holds.
  const loadRole = async (sess) => {
    setSessionToken(sess?.access_token || null)
    if (!sess) { setRole(null); return }
    try {
      const { data, error } = await supabase.rpc('my_profile')
      if (error) throw error
      if (!data || !data.role) {
        setProblem('Your account has no role set yet. Ask Toby to finish setting it up.')
        setRole(null); return
      }
      if (data.active === false) {
        setProblem('That account has been switched off.')
        await supabase.auth.signOut()
        setRole(null); return
      }
      setProblem('')
      setRole(data.role)
    } catch (e) {
      setProblem('Signed in, but your role could not be read. Try again in a moment.')
      setRole(null)
    }
  }

  useEffect(() => {
    let live = true
    supabase.auth.getSession().then(async ({ data }) => {
      if (!live) return
      setSession(data.session)
      await loadRole(data.session)
      setReady(true)
    })
    // Fires on sign-in, sign-out and every silent token refresh, so the token
    // App.jsx sends never goes stale.
    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, sess) => {
      if (!live) return
      setSession(sess)
      await loadRole(sess)
    })
    return () => { live = false; sub?.subscription?.unsubscribe() }
  }, [])

  const signOut = async () => {
    await supabase.auth.signOut()
    setSessionToken(null)
    window.location.reload()
  }

  if (!ready) return <Splash>Loading…</Splash>

  if (!session || !role) {
    return (
      <>
        {problem && (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 50, background: '#fef3c7', borderBottom: '1px solid #fcd34d', color: '#92400e', padding: '11px 18px', fontFamily: 'system-ui, sans-serif', fontSize: 13, textAlign: 'center' }}>
            {problem}
          </div>
        )}
        <LoginScreen onAuth={async (sess) => { setSession(sess); await loadRole(sess) }} />
      </>
    )
  }

  return <App role={role} onSignOut={signOut} />
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
