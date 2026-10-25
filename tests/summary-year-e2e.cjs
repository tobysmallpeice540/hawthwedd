// tests/summary-year-e2e.cjs
//
// Reports → Annual summary uses the calendars' year control: arrows either
// side of the year (any year, not only years with events), and "This year"
// once you have moved away. Built app, Supabase faked.
//
//   npx vite build --outDir "$HOME/dist-check" --emptyOutDir && node tests/summary-year-e2e.cjs

const os = require('os'), path = require('path')
const { openStaff } = require('./portal-harness.cjs')
const DIST = process.env.DIST || path.join(os.homedir(), 'dist-check')
let passes = 0; const fails = []
const check = (n, ok, d) => { if (ok) passes++; else fails.push(n + (d ? ': ' + d : '')) }
const thisYear = Number(new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }).slice(0, 4))

;(async () => {
  const h = await openStaff({ distDir: DIST, appData: { hawthbush_bookings_v6: [
    { id: 1, couple: 'This Year Couple', date: thisYear + '-06-01', status: 'Confirmed', eventType: 'Wedding (Peak)', venueFee: '5000' },
  ] } })
  const page = h.page
  await page.locator('nav, aside').getByText('Reports', { exact: true }).first().click()
  const prev = page.getByRole('button', { name: 'Previous year' })
  await prev.waitFor({ timeout: 8000 })
  const shown = () => page.locator('div', { has: prev }).last().innerText()
  check('Y1 opens on this year', new RegExp('\\b' + thisYear + '\\b').test(await shown()))
  check('Y2 no "This year" button while on this year', (await page.getByRole('button', { name: 'This year' }).count()) === 0)
  await prev.click(); await prev.click()
  check('Y3 the arrows reach a year with no events', new RegExp('\\b' + (thisYear - 2) + '\\b').test(await shown()), await shown())
  await page.getByRole('button', { name: 'This year' }).click()
  check('Y4 "This year" goes back', new RegExp('\\b' + thisYear + '\\b').test(await shown()))
  await page.getByRole('button', { name: 'Next year' }).click()
  check('Y5 next year too', new RegExp('\\b' + (thisYear + 1) + '\\b').test(await shown()))
  check('Y6 print is still there', (await page.getByRole('button', { name: /Print/ }).count()) >= 1)
  check('Y7 no page errors', h.errors.length === 0, h.errors.join(' | '))
  await h.close()
  console.log(passes + ' passed, ' + fails.length + ' failed')
  fails.forEach((f) => console.log('  FAIL ' + f))
  process.exit(fails.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
