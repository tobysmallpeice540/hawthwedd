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
    earlyCheckIn: '15:00',
    stays: [{ propertyId: 'hamlet', checkIn: T2, checkOut: T5, checkInTime: '15:00' }] },
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
  const waCalls = []
  await page.route('**/.netlify/functions/whatsapp-send', async (route) => {
    const b = JSON.parse(route.request().postData() || '{}'); waCalls.push(b)
    const reply = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })
    if (b.action === 'bookingPreview') return reply({ ok: true, to: '447700900001', day: T2, text: 'Hi Emma, we are looking forward to seeing you', templateStatus: 'APPROVED', alreadySent: waCalls.some((c) => c.action === 'sendBooking') ? new Date().toISOString() : null, buttons: ['Before 6pm', '6pm to 9pm', 'After 9pm'] })
    if (b.action === 'sendBooking') return reply({ ok: true, id: 'w1' })
    return reply({ ok: true })
  })
  try {
    await page.getByText('Emma Juner').first().waitFor({ timeout: 15000 })
    await page.waitForTimeout(800)
    const row = (name) => page.locator('div', { has: page.getByText(name) }).filter({ has: page.locator('[aria-label="Arrival status"]') }).last()
    const emma = await row('Emma Juner').locator('[aria-label="Arrival status"]').innerText()
    check('Emma: Hamlet, cleaned, checks done, ETA 6–9pm, early in 3pm — one line',
      /Clean ✓/.test(emma) && /Checks ✓/.test(emma) && /ETA 6–9pm/.test(emma) && /Early in 3pm/.test(emma), emma)
    const sam = await row('Sam Late').locator('[aria-label="Arrival status"]').innerText()
    check('Sam: Amly still to clean, a checklist item overdue, no arrival time from another stay', /To clean/.test(sam) && /Checks late/.test(sam) && !/after 9pm/i.test(sam), sam)
    check('the property sits after the name, on the same line', (await page.getByText('· Hamlet', { exact: true }).count()) >= 1)
    // Home page order: pipeline then brochure requests at the bottom; no email log.
    const order = await page.evaluate(() => { const t = document.body.innerText; return [t.indexOf('Accom Check-ins'), t.indexOf('Brochure Requests'), t.indexOf('Recent Automated Emails')] })
    check('brochure requests below the check-ins, no Recent Automated Emails', order[1] > order[0] && order[2] === -1, JSON.stringify(order))
    const box = await row('Emma Juner').locator('[aria-label="Arrival status"]').boundingBox()
    check('the markers stay compact (no more than two lines)', box && box.height < 44, JSON.stringify(box))
    // The letting form shows the answer too.
    await page.getByText('Emma Juner').first().click()
    await page.getByText('Expected arrival:').waitFor({ timeout: 10000 })
    check('letting form: expected arrival from WhatsApp', /6pm to 9pm/.test(await page.getByText('Expected arrival:').locator('..').innerText()))
    // Early check-in ticked, with its time; late check-out: tick → midday, written into the last stay's time.
    const early = page.getByLabel('Allow early check-in', { exact: true })
    check('early check-in shows ticked at 3pm', (await early.isChecked()) && (await page.getByLabel('Allow early check-in time').inputValue()) === '15:00')
    await page.getByLabel('Allow late check-out', { exact: true }).check()
    check('late check-out defaults to midday', (await page.getByLabel('Allow late check-out time').inputValue()) === '12:00')
    check('…and the stay shows the new check-out time', (await page.getByRole('button', { name: /12:00/ }).count()) >= 1)
    await page.getByLabel('Allow early check-in', { exact: true }).uncheck()
    check('unticking early check-in puts the stay back to the standard time', (await page.getByRole('button', { name: /15:00/ }).count()) === 0 && (await page.getByRole('button', { name: /16:00/ }).count()) >= 1)
    // Send the pre-arrival WhatsApp by hand: preview, then send; then it says already sent.
    await page.getByRole('button', { name: 'WhatsApp: pre-arrival message…' }).click()
    await page.getByText('Hi Emma, we are looking forward to seeing you').waitFor({ timeout: 5000 })
    await page.getByRole('button', { name: 'Send now' }).click()
    await page.getByText(/^Sent\./).waitFor({ timeout: 5000 })
    check('booking: WhatsApp preview and send by hand', waCalls.some((c) => c.action === 'sendBooking' && c.bookingId === 'A1' && !c.force) && (await page.getByRole('button', { name: 'Send again' }).count()) === 1)
    await page.getByRole('button', { name: 'Close' }).click()
    await page.getByRole('button', { name: 'Save booking', exact: true }).first().click()
    await page.waitForTimeout(600)
    const w = s.calls.filter((c) => c.fn === 'write:app_data').map((c) => c.args).join('\n')
    check('saved: lateCheckOut and the stay time, earlyCheckIn gone', /"lateCheckOut":"12:00"/.test(w) && /"checkOutTime":"12:00"/.test(w) && !/"earlyCheckIn"/.test(w.split('\n').pop() || ''), w.slice(-400))
  } catch (e) { fails.push(e.message) }
  check('no page errors', s.errors.length === 0, s.errors.join(' | '))
  await s.close()
  console.log((fails.length ? fails.length + ' failed: ' + fails.join(' | ') : 'all passed'))
  process.exit(fails.length ? 1 : 0)
})()
