// tests/box-staffing-e2e.cjs
//
// Ticketed events carry their own rota, notes and clash warnings (2 Nov 2026),
// so a supper club needs no diary event alongside it. Built app, Supabase and
// box-admin faked (tests/portal-harness.cjs → openStaff), writes kept:
//   · the event form warns when a box office event is on its date, and opens it;
//   · the box office editor warns about ANY diary event that day, not only
//     weddings, and leaves a cancelled one out;
//   · housekeeper notes and office notes save from the box office editor;
//   · the Staffing tab saves roles, shift times and hours — only the fields it
//     changed, over a fresh read, keeping the office notes and other records;
//   · the rota and hours reports show ticketed events, and a row opens the
//     box office editor.
//
//   npx vite build --outDir "$HOME/dist-check" --emptyOutDir && node tests/box-staffing-e2e.cjs

const os = require('os'), path = require('path')
const { openStaff } = require('./portal-harness.cjs')
const DIST = process.env.DIST || path.join(os.homedir(), 'dist-check')
const HOST = 'https://rkqbyisfmvwulsyxzwjz.supabase.co'

let passes = 0; const fails = []
const check = (n, ok, d) => { if (ok) passes++; else fails.push(n + (d ? ': ' + d : '')) }

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
const plus = (n) => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)

const D = plus(5)   // inside the home page's next-7-days list
const BOX_ID = 'f84f9946-ef18-4fca-bebf-08fd084ec92a'
const BOX_EV = { id: BOX_ID, name: 'Eat Daps Super Club', slug: 'eat-daps', status: 'published',
  starts_at: D + 'T18:00:00Z', ends_at: D + 'T23:00:00Z', venue_name: 'The Grain Store', payment_mode: 'full' }
const blankRota = { setup: [], dayManager: [], dayStaff: [], barSupervisor: [], sunday: [], bar: [], dayHandy: [], eveHandy: [], hoursWorked: {} }

function freshApp() {
  return {
    hawthbush_bookings_v6: [
      Object.assign({ id: 230, couple: 'Eat Daps supper club', date: D, status: 'Confirmed', eventType: 'Other' }, blankRota),
      Object.assign({ id: 231, couple: 'Called Off Party', date: D, status: 'Cancelled', eventType: 'Party' }, blankRota),
      Object.assign({ id: 701, couple: 'Upcoming Couple', date: plus(3), status: 'Confirmed', eventType: 'Wedding (Peak)' }, blankRota),
    ],
    hawthbush_staff_v5: [
      { id: 'BW', name: 'Bonnie Whitmore', role: 'Day Manager', active: true },
      { id: 'TM', name: 'Tom Mitchell', role: 'Bar Staff', active: true },
      { id: 'ED', name: 'Edita Cleaner', role: 'Housekeeping', active: true },
    ],
    // A rota on an event the box office no longer lists (a draft, or deleted):
    // its hours must still reach the hours report from the snapshot.
    hbf_box_staffing_v1: [
      { id: 'old-quiz', bar: ['TM'], hoursWorked: { TM: 4 }, eventName: 'Old Quiz Night', eventDate: plus(-10) },
    ],
  }
}

async function open() {
  const app = freshApp()
  const h = await openStaff({ distDir: DIST, appData: app })
  h.app = app
  h.box = []
  await h.page.route(HOST + '/rest/v1/app_data', async (route) => {
    const req = route.request()
    if (req.method() !== 'POST') return route.fallback()
    const b = JSON.parse(req.postData() || '{}')
    app[b.key] = b.value
    h.calls.push({ fn: 'write:app_data', args: req.postData() })
    return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' })
  })
  await h.page.route('**/.netlify/functions/box-admin', async (route) => {
    const b = JSON.parse(route.request().postData() || '{}')
    h.box.push(b)
    const body = b.action === 'events.list' ? { events: [BOX_EV] }
      : b.action === 'balances.due' ? { orders: [], events: [] }
      : b.action === 'housekeeping.events' ? { events: [BOX_EV] }
      : b.action === 'payees.list' ? { payees: [] }
      : b.action === 'events.get' ? { event: BOX_EV, ticket_types: [], orders: [], waitlist: [], discount_codes: [], order_lines: [] }
      : {}
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await h.page.reload()
  await h.page.getByText('Upcoming Events', { exact: false }).first().waitFor({ timeout: 15000 })
  return h
}
const nav = (page, label) => page.locator('nav, aside').getByText(label, { exact: true }).first().click()
const saves = (h, key) => h.calls.filter((c) => c.fn === 'write:app_data').map((c) => JSON.parse(c.args)).filter((x) => x.key === key)

;(async () => {
  const h = await open()
  const page = h.page
  try {
    // ── The diary event form ──────────────────────────────────────────────
    await page.getByText('Eat Daps supper club', { exact: true }).first().click()
    const warn = page.getByText(/There's already a box office event that night: Eat Daps Super Club/)
    await warn.first().waitFor({ timeout: 8000 }).catch(() => {})
    check('E1 the event form warns of the box office event that night', (await warn.count()) > 0)
    check('E2 and asks whether it is the same thing', /Is this the same thing\?/.test(await page.locator('body').innerText()))
    await page.getByRole('button', { name: 'Open it' }).first().click()
    await page.getByText('Eat Daps Super Club', { exact: true }).first().waitFor({ timeout: 8000 })
    check('E3 "Open it" opens the box office editor', h.box.some((b) => b.action === 'events.get' && b.id === BOX_ID))

    // ── The box office editor ─────────────────────────────────────────────
    const body1 = await page.locator('body').innerText()
    check('B1 the diary clash is about any event, not only weddings', /There is an event in the diary on that date/.test(body1), body1.slice(0, 400))
    check('B2 it names the diary event and its type', /Eat Daps supper club \(Other,/.test(body1))
    check('B3 a cancelled diary event is left out', !/Called Off Party/.test(body1))

    const hk = page.getByLabel('Notes to housekeepers')
    await hk.waitFor({ timeout: 8000 })
    await hk.fill('Tables for 60, long rows')
    await page.getByLabel('Office notes').click()
    await page.waitForTimeout(800)
    const sc = saves(h, 'hbf_setup_cleans_v1').pop()
    const note = sc && sc.value.find((x) => x.id === 'note:box:' + BOX_ID)
    check('B4 housekeeper notes save on a box office event', note && note.text === 'Tables for 60, long rows' && note.of === 'box', JSON.stringify(sc && sc.value))

    await page.getByLabel('Office notes').fill('Chef arrives 3pm, own staff for the kitchen')
    await page.getByLabel('Notes to housekeepers').click()
    await page.waitForTimeout(800)
    let st = h.app.hbf_box_staffing_v1
    const recN = st.find((r) => r.id === BOX_ID)
    check('B5 office notes save to the event\'s staffing record', recN && recN.officeNotes === 'Chef arrives 3pm, own staff for the kitchen', JSON.stringify(st))
    check('B6 and leave the other records alone', st.some((r) => r.id === 'old-quiz' && r.hoursWorked.TM === 4))

    // ── Staffing tab ──────────────────────────────────────────────────────
    await page.getByRole('tab', { name: 'Staffing' }).click()
    await page.getByText('Set-up (day before)').waitFor({ timeout: 8000 })
    check('S1 no "Sunday" role on a ticketed night', !(await page.locator('label', { hasText: /^Sunday$/ }).count()))
    await page.locator('label', { hasText: /^Day Manager$/ }).locator('xpath=following-sibling::div[1]').click()
    const options = await page.locator('div[style*="max-height: 220px"]').innerText()
    check('S2 housekeeping staff are not offered', !/Edita Cleaner/.test(options) && /Bonnie Whitmore/.test(options), options)
    await page.locator('div[style*="max-height: 220px"]').getByText('Bonnie Whitmore').click()
    await page.getByLabel('Start time for Bonnie Whitmore').fill('17:00')
    await page.getByLabel('End time for Bonnie Whitmore').fill('00:30')
    await page.getByLabel('Hours worked by Bonnie Whitmore').fill('7.5')
    const est = await page.locator('body').innerText()
    check('S3 a shift past midnight estimates 7.5h, not a negative', /7\.5h/.test(est))
    await page.getByText('All changes saved').waitFor({ timeout: 6000 }).catch(() => {})
    st = h.app.hbf_box_staffing_v1
    const rec = st.find((r) => r.id === BOX_ID) || {}
    check('S4 the rota saves', JSON.stringify(rec.dayManager) === '["BW"]', JSON.stringify(rec))
    check('S5 shift and hours save', rec.staffShifts && rec.staffShifts.BW && rec.staffShifts.BW.start === '17:00' && rec.staffShifts.BW.end === '00:30' && rec.hoursWorked.BW === 7.5, JSON.stringify(rec))
    check('S6 the office notes written earlier are kept', rec.officeNotes === 'Chef arrives 3pm, own staff for the kitchen')
    check('S7 a snapshot of the saved name and day', rec.eventName === 'Eat Daps Super Club' && rec.eventDate === D, rec.eventName + ' ' + rec.eventDate)

    // ── Reports ───────────────────────────────────────────────────────────
    await nav(page, 'Reports')
    await nav(page, 'Rota Overview')
    await page.getByText('Eat Daps Super Club', { exact: true }).first().waitFor({ timeout: 8000 }).catch(() => {})
    const rotaRow = page.locator('tr', { hasText: 'Eat Daps Super Club' })
    check('R1 the ticketed event is on the rota', (await rotaRow.count()) === 1)
    check('R2 with its day manager', (await rotaRow.locator('[title*="Bonnie"], :text("BW")').count()) > 0)
    const getsBefore = h.box.filter((b) => b.action === 'events.get').length
    await rotaRow.getByText('Eat Daps Super Club').click()
    await page.waitForTimeout(900)
    check('R3 its row opens the box office editor', h.box.filter((b) => b.action === 'events.get').length > getsBefore)

    await nav(page, 'Reports')
    await nav(page, 'Hours Worked')
    await page.getByText('Tom Mitchell').first().waitFor({ timeout: 8000 }).catch(() => {})
    const hrs = await page.locator('body').innerText()
    check('R4 hours on a ticketed event the box office no longer lists still count', /Tom Mitchell/.test(hrs) && /\b4h\b/.test(hrs), hrs.slice(0, 600))

    check('Z no page errors', h.errors.length === 0, h.errors.join(' | '))
  } catch (e) {
    fails.push('crashed: ' + (e && e.stack || e))
  } finally {
    await h.close()
  }
  console.log(passes + ' passed, ' + fails.length + ' failed')
  fails.forEach((f) => console.log('  FAIL ' + f))
  process.exit(fails.length ? 1 : 0)
})()
