// The home page's coming arrivals: clean, checklist and WhatsApp arrival-time
// markers (30 Oct); and the arrival time on the letting form. BUILT app,
// Supabase faked.
// npx vite build --outDir "$HOME/dist-check" --emptyOutDir && node tests/arrival-badges-e2e.cjs
const assert = require('assert')
const path = require('path')
const { openStaff } = require('./portal-harness.cjs')
const DIST = process.env.DIST || path.join(process.env.HOME, 'dist-check')

const day = (n) => { const d = new Date(); d.setUTCHours(12); d.setUTCDate(d.getUTCDate() + n); return d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' }) }
const T0 = day(0), T2 = day(2), T3 = day(3), Tm2 = day(-2), T5 = day(5)

const ACCOM = [
  // Before the arrivals: the people leaving the Hamlet (cleaned) and Amly (not yet).
  { id: 'P1', guestName: 'Leaving Hamlet', status: 'confirmed', source: 'direct', stays: [{ propertyId: 'hamlet', checkIn: Tm2, checkOut: T2 }] },
  { id: 'P2', guestName: 'Leaving Amly', status: 'confirmed', source: 'direct', stays: [{ propertyId: 'amly', checkIn: Tm2, checkOut: T0 }] },
  { id: 'A1', guestName: 'Emma Juner', status: 'confirmed', source: 'direct', phone: '07700 900001',
    arrivalEta: { text: '6pm to 9pm', date: T2, at: new Date().toISOString(), via: 'whatsapp' },
    stays: [{ propertyId: 'hamlet', checkIn: T2, checkOut: T5 }] },
  { id: 'A2', guestName: 'Sam Late', status: 'confirmed', source: 'direct',
    arrivalEta: { text: 'After 9pm', date: Tm2, via: 'whatsapp' },   // an answer for some other stay: not shown
    stays: [{ propertyId: 'amly', checkIn: T3, checkOut: T5 }] }
]
const PROPS = [{ id: 'hamlet', name: 'The Hamlet', colour: '#3b82f6' }, { id: 'amly', name: 'Amly Barn', colour: '#10b981' }]
const CHANGEOVERS = [{ id: 'accom:P1:hamlet', doneAt: T2 + 'T11:30', who: 'Leaving Hamlet' }]
const past = new Date(Date.now() - 3600e3).toISOString(), later = new Date(Date.now() + 864e5).toISOString()
const RUNS = {
  A1: [{ id: 'R1', status: 'done', opens_at: past, items: [{ state: 'done' }, { state: 'na' }] }],
  A2: [{ id: 'R2', status: 'open', opens_at: past, items: [{ state: 'done' }, { state: 'open', due_at: past }, { state: 'open', due_at: later }] }]
}

;(async () => {
  const fails = []
  const check = (name, ok, more) => { if (!ok) fails.push(name + (more ? ' — ' + more : '')); console.log((ok ? '  ok   ' : '  FAIL ') + name) }
  const s = await openStaff({ distDir: DIST, appData: { hbf_accom_v1: ACCOM, hbf_properties_v1: PROPS, hbf_changeovers_v1: CHANGEOVERS, hbf_setup_cleans_v1: [] },
    rpc: { chk_for_record: (a) => ({ ok: true, runs: RUNS[a.p_id] || [] }) } })
  const page = s.page
  try {
    await page.getByText('Emma Juner').first().waitFor({ timeout: 15000 })
    await page.waitForTimeout(800)
    const row = (name) => page.locator('div', { has: page.getByText(name, { exact: true }) }).filter({ has: page.locator('[aria-label="Arrival status"]') }).last()
    const emma = await row('Emma Juner').locator('[aria-label="Arrival status"]').innerText()
    check('Emma: cleaned, checklist done, arriving 6pm to 9pm', /Clean ✓/.test(emma) && /Checklist ✓/.test(emma) && /6pm to 9pm/.test(emma), emma)
    const sam = await row('Sam Late').locator('[aria-label="Arrival status"]').innerText()
    check('Sam: Amly still to clean, a checklist item overdue, no arrival time from another stay', /To clean/.test(sam) && /Checklist late/.test(sam) && !/After 9pm/.test(sam), sam)
    // The letting form shows the answer too.
    await page.getByText('Emma Juner').first().click()
    await page.getByText('Expected arrival:').waitFor({ timeout: 10000 })
    check('letting form: expected arrival from WhatsApp', /6pm to 9pm/.test(await page.getByText('Expected arrival:').locator('..').innerText()))
  } catch (e) { fails.push(e.message) }
  check('no page errors', s.errors.length === 0, s.errors.join(' | '))
  await s.close()
  console.log((fails.length ? fails.length + ' failed' : 'all passed'))
  process.exit(fails.length ? 1 : 0)
})()
