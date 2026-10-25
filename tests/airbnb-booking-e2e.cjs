// tests/airbnb-booking-e2e.cjs
//
// The Airbnb emails on a lettings booking, in the built app with Supabase
// faked (tests/portal-harness.cjs → openStaff):
//   · a booking Airbnb says was cancelled, and one that has left Airbnb's
//     calendar, are listed at the top of Lettings and chipped in the list;
//   · the booking shows the payout after fees, the guests and the stars, and
//     the messages as a chat — the guest on the left, us on the right;
//   · "Mark cancelled" takes a second press and changes only that booking;
//   · "It's not cancelled" records the dismissal and the prompt goes;
//   · Lettings → Settings → Airbnb Sync shows the Gmail connection and Sync now.
//
//   npx vite build --outDir "$HOME/dist-check" --emptyOutDir && node tests/airbnb-booking-e2e.cjs

const os = require('os'), path = require('path')
const { openStaff } = require('./portal-harness.cjs')
const DIST = process.env.DIST || path.join(os.homedir(), 'dist-check')

let passes = 0; const fails = []
const check = (n, ok, d) => { if (ok) passes++; else fails.push(n + (d ? ': ' + d : '')) }
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
const plus = (n) => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)

const ACCOM = [
  { id: 'A1', guestName: 'Ada Lovelace', status: 'confirmed', source: 'airbnb', value: 2193.72, schedule: [], extras: [],
    notes: 'Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMAAAA1111',
    stays: [{ propertyId: 'hamlet', propertyName: 'The Hamlet', checkIn: plus(20), checkOut: plus(22), value: 2193.72 }],
    airbnb: { code: 'HMAAAA1111', threadId: '1234567890', guests: '13 adults, 1 pet', payoutExpected: 2193.72, appliedValue: 2193.72,
              stars: 4, cancelledAt: plus(-1) + 'T09:00:00Z' } },
  { id: 'A2', guestName: 'Grace Hopper', status: 'confirmed', source: 'airbnb', value: 1800, schedule: [], extras: [], airbnbUid: 'u2',
    airbnbMissingSince: plus(0) + 'T10:00:00Z',
    stays: [{ propertyId: 'hamlet', propertyName: 'The Hamlet', checkIn: plus(40), checkOut: plus(42), value: 1800 }] },
  { id: 'A3', guestName: 'Direct Guest', status: 'confirmed', source: 'direct', value: 900, schedule: [], extras: [],
    stays: [{ propertyId: 'hamlet', propertyName: 'The Hamlet', checkIn: plus(60), checkOut: plus(62), value: 900 }] },
]
const CONVO = { ok: true, reservation: { code: 'HMAAAA1111' }, payouts: [], messages: [
  { at: plus(-30) + 'T10:00:00Z', direction: 'guest', author: 'Ada', role: 'Booker', kind: 'enquiry', body: 'Is the barn free that weekend?' },
  { at: plus(-30) + 'T11:00:00Z', direction: 'host', author: 'Rosanna', role: 'Co-host', kind: 'enquiry', body: 'It is — book away!' },
  { at: plus(-29) + 'T09:00:00Z', direction: 'guest', author: 'Ada', role: 'Booker', kind: 'reservation', body: 'Booked. Can we bring a dog?' },
] }

;(async () => {
  const h = await openStaff({ distDir: DIST, appData: { hbf_accom_v1: ACCOM }, rpc: {
    airbnb_admin_conversation: () => CONVO,
    airbnb_admin_status: () => ({ ok: true, connected: true, account: 'host@example.invalid', connected_by: 'Toby', connected_at: plus(-1) + 'T08:00:00Z',
      backfill_done: true, last_sync_at: plus(0) + 'T09:25:00Z', last_error: null, last_result: { read: 3, left: 0 }, reservations: 27, messages: 140, read: 600 }),
  } })
  const page = h.page
  const syncCalls = []
  await page.route('**/.netlify/functions/airbnb-mail', async (route) => {
    syncCalls.push(JSON.parse(route.request().postData() || '{}'))
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, read: 5, left: 0, more: false, bookingsUpdated: 1 }) })
  })
  await page.getByText('Upcoming Events', { exact: false }).first().waitFor({ timeout: 10000 })
  await page.locator('nav, aside').getByText('Lettings', { exact: true }).first().click()

  // ── The banner ──────────────────────────────────────────────────────────
  const banner = page.getByText('2 Airbnb bookings look cancelled', { exact: false })
  await banner.waitFor({ timeout: 8000 }).catch(() => {})
  check('L1 both bookings are listed at the top of Lettings', await banner.count() > 0)
  check('L2 the direct booking is not', !(await page.locator('button', { hasText: 'Direct Guest' }).count()))

  // ── The booking ─────────────────────────────────────────────────────────
  await page.locator('button', { hasText: 'Ada Lovelace' }).first().click()
  await page.getByText('Cancelled on Airbnb on', { exact: false }).first().waitFor({ timeout: 8000 }).catch(() => {})
  const body = await page.locator('body').innerText()
  check('B1 the cancellation prompt', /Cancelled on Airbnb on/.test(body))
  check('B2 payout after fees', /£2,193\.72\s+payout due from Airbnb/.test(body), (body.match(/£2,193[^\n]*/) || [''])[0])
  check('B3 guests', body.includes('13 adults, 1 pet'))
  check('B4 stars', (await page.locator('[title="4 stars on Airbnb"]').count()) > 0)

  await page.getByText('Booked. Can we bring a dog?').waitFor({ timeout: 8000 }).catch(() => {})
  const align = async (txt) => page.getByText(txt, { exact: true }).evaluate((el) => getComputedStyle(el.parentElement).alignItems)
  check('C1 the guest on the left', (await align('Is the barn free that weekend?')) === 'flex-start')
  check('C2 the co-host on the right', (await align('It is — book away!')) === 'flex-end')
  check('C3 stage headings', body.includes('ENQUIRY') || (await page.getByText(/Enquiry ·/).count()) > 0)
  const convoCall = h.calls.find((c) => c.fn === 'airbnb_admin_conversation')
  check('C4 asked for this booking\'s code and thread', convoCall && convoCall.args.p_code === 'HMAAAA1111' && convoCall.args.p_thread === '1234567890', JSON.stringify(convoCall))

  // Mark cancelled: two presses, only this booking changes.
  const before = h.calls.filter((c) => c.fn === 'write:app_data').length
  await page.getByRole('button', { name: 'Mark cancelled (frees the dates)' }).click()
  check('X1 the first press only asks', h.calls.filter((c) => c.fn === 'write:app_data').length === before
    && (await page.getByRole('button', { name: 'Mark cancelled — sure?' }).count()) === 1)
  await page.getByRole('button', { name: 'Mark cancelled — sure?' }).click()
  await page.waitForTimeout(800)
  const writes = h.calls.filter((c) => c.fn === 'write:app_data').slice(before)
  const accomWrite = writes.map((w) => { try { return JSON.parse(w.args) } catch (e) { return null } })
    .find((w) => w && (w.key === 'hbf_accom_v1' || (Array.isArray(w) && w[0] && w[0].key === 'hbf_accom_v1')))
  const list = accomWrite ? (accomWrite.value || accomWrite[0].value) : null
  check('X2 written once', !!list, JSON.stringify(writes).slice(0, 300))
  if (list) {
    const by = (id) => list.find((b) => b.id === id)
    check('X3 this booking is cancelled', by('A1').status === 'cancelled')
    check('X4 nothing else changed', by('A2').status === 'confirmed' && by('A3').status === 'confirmed' && list.length === 3
      && JSON.stringify(by('A2')) === JSON.stringify(ACCOM[1]))
  }
  check('X5 the prompt goes once cancelled', !(await page.getByText('Cancelled on Airbnb on', { exact: false }).count()))

  // "It's not cancelled": the dismissal is recorded on that booking only.
  await page.getByRole('button', { name: 'Exit' }).first().click()
  await page.getByText('An Airbnb booking looks cancelled', { exact: false }).first().waitFor({ timeout: 8000 }).catch(() => {})
  await page.locator('button', { hasText: 'Grace Hopper' }).first().click()
  await page.getByText("No longer in Airbnb's calendar", { exact: false }).first().waitFor({ timeout: 8000 }).catch(() => {})
  check('D1 the gone-from-Airbnb prompt', (await page.getByText("No longer in Airbnb's calendar", { exact: false }).count()) > 0)
  const before2 = h.calls.filter((c) => c.fn === 'write:app_data').length
  await page.getByRole('button', { name: "It's not cancelled" }).click()
  await page.getByRole('button', { name: 'Keep it — sure?' }).click()
  await page.waitForTimeout(800)
  const w2 = h.calls.filter((c) => c.fn === 'write:app_data').slice(before2).map((w) => { try { return JSON.parse(w.args) } catch (e) { return null } })
    .map((w) => w && (w.value || (Array.isArray(w) && w[0] && w[0].value))).find(Array.isArray)
  const g = w2 && w2.find((b) => b.id === 'A2')
  check('D2 dismissal recorded, booking still confirmed', g && g.status === 'confirmed' && g.airbnb && !!g.airbnb.missingDismissedAt && g.airbnbMissingSince === ACCOM[1].airbnbMissingSince, JSON.stringify(g))
  check('D3 the prompt goes', !(await page.getByText("No longer in Airbnb's calendar", { exact: false }).count()))

  // ── Settings → Airbnb Sync ──────────────────────────────────────────────
  await page.getByRole('button', { name: 'Exit' }).first().click()
  await page.locator('nav, aside').getByText('Settings', { exact: true }).first().click().catch(() => {})
  await page.getByText('Airbnb Sync', { exact: true }).first().click().catch(() => {})
  await page.getByText('Connected to', { exact: false }).first().waitFor({ timeout: 8000 }).catch(() => {})
  const s = await page.locator('body').innerText()
  check('S1 the connection shows', s.includes('host@example.invalid') && /27 Airbnb bookings, 140 messages/.test(s), (s.match(/Connected to[^\n]*/) || [''])[0])
  await page.getByRole('button', { name: 'Sync now' }).first().click()
  await page.getByText('Read 5 emails.', { exact: false }).first().waitFor({ timeout: 8000 }).catch(() => {})
  check('S2 sync now reports what it read', (await page.getByText('Read 5 emails. 1 booking updated.', { exact: false }).count()) > 0 && syncCalls[0] && syncCalls[0].action === 'sync')

  check('E1 no page errors', !h.errors.length, h.errors.join(' | '))
  await h.close()
  console.log(passes + ' passed' + (fails.length ? ', FAILURES:\n  ' + fails.join('\n  ') : ', 0 failed'))
  process.exit(fails.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
