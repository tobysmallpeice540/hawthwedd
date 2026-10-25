// tests/portal-harness.cjs
//
// Opens the BUILT client portal in Chromium with Supabase faked out, so a
// portal page can be driven and asserted on without a database or a network.
//
//   const { openPortal } = require('./portal-harness.cjs')
//   const { page, calls, close } = await openPortal({ distDir, rpc: { wp_get_guests: () => ({...}) } })
//
// · A signed-in session is put in localStorage under the portal's own key
//   (hbf-portal-auth) before the page loads. supabase-js does not check the
//   signature, only the expiry.
// · Every request to the Supabase host is answered here. /rest/v1/rpc/<fn>
//   calls rpc[fn](args) — a function returning the JSON body, or throwing to
//   send a 500. A function with no handler answers as PostgREST does for a
//   function that does not exist (PGRST202), which is exactly what the portal
//   meets when a page ships before its migration.
// · `calls` records every rpc as { fn, args }.
//
// Build first:  npx vite build --outDir "$HOME/dist-check" --emptyOutDir

const http = require('http')
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright')

const HOST = 'https://rkqbyisfmvwulsyxzwjz.supabase.co'

function serve(distDir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0])
      if (p === '/portal' || p === '/portal/') p = '/portal.html'
      if (p === '/') p = '/index.html'
      const file = path.join(distDir, p)
      if (!file.startsWith(distDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return
      }
      const ext = path.extname(file)
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
                     '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json',
                     '.webmanifest': 'application/manifest+json' }[ext] || 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': type }); fs.createReadStream(file).pipe(res)
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function b64url(o) { return Buffer.from(JSON.stringify(o)).toString('base64url') }

async function openPortal({ distDir, rpc = {}, auth = {}, signedIn = true, viewport, path: urlPath = '/portal' }) {
  const server = await serve(distDir)
  const origin = 'http://127.0.0.1:' + server.address().port
  const exe = fs.readdirSync('/opt/pw-browsers').filter((d) => d.startsWith('chromium-')).map((d) => '/opt/pw-browsers/' + d + '/chrome-linux/chrome').find((f) => fs.existsSync(f))
  const browser = await chromium.launch(exe ? { executablePath: exe } : {})
  const context = await browser.newContext({ viewport: viewport || { width: 1200, height: 900 } })
  const page = await context.newPage()
  const calls = []
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))

  const user = { id: '00000000-0000-4000-8000-00000000abcd', email: 'couple@test.invalid', aud: 'authenticated', role: 'authenticated' }
  const exp = Math.floor(Date.now() / 1000) + 3600 * 24
  const jwt = b64url({ alg: 'HS256', typ: 'JWT' }) + '.' + b64url({ sub: user.id, email: user.email, exp, role: 'authenticated', aud: 'authenticated' }) + '.sig'
  if (signedIn) {
    await page.addInitScript(([s]) => { localStorage.setItem('hbf-portal-auth', s) },
      [JSON.stringify({ access_token: jwt, refresh_token: 'r', token_type: 'bearer', expires_in: 86400, expires_at: exp, user })])
  }

  await page.route(HOST + '/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const m = url.pathname.match(/\/rest\/v1\/rpc\/(\w+)$/)
    if (m) {
      let args = {}
      try { args = JSON.parse(req.postData() || '{}') } catch (e) { /* none */ }
      calls.push({ fn: m[1], args })
      const h = rpc[m[1]]
      if (!h) return route.fulfill({ status: 404, contentType: 'application/json',
        body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.' + m[1] + ' in the schema cache' }) })
      try {
        const body = await h(args)
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body === undefined ? null : body) })
      } catch (e) {
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: String(e.message || e) }) })
      }
    }
    if (url.pathname.startsWith('/auth/v1/')) {
      const key = url.pathname.replace('/auth/v1/', '')
      calls.push({ fn: 'auth:' + key, args: (() => { try { return JSON.parse(req.postData() || '{}') } catch (e) { return {} } })() })
      if (auth[key]) {
        const r = await auth[key](calls[calls.length - 1].args)
        return route.fulfill({ status: r.status || 200, contentType: 'application/json', body: JSON.stringify(r.body) })
      }
      if (key === 'user') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(user) })
      if (key === 'logout') return route.fulfill({ status: 204, body: '' })
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'not faked: ' + key }) })
    }
    return route.fulfill({ status: 404, body: '' })
  })

  // Netlify functions on the same origin are not served here; tests that need
  // them route them on the page themselves.
  await page.goto(origin + urlPath)
  return {
    page, calls, errors, origin, context,
    close: async () => { await browser.close(); server.close() },
  }
}

// The STAFF app, signed in as an admin, with Supabase faked the same way.
// Table reads (GET /rest/v1/<table>) answer from `tables[name]` or [];
// app_data reads answer from `appData[key]` (missing keys are absent rows).
async function openStaff({ distDir, rpc = {}, appData = {}, viewport, path: urlPath = '/' }) {
  const server = await serve(distDir)
  const origin = 'http://127.0.0.1:' + server.address().port
  const exe = fs.readdirSync('/opt/pw-browsers').filter((d) => d.startsWith('chromium-')).map((d) => '/opt/pw-browsers/' + d + '/chrome-linux/chrome').find((f) => fs.existsSync(f))
  const browser = await chromium.launch(exe ? { executablePath: exe } : {})
  const context = await browser.newContext({ viewport: viewport || { width: 1400, height: 900 } })
  const page = await context.newPage()
  const calls = [], errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const user = { id: '00000000-0000-4000-8000-00000000beef', email: 'office@test.invalid', aud: 'authenticated', role: 'authenticated' }
  const exp = Math.floor(Date.now() / 1000) + 3600 * 24
  const jwt = b64url({ alg: 'HS256', typ: 'JWT' }) + '.' + b64url({ sub: user.id, email: user.email, exp, role: 'authenticated', aud: 'authenticated' }) + '.sig'
  await page.addInitScript(([s]) => { localStorage.setItem('sb-rkqbyisfmvwulsyxzwjz-auth-token', s) },
    [JSON.stringify({ access_token: jwt, refresh_token: 'r', token_type: 'bearer', expires_in: 86400, expires_at: exp, user })])
  const allRpc = Object.assign({ my_profile: () => ({ id: user.id, role: 'admin', active: true, name: 'Office' }) }, rpc)
  await page.route(HOST + '/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const m = url.pathname.match(/\/rest\/v1\/rpc\/(\w+)$/)
    if (m) {
      let args = {}
      try { args = JSON.parse(req.postData() || '{}') } catch (e) { /* none */ }
      calls.push({ fn: m[1], args })
      const h = allRpc[m[1]]
      if (!h) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function ' + m[1] }) })
      const body = await h(args)
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body === undefined ? null : body) })
    }
    if (url.pathname.startsWith('/auth/v1/')) {
      if (url.pathname.endsWith('/user')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(user) })
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    const t = url.pathname.match(/\/rest\/v1\/(\w+)$/)
    if (t && req.method() === 'GET') {
      if (t[1] === 'app_data') {
        const k = (url.searchParams.get('key') || '').replace(/^eq\./, '')
        const rows = k && appData[k] !== undefined ? [{ key: k, value: appData[k] }] : []
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) })
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    }
    if (t) { calls.push({ fn: 'write:' + t[1], args: req.postData() }); return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' }) }
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto(origin + urlPath)
  return { page, calls, errors, origin, context, close: async () => { await browser.close(); server.close() } }
}

// What every portal page needs to get past "One moment…".
function baseRpc(over) {
  return Object.assign({
    wp_touch_access: () => ({ ok: true }),
    wp_my_event: () => ({ ok: true, event_id: 222, event_type: 'Wedding (Peak)', couple: 'Sam & Alex', date: '2027-06-12' }),
    wp_get_home: () => ({ ok: true, event_type: 'Wedding (Peak)', couple: 'Sam & Alex', date: '2027-06-12',
      visible: ['guests', 'timeline', 'checklist'], sections: [] }),
  }, over || {})
}

// Open a section by its menu label, on a phone (folded menu) or a desktop.
async function goTab(page, label) {
  await page.locator('.side').first().waitFor({ timeout: 10000 })
  const toggle = page.locator('.side-toggle')
  if (await toggle.isVisible()) await toggle.click()
  await page.locator('.side-list .tab', { hasText: label }).first().click()
}

module.exports = { openPortal, openStaff, baseRpc, goTab }
