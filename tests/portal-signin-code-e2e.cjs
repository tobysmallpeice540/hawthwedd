// tests/portal-signin-code-e2e.cjs
//
// Signing in to the portal with the typed code (the installed app on an
// iPhone), in the built portal with Supabase faked:
//   · after asking for an email, the code box is there; a right code signs in
//     and the planner opens; the code is sent with the address;
//   · "I have a code from an email" works without asking for a new email;
//   · a wrong code says so and stays on the sign-in page.
//
//   npx vite build --outDir "$HOME/dist-check" --emptyOutDir && node tests/portal-signin-code-e2e.cjs

const os = require('os'), path = require('path')
const { openPortal, baseRpc } = require('./portal-harness.cjs')
const DIST = process.env.DIST || path.join(os.homedir(), 'dist-check')

let passes = 0; const fails = []
const check = (n, ok, d) => { if (ok) passes++; else fails.push(n + (d ? ': ' + d : '')) }

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const user = { id: '00000000-0000-4000-8000-00000000abcd', email: 'sam@x.test', aud: 'authenticated', role: 'authenticated' }
const exp = Math.floor(Date.now() / 1000) + 3600
const session = { access_token: b64({ alg: 'HS256' }) + '.' + b64({ sub: user.id, email: user.email, exp, role: 'authenticated' }) + '.sig',
  refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: exp, user }

function verifier(goodCode) {
  return (args) => (args.token === goodCode && args.email === 'sam@x.test')
    ? { status: 200, body: session }
    : { status: 403, body: { code: 'otp_expired', msg: 'Token has expired or is invalid' } }
}

;(async () => {
  // ── after asking for a link ─────────────────────────────────────────────
  let h = await openPortal({ distDir: DIST, signedIn: false, rpc: baseRpc({ wp_get_guests: () => ({ ok: true, guests: [], numbers: {}, derived: {} }) }),
    auth: { verify: verifier('482913') } })
  await h.page.route('**/.netlify/functions/portal-auth', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"sent":true}' }))
  await h.page.locator('#email').fill('Sam@X.test')
  await h.page.getByRole('button', { name: 'Email me a link' }).click()
  await h.page.getByText('Check your email').waitFor({ timeout: 5000 })
  check('S1 the code box is offered with the "check your email" page', await h.page.locator('#code').count() === 1)
  await h.page.locator('#code').fill('482 913')
  await h.page.getByRole('button', { name: 'Sign in with the code' }).click()
  await h.page.locator('.side').first().waitFor({ timeout: 8000 })
  const v = h.calls.filter((c) => c.fn === 'auth:verify')
  check('S2 the code and the address go to Supabase, spaces removed', v.length >= 1 && v[0].args.token === '482913' && v[0].args.email === 'sam@x.test', JSON.stringify(v[0] && v[0].args))
  check('S3 signed in: the planner opens', await h.page.locator('.side').count() > 0)
  check('S4 no page errors', h.errors.length === 0, h.errors.join(' | '))
  await h.close()

  // ── straight from the sign-in page ──────────────────────────────────────
  h = await openPortal({ distDir: DIST, signedIn: false, rpc: baseRpc({}), auth: { verify: verifier('482913') } })
  await h.page.getByRole('button', { name: 'I have a code from an email' }).click()
  await h.page.locator('#code-email').fill('sam@x.test')
  await h.page.locator('#code').fill('111111')
  await h.page.getByRole('button', { name: 'Sign in with the code' }).click()
  await h.page.getByText('That code did not work', { exact: false }).waitFor({ timeout: 5000 })
  check('W1 a wrong code says so and stays put', await h.page.locator('.side').count() === 0)
  await h.page.locator('#code').fill('482913')
  await h.page.getByRole('button', { name: 'Sign in with the code' }).click()
  await h.page.locator('.side').first().waitFor({ timeout: 8000 })
  check('W2 then the right one signs in', true)
  check('W3 no request for a new email was needed', !h.calls.some((c) => /portal-auth/.test(c.fn)))
  await h.page.close()
  await h.close()

  // ── a code that is not a code ───────────────────────────────────────────
  h = await openPortal({ distDir: DIST, signedIn: false, rpc: baseRpc({}), auth: { verify: verifier('482913') } })
  await h.page.getByRole('button', { name: 'I have a code from an email' }).click()
  await h.page.locator('#code-email').fill('sam@x.test')
  await h.page.locator('#code').fill('abc')
  await h.page.getByRole('button', { name: 'Sign in with the code' }).click()
  await h.page.getByText('it is all numbers', { exact: false }).waitFor({ timeout: 5000 })
  check('X1 letters are refused before anything is sent', !h.calls.some((c) => c.fn === 'auth:verify'))
  await h.close()

  if (fails.length) { console.log(passes + ' passed, FAILED:\n  ' + fails.join('\n  ')); process.exit(1) }
  console.log('ALL ' + passes + ' ASSERTIONS PASSED')
})().catch((e) => { console.error(e); process.exit(1) })
