// tests/record-links-e2e.cjs
//
// A row that stands for one record opens that record — not the list it sits
// in. Built app, Supabase faked (tests/portal-harness.cjs → openStaff):
//   · Home: upcoming event, check-in, brochure request, viewing request and a
//     box office event each open their own page;
//   · a converted enquiry offers "Open event" in place of Convert;
//   · the lettings year calendar: a day with one thing on it opens it, a day
//     with several offers a short list; the month view has an events lane.
//
//   npx vite build --outDir "$HOME/dist-check" --emptyOutDir && node tests/record-links-e2e.cjs

const os = require('os'), path = require('path')
const { openStaff } = require('./portal-harness.cjs')
const DIST = process.env.DIST || path.join(os.homedir(), 'dist-check')

let passes = 0; const fails = []
const check = (n, ok, d) => { if (ok) passes++; else fails.push(n + (d ? ': ' + d : '')) }

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
const plus = (n) => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)

const BOOKINGS = [
  { id: 701, couple: 'Upcoming Couple', date: plus(3), status: 'Confirmed', eventType: 'Wedding (Peak)' },
  { id: 702, couple: 'Ed Booked', date: plus(200), status: 'Confirmed', eventType: 'Wedding (Peak)', fromEnquiryId: 'enq_2' },
]
const ACCOM = [
  { id: 'A100', guestName: 'Michael and Sonia', status: 'confirmed', bookingType: 'Standard', source: 'direct',
    stays: [{ propertyId: 'hamlet', propertyName: 'The Hamlet', checkIn: plus(2), checkOut: plus(5), value: 900 }], schedule: [] },
]
const ENQUIRIES = [
  { id: 'enq_1', name: 'Bea Brochure', email: 'bea@x.test', brochureRequests: ['br_1'], contacts: [], viewings: [], outcome: 'undecided', temperature: 'brochure' },
  { id: 'enq_2', name: 'Ed Booked', email: 'ed@x.test', contacts: [], viewings: [], outcome: 'undecided', temperature: 'warm' },
]
const BROCHURE = [{ id: 'br_1', name: 'Bea Brochure', email: 'bea@x.test', submittedAt: new Date().toISOString(), emailSent: true }]
const VIEWING_REQS = [{ id: 'vr_1', name: 'Vic Viewer', email: 'vic@x.test', status: 'pending', date: plus(10), time: '11:00', eventType: 'Wedding' }]
const APP = {
  hawthbush_bookings_v6: BOOKINGS, hbf_accom_v1: ACCOM, hbf_enquiries_v1: ENQUIRIES,
  hbf_brochure_requests_v1: BROCHURE, hbf_viewing_requests_v1: VIEWING_REQS,
}
const BOX_EVENT = { id: 55, name: 'Supper Club Night', status: 'published', starts_at: plus(9) + 'T19:00:00Z', stat_sold: 10, stat_capacity: 40, stat_revenue: 50000 }

async function open() {
  const h = await openStaff({ distDir: DIST, appData: APP })
  const box = []
  await h.page.route('**/.netlify/functions/box-admin', async (route) => {
    const b = JSON.parse(route.request().postData() || '{}')
    box.push(b)
    const body = b.action === 'events.list' ? { events: [BOX_EVENT] }
      : b.action === 'balances.due' ? { orders: [], events: [BOX_EVENT] }
      : b.action === 'events.get' ? { event: BOX_EVENT, ticket_types: [], orders: [] }
      : {}
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  h.box = box
  await h.page.getByText('Upcoming Events', { exact: false }).first().waitFor({ timeout: 10000 })
  return h
}
async function home(h) {
  await h.page.locator('nav, aside').getByText('Home', { exact: true }).first().click()
  await h.page.getByText('Upcoming Events', { exact: false }).first().waitFor({ timeout: 8000 })
}
const inputWith = (page, v) => page.locator('input').evaluateAll((els, v) => els.some((e) => e.value === v), v)

;(async () => {
  const h = await open()
  const page = h.page

  // ── Home ────────────────────────────────────────────────────────────────
  await page.getByText('Upcoming Couple', { exact: true }).first().click()
  await page.waitForTimeout(600)
  check('H1 an upcoming event opens its event form', await inputWith(page, 'Upcoming Couple'))

  await home(h)
  await page.getByText('Michael and Sonia', { exact: true }).first().click()
  await page.waitForTimeout(900)
  check('H2 a check-in opens that letting, not the calendar', await inputWith(page, 'Michael and Sonia'))

  await home(h)
  await page.getByText('Bea Brochure', { exact: true }).first().click()
  await page.waitForTimeout(900)
  check('H3 a brochure request opens its enquiry', await inputWith(page, 'bea@x.test'))

  await home(h)
  await page.getByText('Vic Viewer', { exact: true }).first().click()
  await page.waitForTimeout(900)
  const vr = page.locator('#vr-vr_1')
  check('H4 a viewing request lands on its own card', (await vr.count()) === 1)
  const border = await vr.evaluate((e) => getComputedStyle(e).borderTopWidth).catch(() => '')
  check('H5 and the card is picked out', border === '2px', border)

  await home(h)
  await page.getByText('Supper Club Night', { exact: true }).first().waitFor({ timeout: 8000 })
  await page.getByText('Supper Club Night', { exact: true }).first().click()
  await page.waitForTimeout(900)
  check('H6 a box office event opens its editor', h.box.some((b) => b.action === 'events.get' && String(b.id) === '55'),
    JSON.stringify(h.box.map((b) => b.action)))

  // ── Converted enquiry ───────────────────────────────────────────────────
  await page.locator('nav, aside').getByText('Enquiries', { exact: true }).first().click()
  await page.getByText('Ed Booked', { exact: true }).first().click()
  await page.waitForTimeout(600)
  const openEv = page.getByRole('button', { name: /Open event/ })
  check('E1 a converted enquiry offers Open event', (await openEv.count()) === 1)
  check('E2 and no second Convert', (await page.getByRole('button', { name: 'Convert to Booking' }).count()) === 0)
  await openEv.click()
  await page.waitForTimeout(600)
  check('E3 Open event opens it', await inputWith(page, 'Ed Booked'))

  // ── Lettings calendar ───────────────────────────────────────────────────
  // A booking on plus(2..4) and an event on plus(3): plus(2) holds one thing,
  // plus(3) two.
  async function toCalendar() {
    await page.locator('nav, aside').getByText('Calendar', { exact: true }).first().click()
    await page.getByText('Hover a date', { exact: false }).first().waitFor({ timeout: 8000 })
    // The year grid for the right year
    const yr = Number(plus(2).slice(0, 4))
    for (let i = 0; i < 3; i++) {
      const shown = await page.locator('body').innerText()
      if (shown.indexOf(String(yr)) !== -1) break
    }
  }
  async function clickDay(iso) {
    await page.locator('[data-day="' + iso + '"]').first().click()
  }
  await toCalendar()
  await clickDay(plus(2))
  await page.waitForTimeout(700)
  check('C1 a day with one booking opens it', await inputWith(page, 'Michael and Sonia'))

  await toCalendar()
  await clickDay(plus(3))
  await page.waitForTimeout(400)
  const picker = page.getByRole('dialog')
  const pickTxt = (await picker.count()) ? await picker.innerText() : ''
  check('C2 a busy day offers what is on it', /Upcoming Couple/.test(pickTxt) && /Michael and Sonia/.test(pickTxt), pickTxt)
  if (await picker.count()) {
    await picker.getByRole('button', { name: /Upcoming Couple/ }).click()
    await page.waitForTimeout(600)
    check('C3 picking the event opens it', await inputWith(page, 'Upcoming Couple'))
  }

  await toCalendar()
  const mName = new Date(plus(3) + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })
  await page.getByText(mName, { exact: true }).first().click()
  await page.waitForTimeout(400)
  const lane = page.locator('div[title*="Upcoming Couple"]')
  check('C4 the month view has the event in an events lane', (await lane.count()) >= 1)
  if (await lane.count()) {
    await lane.first().click()
    await page.waitForTimeout(600)
    check('C5 and it opens the event', await inputWith(page, 'Upcoming Couple'))
  }

  check('X1 no page errors', h.errors.length === 0, h.errors.join(' | '))
  await h.close()

  console.log(passes + ' passed, ' + fails.length + ' failed')
  fails.forEach((f) => console.log('  FAIL ' + f))
  process.exit(fails.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
