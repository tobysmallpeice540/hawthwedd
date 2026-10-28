// tests/changeover-e2e.cjs
//
// The housekeeping sign-off, end to end. Built app, Supabase faked
// (tests/portal-harness.cjs → openStaff):
//   · the cleaner login has Live / Events / Calendar / Bookings, and Bookings
//     shows no prices;
//   · the Live tab's status line colours each property: red waiting, yellow
//     in use, green ready;
//   · Done opens the sign-off (hours for each cleaner, editable time,
//     comments, lost property) and saves one record to hbf_changeovers_v1;
//   · Events lists what is coming, a provisional date has no Done button;
//   · the admin home shows the same four tiles with the last comments and
//     lost property, and the lettings list and the booking itself show the
//     lost property.
//
//   npx vite build --outDir "$HOME/dist-check" --emptyOutDir && node tests/changeover-e2e.cjs

const os = require('os'), path = require('path')
const { openStaff } = require('./portal-harness.cjs')
const DIST = process.env.DIST || path.join(os.homedir(), 'dist-check')

let passes = 0; const fails = []
const check = (n, ok, d) => { if (ok) passes++; else fails.push(n + (d ? ': ' + d : '')) }

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
const plus = (n) => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)

const PROPS = [
  { id: 'hamlet', name: 'The Hamlet', colour: '#2563eb' },
  { id: 'amly', name: 'Amly Barn', colour: '#16a34a' },
  { id: 'glamping', name: 'Glamping', colour: '#9333ea' },
]
const stay = (p, a, b, v) => ({ propertyId: p, checkIn: a, checkOut: b, value: v })
const ACCOM = [
  { id: 'A1', guestName: 'Red Guest', status: 'confirmed', source: 'direct', value: 999, stays: [stay('hamlet', plus(-3), plus(-1), 999)], schedule: [] },
  { id: 'A2', guestName: 'Yellow Guest', status: 'confirmed', source: 'direct', value: 999, stays: [stay('amly', plus(-1), plus(2), 999)], schedule: [] },
  { id: 'A3', guestName: 'Hat Guest', status: 'confirmed', source: 'direct', value: 999, stays: [stay('glamping', plus(-6), plus(-2), 999)], schedule: [] },
  { id: 'A4', guestName: 'Later Guest', status: 'confirmed', source: 'direct', value: 999, stays: [stay('hamlet', plus(5), plus(7), 999)], schedule: [] },
  { id: 'A5', guestName: 'Ancient Guest', status: 'confirmed', source: 'direct', value: 999, stays: [stay('amly', '2026-09-01', '2026-09-04', 999)], schedule: [] },
]
const EVENTS = [
  { id: 801, couple: 'Smith Wedding', date: plus(3), status: 'Confirmed', eventType: 'Wedding (Peak)' },
  { id: 802, couple: 'Maybe Party', date: plus(9), status: 'Holding', eventType: 'Party' },
  { id: 803, couple: 'Done Do', date: plus(-4), status: 'Confirmed', eventType: 'Party' },
  { id: 804, couple: 'Messy Do', date: plus(-2), status: 'Confirmed', eventType: 'Party' },
]
const CHANGEOVERS = [
  { id: 'accom:A3:glamping', kind: 'accom', refId: 'A3', unitId: 'glamping', unitName: 'Glamping', due: plus(-2),
    doneAt: plus(-2) + 'T15:30', hours: { edita: 2, karina: 1 }, comments: 'Tent 4 zip sticking', lostProperty: 'black hat' },
  { id: 'event:803', kind: 'event', refId: 803, unitId: 'grainstore', unitName: 'Grain Store', due: plus(-3),
    doneAt: plus(-3) + 'T11:00', hours: { edita: 3, karina: 0 }, comments: '', lostProperty: '' },
]
const APP = { hbf_properties_v1: PROPS, hbf_accom_v1: ACCOM, hawthbush_bookings_v6: EVENTS, hbf_changeovers_v1: CHANGEOVERS }

const cleanerRpc = { my_profile: () => ({ id: '00000000-0000-4000-8000-00000000beef', role: 'cleaner', active: true, name: 'Housekeeping' }) }

;(async () => {
  // ── The cleaner login ────────────────────────────────────────────────────
  let s = await openStaff({ distDir: DIST, appData: JSON.parse(JSON.stringify(APP)), rpc: cleanerRpc })
  let page = s.page
  try {
    await page.getByText('Still to sign off').waitFor({ timeout: 15000 })
    const body = await page.locator('body').innerText()
    check('tab Live', /\bLive\b/.test(body))
    check('tab Events', /\bEvents\b/.test(body))
    check('no "next 14 days" heading', !/The next 14 days/.test(body))

    // Status line: one pill per unit, coloured by state.
    const pill = async (name) => page.locator('span[title]', { hasText: name }).first().getAttribute('title')
    check('Hamlet waiting', (await pill('The Hamlet')) === 'Needs cleaning', await pill('The Hamlet'))
    check('Amly in use', (await pill('Amly Barn')) === 'In use', await pill('Amly Barn'))
    check('Glamping ready', (await pill('Glamping')) === 'Ready', await pill('Glamping'))
    check('Grain Store waiting (Messy Do)', (await pill('Grain Store')) === 'Needs cleaning', await pill('Grain Store'))

    // Overdue box lists Red Guest and Messy Do, not the untracked September stay.
    const overdue = await page.getByText('Still to sign off').locator('..').innerText()
    check('overdue has Red Guest', /Red Guest/.test(overdue), overdue)
    check('overdue has Messy Do', /Messy Do/.test(overdue), overdue)
    check('untracked old stay not overdue', !/Ancient Guest/.test(overdue))

    // Sign off the Hamlet.
    const row = page.getByText('Still to sign off').locator('..').locator('div', { hasText: 'Red Guest' }).last()
    await row.getByRole('button', { name: 'Done' }).click()
    await page.getByText('Edita hours').waitFor({ timeout: 5000 })
    check('dialog has Karina hours', await page.getByText('Karina hours').isVisible())
    const inputs = page.locator('input[type=number]')
    await inputs.nth(0).fill('2.5')
    await inputs.nth(1).fill('1.25')
    await page.locator('input[type=datetime-local]').fill(plus(-1) + 'T16:45')
    await page.locator('textarea').nth(0).fill('Shower drain slow')
    await page.locator('textarea').nth(1).fill('umbrella')
    await page.getByRole('button', { name: 'Done — ready' }).click()
    await page.getByText('Edita hours').waitFor({ state: 'detached', timeout: 5000 })

    const writes = s.calls.filter((c) => c.fn === 'write:app_data').map((c) => JSON.parse(c.args))
    const w = writes.filter((x) => x.key === 'hbf_changeovers_v1').pop()
    check('one write to hbf_changeovers_v1', !!w, JSON.stringify(writes.map((x) => x.key)))
    if (w) {
      const rec = w.value.find((r) => r.id === 'accom:A1:hamlet')
      check('record saved', !!rec)
      check('existing sign-offs kept', w.value.length === 3, String(w.value.length))
      if (rec) {
        check('hours per cleaner', rec.hours.edita === 2.5 && rec.hours.karina === 1.25, JSON.stringify(rec.hours))
        check('edited time kept', rec.doneAt === plus(-1) + 'T16:45', rec.doneAt)
        check('comments', rec.comments === 'Shower drain slow')
        check('lost property', rec.lostProperty === 'umbrella')
      }
    }
    check('no other key written', writes.every((x) => x.key === 'hbf_changeovers_v1' || x.key === 'hbf_app_build_v1'), JSON.stringify(writes.map((x) => x.key)))
    check('Hamlet now ready', (await pill('The Hamlet')) === 'Ready', await pill('The Hamlet'))

    // Events tab.
    await page.getByRole('tab', { name: 'Events', exact: true }).click()
    await page.getByText('Smith Wedding').waitFor({ timeout: 5000 })
    const evBody = await page.locator('body').innerText()
    check('future event listed', /Smith Wedding/.test(evBody))
    check('provisional listed and marked', /Maybe Party[\s\S]*provisional/.test(evBody))
    check('past event not listed', !/Done Do/.test(evBody))
    const maybeRow = page.locator('div', { hasText: 'Maybe Party' }).last().locator('..').locator('..')
    check('provisional has no Done button', (await maybeRow.getByRole('button', { name: /Done/ }).count()) === 0)
    const smithRow = page.locator('div', { hasText: 'Smith Wedding' }).last().locator('..').locator('..')
    check('future event Done is inert', await smithRow.getByRole('button', { name: /Done/ }).isDisabled())

    // Bookings tab: no money.
    await page.getByRole('tab', { name: 'Bookings', exact: true }).click()
    await page.getByText('Later Guest').waitFor({ timeout: 5000 })
    await page.getByRole('button', { name: /Show past bookings/ }).click()
    const listBody = await page.locator('body').innerText()
    check('no prices on Bookings', !/999/.test(listBody))
    check('no Value column', !/\bValue\b/.test(listBody) && !/\bPaid\b/.test(listBody))
    check('lost property chip on Hat Guest', /Lost property: black hat/.test(listBody))
    check('no page errors (cleaner)', s.errors.length === 0, s.errors.join(' | '))
  } catch (e) { fails.push('cleaner run: ' + e.message) }
  await s.close()

  // ── Phone width: the status line and Done fit ────────────────────────────
  s = await openStaff({ distDir: DIST, appData: JSON.parse(JSON.stringify(APP)), rpc: cleanerRpc, viewport: { width: 390, height: 844 } })
  page = s.page
  try {
    await page.getByText('Still to sign off').waitFor({ timeout: 15000 })
    const sw = await page.evaluate(() => document.documentElement.scrollWidth)
    check('no sideways scroll on a phone', sw <= 392, String(sw))
    await page.screenshot({ path: path.join(os.tmpdir(), 'changeover-phone.png'), fullPage: false })
  } catch (e) { fails.push('phone run: ' + e.message) }
  await s.close()

  // ── Admin ───────────────────────────────────────────────────────────────
  s = await openStaff({ distDir: DIST, appData: JSON.parse(JSON.stringify(APP)) })
  page = s.page
  try {
    await page.getByText('Lost property:').first().waitFor({ timeout: 15000 })
    const home = await page.locator('body').innerText()
    check('home: Glamping lost property', /Lost property: black hat/.test(home))
    check('home: Glamping comment', /Tent 4 zip sticking/.test(home))
    check('home: Hamlet needs cleaning', /The Hamlet[\s\S]{0,40}Needs cleaning/.test(home), home.slice(0, 600))
    check('home: Amly in use', /Amly Barn[\s\S]{0,20}In use/.test(home))
    await page.screenshot({ path: path.join(os.tmpdir(), 'changeover-home.png'), fullPage: false })

    // The Glamping tile opens Hat Guest's booking, which shows the sign-off.
    await page.locator('div[title="Open the booking"]', { hasText: 'Glamping' }).click()
    await page.getByText(/ready .* · Edita 2h/).waitFor({ timeout: 10000 })
    const form = await page.locator('body').innerText()
    check('booking shows lost property', /Lost property: black hat/.test(form))
    check('booking shows hours', /Edita 2h · Karina 1h/.test(form))
    check('no page errors (admin)', s.errors.length === 0, s.errors.join(' | '))
  } catch (e) { fails.push('admin run: ' + e.message) }
  await s.close()

  console.log(passes + ' passed, ' + fails.length + ' failed')
  fails.forEach((f) => console.log('  FAIL ' + f))
  process.exit(fails.length ? 1 : 0)
})()
