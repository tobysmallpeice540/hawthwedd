import { StrictMode, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'

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

// ─── Credentials ─────────────────────────────────────────────────────────────
// NOTE: these live in the browser bundle, so anyone who views source can read
// them. This is a doorstep lock that keeps the wrong people out of the wrong
// screens — it is not real security. Proper protection would need server-side
// authentication (Supabase Auth), which would also record who changed what.
//
// `admin` sees the whole app. `bar` only ever sees Bar Management, including
// the two rota reports. `cleaner` sees a read-only housekeeping view: what's
// coming up in the next fortnight, the lettings calendar and the bookings
// list — no prices, no guest contact details to edit, nothing saveable.
const USERS = [
  { user: 'admin',   pass: 'Hawth8u$h',    role: 'admin'   },
  { user: 'bar',     pass: 'BarStaff26!',  role: 'bar'     },
  { user: 'cleaner', pass: 'CleanHF26!',   role: 'cleaner' },
]
const SESSION_KEY  = 'hbf_auth_v1'
const SESSION_ROLE = 'hbf_auth_role_v1'
const SESSION_VAL  = 'granted'

function LoginScreen({ onAuth }) {
  const [user, setUser]     = useState('')
  const [pass, setPass]     = useState('')
  const [error, setError]   = useState('')
  const [showPass, setShow] = useState(false)

  const attempt = () => {
    const match = USERS.find(u => u.user === user.trim().toLowerCase() && u.pass === pass)
    if (match) {
      sessionStorage.setItem(SESSION_KEY, SESSION_VAL)
      sessionStorage.setItem(SESSION_ROLE, match.role)
      onAuth(match.role)
    } else {
      setError('Incorrect username or password.')
      setPass('')
    }
  }

  const onKey = e => { if (e.key === 'Enter') attempt() }

  return (
    <div style={{
      minHeight: '100vh', background: '#f0f6ff',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <div style={{
        background: '#fff', borderRadius: 16, padding: '48px 44px',
        boxShadow: '0 8px 40px rgba(37,99,235,.12)', width: '100%', maxWidth: 400,
        border: '1px solid #c8d9ef',
      }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            background: '#1e4d8c', borderRadius: 12, width: 64, height: 64, marginBottom: 16,
          }}>
            <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
              <rect x="4" y="4" width="4" height="28" fill="white" opacity=".9"/>
              <rect x="28" y="4" width="4" height="28" fill="white" opacity=".9"/>
              <text x="18" y="15" textAnchor="middle" fill="white" fontSize="7" fontWeight="bold" fontFamily="system-ui">HAWTH</text>
              <text x="18" y="23" textAnchor="middle" fill="white" fontSize="7" fontWeight="bold" fontFamily="system-ui">BUSH</text>
              <text x="18" y="31" textAnchor="middle" fill="white" fontSize="7" fontWeight="bold" fontFamily="system-ui">FARM</text>
            </svg>
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#1a2d4a' }}>Hawthbush Farm</div>
          <div style={{ fontSize: 13, color: '#7a9bbf', marginTop: 4 }}>Management</div>
        </div>

        {/* Fields */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: '#3d5a7a', marginBottom: 6 }}>Username</label>
          <input
            value={user} onChange={e => { setUser(e.target.value); setError('') }}
            onKeyDown={onKey} autoFocus autoComplete="username"
            placeholder="admin"
            style={{ width: '100%', padding: '10px 13px', border: '1.5px solid #c8d9ef', borderRadius: 8, fontSize: 15, color: '#1a2d4a', background: '#f8fafd', outline: 'none', boxSizing: 'border-box' }}
          />
        </div>

        <div style={{ marginBottom: 24 }}>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: '#3d5a7a', marginBottom: 6 }}>Password</label>
          <div style={{ position: 'relative' }}>
            <input
              type={showPass ? 'text' : 'password'}
              value={pass} onChange={e => { setPass(e.target.value); setError('') }}
              onKeyDown={onKey} autoComplete="current-password"
              style={{ width: '100%', padding: '10px 42px 10px 13px', border: `1.5px solid ${error ? '#dc2626' : '#c8d9ef'}`, borderRadius: 8, fontSize: 15, color: '#1a2d4a', background: '#f8fafd', outline: 'none', boxSizing: 'border-box' }}
            />
            <button onClick={() => setShow(s => !s)} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#7a9bbf', fontSize: 13, padding: 0 }}>
              {showPass ? 'Hide' : 'Show'}
            </button>
          </div>
          {error && <div style={{ marginTop: 8, fontSize: 12, color: '#dc2626', fontWeight: 500 }}>{error}</div>}
        </div>

        <button
          onClick={attempt}
          style={{ width: '100%', padding: '12px', background: '#1e4d8c', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: 'pointer', boxShadow: '0 2px 8px rgba(30,77,140,.25)', letterSpacing: .3 }}
        >
          Sign in
        </button>
      </div>
    </div>
  )
}

function Root() {
  const [authed, setAuthed] = useState(false)
  const [role, setRole]     = useState('admin')

  useEffect(() => {
    const token = sessionStorage.getItem(SESSION_KEY)
    if (token === SESSION_VAL) {
      setRole(sessionStorage.getItem(SESSION_ROLE) || 'admin')
      setAuthed(true)
    }
  }, [])

  const signOut = () => {
    sessionStorage.removeItem(SESSION_KEY)
    sessionStorage.removeItem(SESSION_ROLE)
    window.location.reload()
  }

  if (!authed) return <LoginScreen onAuth={r => { setRole(r); setAuthed(true) }} />
  return <App role={role} onSignOut={signOut} />
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
