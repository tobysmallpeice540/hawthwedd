// tests/changeover-e2e.cjs
//
// The housekeeping sign-off, end to end. Built app, Supabase faked
// (tests/portal-harness.cjs → openStaff), box-admin faked here:
//   · the cleaner login has Live / Upcoming / Calendar / Bookings / House, and
//     an App button by Sign out with the install steps;
//   · Upcoming: Monday weeks, each changeover listed with the stay or event's
//     own dates, four weeks a page; an empty Sunday is next week's;
//   · Live's status line: one line of short names (Hamlet, Amly, Glamping,
//     Grain St.), red waiting, yellow in use, green ready — box office events
//     count for the Grain Store;
//   · the lozenge says the status; tapping it opens the sign-off (hours per
//     cleaner, editable time, comments, lost property) which saves one record
//     to hbf_changeovers_v1; a green one reopens with what was saved;
//   · Bookings: lettings and Grain Store events (diary and box office) on one
//     page, filtered by property buttons, no prices, the lozenge on the same
//     line on a phone;
//   · House: Karina's Mon–Fri timesheet for The House, week codes (2644),
//     grey / yellow / red / green, saved and submitted;
//   · Reports → Housekeeping Hours: owed per week, priced at the rate on the
//     day (a rise mid-week), Paid tick and date; Staff rates, PAYE / Self-employed;
//   · setup cleans: ticked on a letting / event / box office event, their window,
//     shown on Live, Upcoming and Bookings, signed off like a changeover;
//   · admin: home tiles, lost property on the booking, box office events on
//     the lettings calendar, Reports → Housekeeping Hours.
//
//   npx vite build --outDir "$HOME/dist-check" --emptyOutDir && node tests/changeover-e2e.cjs

const os = require('os'), path = require('path')
const { openStaff } = require('./portal-harness.cjs')
const DIST = process.env.DIST || path.join(os.homedir(), 'dist-check')

let passes = 0; const fails = []
const check = (n, ok, d) => { if (ok) passes++; else fails.push(n + (d ? ': ' + d : '')) }

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
const plus = (n) => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)
const monthOf = (d) => String(d).slice(0, 7)
// ISO week code, worked out independently of the app: YYWW.
const isoCode = (iso) => {
  const d = new Date(iso + 'T00:00:00Z'); const day = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - day + 3)                          // Thursday of that week
  const y = d.getUTCFullYear(); const first = new Date(Date.UTC(y, 0, 4))
  const wk = 1 + Math.round(((d - first) / 86400000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7)
  return String(y).slice(2) + String(wk).padStart(2, '0')
}
const mondayOfT = (iso) => { const d = new Date(iso + 'T00:00:00Z'); return new Date(d - ((d.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10) }
// The app's short date: "Mon 2 Nov 26".
const dshort = (d) => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(d + 'T00:00:00Z').getUTCDay()] + ' ' +
  Number(d.slice(8)) + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(d.slice(5, 7)) - 1] + ' ' + d.slice(2, 4)
const HOST = 'https://rkqbyisfmvwulsyxzwjz.supabase.co'

const PROPS = [
  { id: 'hamlet', name: 'The Hamlet', colour: '#2563eb' },
  { id: 'amly', name: 'Amly Barn', colour: '#16a34a' },
  { id: 'glamping', name: 'Glamping', colour: '#9333ea' },
]
const stay = (p, a, b, v) => ({ propertyId: p, checkIn: a, checkOut: b, value: v })
const ACCOM = [
  { id: 'A1', guestName: 'Red Guest', status: 'confirmed', source: 'direct', value: 999, stays: [stay('hamlet', plus(-3), plus(-1), 999)], schedule: [] },
  { id: 'A2', guestName: 'Yellow Guest', status: 'confirmed', source: 'airbnb', value: 999, stays: [stay('amly', plus(-1), plus(2), 999)], schedule: [] },
  { id: 'A3', guestName: 'Hat Guest', status: 'confirmed', source: 'direct', value: 999, stays: [stay('glamping', plus(-6), plus(-2), 999)], schedule: [] },
  { id: 'A4', guestName: 'Later Guest', status: 'pending', source: 'direct', value: 999, stays: [stay('hamlet', plus(5), plus(7), 999)], schedule: [] },
  { id: 'A5', guestName: 'Ancient Guest', status: 'confirmed', source: 'direct', value: 999, stays: [stay('amly', '2026-09-01', '2026-09-04', 999)], schedule: [] },
  { id: 'A6', guestName: 'Not available', bookingType: 'Blocked', status: 'confirmed', stays: [stay('glamping', plus(8), plus(9), 0)], schedule: [] },
]
const EVENTS = [
  { id: 801, couple: 'Smith Wedding', date: plus(3), status: 'Confirmed', eventType: 'Wedding (Peak)' },
  { id: 802, couple: 'Maybe Party', date: plus(9), status: 'Holding', eventType: 'Party' },
  { id: 803, couple: 'Done Do', date: plus(-4), status: 'Confirmed', eventType: 'Party' },
  { id: 804, couple: 'Messy Do', date: plus(-2), status: 'Confirmed', eventType: 'Party' },
]
const BOX = [
  { id: 'b-quiz', name: 'Quiz Night', starts_at: plus(-2) + 'T19:00:00Z', ends_at: plus(-2) + 'T21:00:00Z', venue_name: 'The Grain Store' },
  { id: 'b-supper', name: 'Supper Club', starts_at: plus(4) + 'T18:30:00Z', ends_at: plus(4) + 'T21:30:00Z', venue_name: 'The Grain Store' },
]
const CHANGEOVERS = [
  { id: 'accom:A3:glamping', kind: 'accom', refId: 'A3', unitId: 'glamping', unitName: 'Glamping', who: 'Hat Guest', due: plus(-2),
    doneAt: plus(-2) + 'T15:30', hours: { edita: 2, karina: 1 }, comments: 'Tent 4 zip sticking', lostProperty: 'black hat' },
  { id: 'event:803', kind: 'event', refId: 803, unitId: 'grainstore', unitName: 'Grain Store', who: 'Done Do · Party', due: plus(-3),
    doneAt: plus(-3) + 'T11:00', hours: { edita: 3, karina: 0 }, comments: '', lostProperty: '' },
]
const freshApp = () => JSON.parse(JSON.stringify({
  hbf_properties_v1: PROPS, hbf_accom_v1: ACCOM, hawthbush_bookings_v6: EVENTS, hbf_changeovers_v1: CHANGEOVERS,
}))

const cleanerRpc = { my_profile: () => ({ id: '00000000-0000-4000-8000-00000000beef', role: 'cleaner', active: true, name: 'Housekeeping' }) }

// The harness does not keep writes; here they are kept (so a read after a
// save sees it, as the real database would) and box-admin is answered.
async function open(opts) {
  const appData = freshApp()
  const box = opts.box || BOX
  const s = await openStaff(Object.assign({ distDir: DIST, appData: appData }, opts))
  await s.page.route(HOST + '/rest/v1/app_data', async (route) => {
    const req = route.request()
    if (req.method() !== 'POST') return route.fallback()
    const b = JSON.parse(req.postData() || '{}')
    appData[b.key] = b.value
    s.calls.push({ fn: 'write:app_data', args: req.postData() })
    return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' })
  })
  await s.page.route('**/.netlify/functions/box-admin', async (route) => {
    const b = JSON.parse(route.request().postData() || '{}')
    s.calls.push({ fn: 'box:' + b.action, args: b })
    if (b.action === 'housekeeping.events') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ events: box }) })
    if (b.action === 'balances.due') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ orders: [], events: [] }) })
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'no' }) })
  })
  await s.page.reload()
  return s
}
const lastSave = (s) => s.calls.filter((c) => c.fn === 'write:app_data').map((c) => JSON.parse(c.args))
  .filter((x) => x.key === 'hbf_changeovers_v1').pop()

;(async () => {
  // ── The cleaner login ────────────────────────────────────────────────────
  let s = await open({ rpc: cleanerRpc })
  let page = s.page
  try {
    await page.getByText('Still to sign off').waitFor({ timeout: 15000 })
    await page.getByText('Quiz Night').first().waitFor({ timeout: 5000 })
    const tabNames = await page.getByRole('tab').allInnerTexts()
    check('tab order', tabNames.join('|') === 'Live|Upcoming|Calendar|Bookings|House', tabNames.join('|'))
    check('no "next 14 days" heading', !/The next 14 days/.test(await page.locator('body').innerText()))

    // Status line.
    const pill = async (name) => page.locator('span[title]', { hasText: name }).first().getAttribute('title')
    const pillText = (await page.locator('span[title]').allInnerTexts()).join('|')
    check('short names on the strip', pillText === 'Hamlet|Amly|Glamping|Grain St. ×2', pillText)
    check('Hamlet waiting', (await pill('Hamlet')) === 'To clean', await pill('Hamlet'))
    check('Amly in use', (await pill('Amly')) === 'Guests', await pill('Amly'))
    check('Glamping ready', (await pill('Glamping')) === 'Ready', await pill('Glamping'))
    check('Grain St. waiting', (await pill('Grain St.')) === 'To clean', await pill('Grain St.'))

    const overdue = await page.getByText('Still to sign off').locator('..').innerText()
    check('overdue has Red Guest', /Red Guest/.test(overdue), overdue)
    check('overdue has Messy Do', /Messy Do/.test(overdue), overdue)
    check('overdue has the box office event', /Quiz Night · Box office/.test(overdue), overdue)
    check('untracked old stay not overdue', !/Ancient Guest/.test(overdue))
    check('lozenge says the status', /To clean/.test(overdue) && !/\bDone\b/.test(overdue), overdue)

    // Sign off the Hamlet.
    const row = page.getByText('Still to sign off').locator('..').locator('div[style*="nowrap"]', { hasText: 'Red Guest' }).filter({ has: page.locator('button') }).last()
    await row.getByRole('button', { name: 'To clean' }).click()
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

    const w = lastSave(s)
    check('saved to hbf_changeovers_v1', !!w)
    const rec = w && w.value.find((r) => r.id === 'accom:A1:hamlet')
    check('existing sign-offs kept', w && w.value.length === 3, w && String(w.value.length))
    check('hours per cleaner', rec && rec.hours.edita === 2.5 && rec.hours.karina === 1.25, rec && JSON.stringify(rec.hours))
    check('edited time kept', rec && rec.doneAt === plus(-1) + 'T16:45', rec && rec.doneAt)
    check('comments and lost property', rec && rec.comments === 'Shower drain slow' && rec.lostProperty === 'umbrella')
    check('who is stored', rec && rec.who === 'Red Guest', rec && rec.who)
    const keys = s.calls.filter((c) => c.fn === 'write:app_data').map((c) => JSON.parse(c.args).key)
    check('nothing else written', keys.every((k) => k === 'hbf_changeovers_v1' || k === 'hbf_app_build_v1'), keys.join(','))
    check('Hamlet now ready', (await pill('Hamlet')) === 'Ready', await pill('Hamlet'))

    // Green reopens with what was saved.
    await page.locator('span[title]', { hasText: 'Hamlet' }).first().click()
    await page.getByText('Edita hours').waitFor({ timeout: 5000 })
    check('reopened with saved hours', (await page.locator('input[type=number]').nth(0).inputValue()) === '2.5')
    check('reopened with saved lost property', (await page.locator('textarea').nth(1).inputValue()) === 'umbrella')
    await page.locator('input[type=number]').nth(0).fill('3')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await page.getByText('Edita hours').waitFor({ state: 'detached', timeout: 5000 })
    const w2 = lastSave(s)
    const r2 = w2 && w2.value.find((r) => r.id === 'accom:A1:hamlet')
    check('edit saved', r2 && r2.hours.edita === 3 && r2.lostProperty === 'umbrella', JSON.stringify(r2))
    check('edit is one record, not two', w2 && w2.value.filter((r) => r.id === 'accom:A1:hamlet').length === 1 && w2.value.length === 3)

    // Upcoming: each changeover shows the stay's own dates, not a window.
    await page.getByRole('tab', { name: 'Upcoming', exact: true }).click()
    await page.getByText(/changeover/).first().waitFor({ timeout: 5000 })
    const wd = (d) => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(d + 'T00:00:00Z').getUTCDay()]
    // The page opens on this week; on a Monday the window opened last week.
    const monday = plus(-((new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7))
    const startOn = plus(-1) < monday
    if (startOn) await page.getByRole('button', { name: 'Earlier weeks' }).click()
    let up = await page.locator('body').innerText()
    check('Upcoming: Hamlet shows the stay dates', up.indexOf('Hamlet') !== -1 && up.indexOf(dshort(plus(-3)) + ' – ' + dshort(plus(-1))) !== -1, up.slice(0, 600))
    check('Upcoming: who', /Red Guest/.test(up))
    check('Upcoming: no cleaning window or next guest shown', !/ 12 pm – /.test(up) && !/→/.test(up) && !/no one booked/.test(up))
    check('Upcoming: four weeks', (up.match(/This week|Week of/g) || []).length === 4)
    if (startOn) await page.getByRole('button', { name: 'Back to this week' }).click()
    up = await page.locator('body').innerText()
    check('Upcoming: this week first', /This week/.test(up))
    await page.getByRole('button', { name: 'Later weeks' }).click()
    up = await page.locator('body').innerText()
    check('Upcoming: pages on', !/This week/.test(up) && /Back to this week/.test(up))
    await page.getByRole('button', { name: 'Back to this week' }).click()

    // Bookings: one page, lettings and the Grain Store together.
    await page.getByRole('tab', { name: 'Bookings', exact: true }).click()
    await page.getByText('Later Guest').waitFor({ timeout: 5000 })
    let list = await page.locator('body').innerText()
    check('lettings listed', /Yellow Guest/.test(list) && /Later Guest/.test(list))
    check('diary event listed', /Smith Wedding/.test(list))
    check('box office event listed', /Supper Club/.test(list) && /Box office/.test(list))
    check('provisional event listed', /Maybe Party/.test(list) && /Provisional/.test(list))
    check('blocked dates not listed', !/Not available/.test(list))
    check('no prices', !/999/.test(list) && !/£/.test(list))
    check('no status filter', (await page.locator('select').count()) === 0)
    check('short dates', /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2} \d{2}\b/.test(list))
    // A card is the box with the guest's name in it and a bottom line.
    const card = (name) => page.locator('div[style*="box-shadow"]', { has: page.getByText(name, { exact: true }) })
    check('Airbnb source then Confirmed', /Airbnb\s*Confirmed/.test(await card('Yellow Guest').innerText()), await card('Yellow Guest').innerText())
    check('property lozenge on the card', /Amly/.test(await card('Yellow Guest').innerText()))
    check('future lozenge is grey Not yet', await card('Later Guest').getByRole('button', { name: 'Not yet' }).isDisabled())
    check('box office card has a lozenge', (await card('Supper Club').getByRole('button', { name: 'Not yet' }).count()) === 1)
    check('provisional has no lozenge', (await card('Maybe Party').getByRole('button').count()) === 0)

    // Filter by property.
    await page.getByRole('button', { name: 'Grain St.', exact: true }).click()
    list = await page.locator('body').innerText()
    check('Grain St. filter: events only', /Smith Wedding/.test(list) && /Supper Club/.test(list) && !/Later Guest/.test(list) && !/Yellow Guest/.test(list))
    await page.getByRole('button', { name: 'Hamlet', exact: true }).click()
    list = await page.locator('body').innerText()
    check('Hamlet filter', /Later Guest/.test(list) && !/Yellow Guest/.test(list) && !/Smith Wedding/.test(list))
    await page.getByRole('button', { name: /Show past/ }).click()
    list = await page.locator('body').innerText()
    check('past Hamlet shows the lost property', /Red Guest/.test(list) && /Lost property: umbrella/.test(list))
    await page.getByRole('button', { name: 'All', exact: true }).click()
    list = await page.locator('body').innerText()
    check('All filter', /Yellow Guest/.test(list) && /Smith Wedding/.test(list))
    check('past Glamping shows its lost property', /Lost property: black hat/.test(list))

    // House: Karina's timesheet for The House.
    await page.getByRole('tab', { name: 'House', exact: true }).click()
    await page.getByText("Karina's hours, Monday to Friday", { exact: false }).waitFor({ timeout: 5000 })
    const mon = mondayOfT(today)
    const houseRow = (m) => page.locator('div[style*="nowrap"]', { has: page.getByText(isoCode(m), { exact: true }) }).first()
    let houseText = await page.locator('body').innerText()
    check('House: five weeks listed with codes', [-14, -7, 0, 7, 14].every((n) => houseText.indexOf(isoCode(new Date(Date.parse(mon + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10))) !== -1), houseText.slice(0, 400))
    check('House: a week code for this week', houseText.indexOf(isoCode(mon)) !== -1, isoCode(mon))
    check('House: backlog from 2641 (Mon 5 Oct 26) is open', /2641\s*Mon 5 Oct 26/.test(houseText) && !/\b2640\b/.test(houseText), houseText.slice(0, 500))
    check('House: backlog week is red', /To submit/.test(await houseRow('2026-10-05').innerText()))
    const wk = (n) => new Date(Date.parse(mon + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)
    check('House: last week red until submitted', /To submit/.test(await houseRow(wk(-7)).innerText()))
    const thisState = await houseRow(mon).innerText()
    const weekday = new Date(today + 'T00:00:00Z').getUTCDay()
    check('House: this week yellow up to Friday, red after', (weekday >= 1 && weekday <= 5) ? /This week/.test(thisState) : /To submit/.test(thisState), thisState)
    check('House: next week grey', /Not yet/.test(await houseRow(wk(7)).innerText()))
    await houseRow(wk(7)).click()
    check('House: a future week does not open', (await page.getByText('Karina hours', { exact: true }).count()) === 0)
    // Fill last week, save without submitting, then submit.
    await houseRow(wk(-7)).click()
    await page.getByText('Karina hours', { exact: true }).waitFor({ timeout: 5000 })
    check('House: Monday to Friday only', (await page.locator('input[type=number]').count()) === 5 && !/Saturday|Sunday/.test(await page.locator('body').innerText()))
    await page.getByLabel('Monday hours').fill('2')
    await page.getByLabel('Tuesday hours').fill('3.5')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByText('Karina hours', { exact: true }).waitFor({ state: 'detached', timeout: 5000 })
    const hs = () => s.calls.filter((c) => c.fn === 'write:app_data').map((c) => JSON.parse(c.args)).filter((x) => x.key === 'hbf_house_hours_v1').pop()
    let sh = hs() && hs().value.find((x) => x.id === 'karina:' + wk(-7))
    check('House: saved, not submitted', sh && sh.days.mon === 2 && sh.days.tue === 3.5 && sh.submitted === false && sh.week === wk(-7), JSON.stringify(sh))
    check('House: still red with hours in', /To submit/.test(await houseRow(wk(-7)).innerText()))
    await houseRow(wk(-7)).click()
    await page.getByText('Karina hours', { exact: true }).waitFor({ timeout: 5000 })
    check('House: reopens with the hours', (await page.getByLabel('Tuesday hours').inputValue()) === '3.5')
    await page.getByText('Submit — this week is complete').click()
    await page.getByRole('button', { name: 'Save and submit' }).click()
    await page.getByText('Karina hours', { exact: true }).waitFor({ state: 'detached', timeout: 5000 })
    sh = hs() && hs().value.find((x) => x.id === 'karina:' + wk(-7))
    check('House: submitted', sh && sh.submitted === true && !!sh.submittedAt)
    check('House: green with the hours', /5\.5 h/.test(await houseRow(wk(-7)).innerText()), await houseRow(wk(-7)).innerText())
    check('House: one record per week', hs().value.filter((x) => x.week === wk(-7)).length === 1)

    // App button by Sign out.
    await page.getByRole('button', { name: 'App', exact: true }).click()
    check('App pop-up explains', await page.getByText('Put the app on your phone').isVisible())
    await page.getByRole('button', { name: 'Close' }).click()
    check('App pop-up closes', (await page.getByText('Put the app on your phone').count()) === 0)
    check('no page errors (cleaner)', s.errors.length === 0, s.errors.join(' | '))
  } catch (e) { fails.push('cleaner run: ' + e.message) }
  await s.close()

  // ── On a phone ───────────────────────────────────────────────────────────
  s = await open({ rpc: cleanerRpc, viewport: { width: 390, height: 844 } })
  page = s.page
  try {
    await page.getByText('Still to sign off').waitFor({ timeout: 15000 })
    await page.getByText('Quiz Night').first().waitFor({ timeout: 5000 })
    const noScroll = async () => (await page.evaluate(() => document.documentElement.scrollWidth)) <= 392
    check('Live: no sideways scroll', await noScroll())
    const strip = await page.locator('span[title]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))
    check('status strip is one line', new Set(strip).size === 1, JSON.stringify(strip))
    await page.screenshot({ path: path.join(os.tmpdir(), 'changeover-phone.png') })

    await page.getByRole('tab', { name: 'Bookings', exact: true }).click()
    await page.getByText('Later Guest').waitFor({ timeout: 5000 })
    check('Bookings: no sideways scroll', await noScroll())
    // Each card's bottom line: source, status and lozenge level with each other.
    const lines = await page.locator('div[style*="nowrap"]:has(> button)').evaluateAll((els) => els.map((el) => {
      const kids = Array.from(el.children).filter((k) => k.getBoundingClientRect().width > 0)
      const mids = kids.map((k) => { const r = k.getBoundingClientRect(); return Math.round(r.top + r.height / 2) })
      const b = el.querySelector('button').getBoundingClientRect()
      return { spread: Math.max.apply(null, mids) - Math.min.apply(null, mids), right: Math.round(b.right) }
    }))
    // Four upcoming cards carry a lozenge; the provisional one has none.
    check('Bookings: lozenge rows found', lines.length === 4, String(lines.length))
    check('Bookings: lozenge on the same line', lines.every((x) => x.spread <= 6 && x.right <= 390), JSON.stringify(lines))
    await page.screenshot({ path: path.join(os.tmpdir(), 'changeover-phone-bookings.png') })

    await page.getByRole('tab', { name: 'House', exact: true }).click()
    await page.getByText("Karina's hours, Monday to Friday", { exact: false }).waitFor({ timeout: 5000 })
    check('House: no sideways scroll', await noScroll())
    await page.screenshot({ path: path.join(os.tmpdir(), 'changeover-phone-house.png') })
    await page.locator('div[style*="nowrap"]', { has: page.getByText(isoCode(mondayOfT(today)), { exact: true }) }).first().click()
    await page.getByText('Karina hours', { exact: true }).waitFor({ timeout: 5000 })
    check('House dialog: no sideways scroll', await noScroll())
    await page.screenshot({ path: path.join(os.tmpdir(), 'changeover-phone-house-week.png') })
    await page.getByRole('button', { name: 'Cancel' }).click()
    const head = await page.locator('header').evaluate((h) => ({ sw: h.scrollWidth, cw: h.clientWidth, h: h.getBoundingClientRect().height }))
    check('header fits with App and Sign out', head.sw <= head.cw + 1 && head.h < 90, JSON.stringify(head))
    await page.getByRole('button', { name: 'App', exact: true }).click()
    await page.screenshot({ path: path.join(os.tmpdir(), 'changeover-phone-app.png') })
  } catch (e) { fails.push('phone run: ' + e.message) }
  await s.close()

  // ── Admin ───────────────────────────────────────────────────────────────
  s = await open({})
  page = s.page
  try {
    await page.getByText(/Grain St\. ×2/).waitFor({ timeout: 15000 })
    const home = await page.locator('body').innerText()
    const bar = page.getByRole('group', { name: 'Property status' })
    const hpill = async (n) => bar.locator('span[title]', { hasText: n }).first().getAttribute('title')
    const pills = (await bar.locator('span[title]').allInnerTexts()).join('|')
    check('home: one line of short names', pills === 'Hamlet|Amly|Glamping|Grain St. ×2', pills)
    check('home: Hamlet to clean', (await hpill('Hamlet')) === 'To clean')
    check('home: Amly guests', (await hpill('Amly')) === 'Guests')
    check('home: Glamping ready', (await hpill('Glamping')) === 'Ready')
    check('home: Grain St. counts the box office event', (await hpill('Grain St.')) === 'To clean')
    check('home: no names, comments or lost property', !/Tent 4 zip sticking/.test(home) && !/Lost property/.test(home))
    const tops = await bar.locator('span[title]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))
    check('home: all four on one line', new Set(tops).size === 1, JSON.stringify(tops))
    await page.screenshot({ path: path.join(os.tmpdir(), 'changeover-home.png') })

    // The Glamping tile opens Hat Guest's booking, which shows the sign-off.
    await bar.locator('span[title]', { hasText: 'Glamping' }).first().click()
    await page.getByText(/ready .* · Edita 2h/).waitFor({ timeout: 10000 })
    const form = await page.locator('body').innerText()
    check('booking shows lost property', /Lost property: black hat/.test(form))
    check('booking shows hours', /Edita 2h · Karina 1h/.test(form))

    // Reports → Housekeeping Hours, listed before Hours Worked.
    await page.getByText('Reports', { exact: true }).first().click()
    await page.getByText('Housekeeping Hours', { exact: true }).first().click()
    await page.getByText(/What each cleaner is owed/).waitFor({ timeout: 10000 })
    const nav = await page.locator('body').innerText()
    check('Reports: Housekeeping Hours sits above Hours Worked', nav.indexOf('Housekeeping Hours') < nav.lastIndexOf('Hours Worked'))
    check('no page errors (admin)', s.errors.length === 0, s.errors.join(' | '))
  } catch (e) { fails.push('admin run: ' + e.message) }
  await s.close()

  // ── Upcoming: a Sunday window is next week's clean ──────────────────────
  // unless the next guests arrive that same Sunday.
  try {
    const dow = new Date(today + 'T00:00:00Z').getUTCDay()
    const sun = plus(dow === 0 ? 7 : 7 - dow)          // the coming Sunday (never today)
    const add = (n) => new Date(Date.parse(sun + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)
    const appData = freshApp()
    appData.hbf_accom_v1 = [
      { id: 'S1', guestName: 'Sunday Leaver', status: 'confirmed', source: 'direct', stays: [stay('hamlet', add(-2), sun)], schedule: [] },
      { id: 'S2', guestName: 'Friday Arriver', status: 'confirmed', source: 'direct', stays: [stay('hamlet', add(5), add(7))], schedule: [] },
      { id: 'S3', guestName: 'Amly Leaver', status: 'confirmed', source: 'direct', stays: [stay('amly', add(-2), sun)], schedule: [] },
      { id: 'S4', guestName: 'Sunday Arriver', status: 'confirmed', source: 'direct', stays: [stay('amly', sun, add(3))], schedule: [] },
    ]
    appData.hawthbush_bookings_v6 = []
    const c = await openStaff({ distDir: DIST, appData: appData, rpc: cleanerRpc })
    try {
      await c.page.route('**/.netlify/functions/box-admin', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"events":[]}' }))
      await c.page.reload()
      await c.page.getByRole('tab', { name: 'Upcoming', exact: true }).click()
      await c.page.getByText(/This week/).waitFor({ timeout: 15000 })
      const weekText = async (label) => c.page.locator('div[style*="border-radius: 10px"]', { has: c.page.getByText(label, { exact: true }) }).first().innerText()
      const thisWeek = await weekText('This week')
      const nextLabel = 'Week of ' + ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(add(1) + 'T00:00:00Z').getUTCDay()] + ' ' +
        Number(add(1).slice(8)) + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(add(1).slice(5, 7)) - 1] + ' ' + add(1).slice(2, 4)
      const nextWeek = await weekText(nextLabel)
      check('Sunday clean with no one arriving rolls to next week', /Sunday Leaver/.test(nextWeek) && !/Sunday Leaver/.test(thisWeek), thisWeek + ' || ' + nextWeek)
      check('Sunday clean with Sunday arrivals stays this week', /Amly Leaver/.test(thisWeek) && !/Amly Leaver/.test(nextWeek), thisWeek + ' || ' + nextWeek)
      check('rolled row shows the stay dates', nextWeek.indexOf(dshort(add(-2)) + ' – ' + dshort(sun)) !== -1, nextWeek)
    } finally { await c.close() }
  } catch (e) { fails.push('sunday run: ' + e.message) }

  // ── Setup cleans ─────────────────────────────────────────────────────────
  // Window opens when the place was last left (within the week before), or a
  // week before; closes at check-in − 2h / the event's start.
  try {
    const wd = (d) => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(d + 'T00:00:00Z').getUTCDay()]
    const setupApp = () => {
      const a = freshApp()
      a.hbf_accom_v1 = [
        { id: 'P1', guestName: 'First Family', status: 'confirmed', source: 'direct', stays: [stay('hamlet', plus(-1), plus(2))], schedule: [] },
        { id: 'P2', guestName: 'Second Family', status: 'confirmed', source: 'direct', stays: [stay('hamlet', plus(6), plus(8))], schedule: [] },
        { id: 'P3', guestName: 'Amly Arrivals', status: 'confirmed', source: 'direct', stays: [stay('amly', plus(10), plus(12))], schedule: [] },
      ]
      a.hawthbush_bookings_v6 = [{ id: 901, couple: 'Party Prep', date: plus(5), status: 'Confirmed', eventType: 'Party' }]
      a.hbf_changeovers_v1 = []
      a.hbf_setup_cleans_v1 = [
        { id: 'setup:accom:P2', kind: 'accom', refId: 'P2' }, { id: 'setup:accom:P3', kind: 'accom', refId: 'P3' },
        { id: 'setup:event:901', kind: 'event', refId: 901 }, { id: 'setup:box:bx-late', kind: 'box', refId: 'bx-late' },
      ]
      return a
    }
    const SBOX = [{ id: 'bx-late', name: 'Late Supper', starts_at: plus(12) + 'T18:30:00Z', ends_at: plus(12) + 'T22:00:00Z' }]
    const openWith = async (appData, rpc) => {
      const c = await openStaff({ distDir: DIST, appData: appData, rpc: rpc })
      await c.page.route(HOST + '/rest/v1/app_data', async (route) => {
        const req = route.request()
        if (req.method() !== 'POST') return route.fallback()
        const body = JSON.parse(req.postData() || '{}'); appData[body.key] = body.value
        c.calls.push({ fn: 'write:app_data', args: req.postData() })
        return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' })
      })
      await c.page.route('**/.netlify/functions/box-admin', (r) => {
        const body = JSON.parse(r.request().postData() || '{}')
        if (body.action === 'housekeeping.events') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ events: SBOX }) })
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ orders: [], events: [] }) })
      })
      await c.page.reload()
      return c
    }

    // Housekeeping.
    const hk = setupApp()
    let c = await openWith(hk, cleanerRpc)
    try {
      await c.page.getByText('Still to sign off').waitFor({ timeout: 15000 })
      const pg = c.page
      const pillT = async (n) => pg.locator('span[title]', { hasText: n }).first().getAttribute('title')
      check('setup: Grain St. red while its setup clean is due', (await pillT('Grain St.')) === 'To clean', await pillT('Grain St.'))
      check('setup: Hamlet still shows its guests', (await pillT('Hamlet')) === 'Guests', await pillT('Hamlet'))
      const od = await pg.getByText('Still to sign off').locator('..').innerText()
      check('setup: due setup in Still to sign off', /Setup · Party Prep · by /.test(od), od)

      await pg.getByRole('tab', { name: 'Upcoming', exact: true }).click()
      await pg.getByText(/This week/).waitFor({ timeout: 5000 })
      // Back a page if the event's window opened last week.
      let up = await pg.locator('body').innerText()
      for (let i = 0; i < 3 && !/before Party Prep/.test(up); i++) { await pg.getByRole('button', { name: 'Earlier weeks' }).click(); up += await pg.locator('body').innerText() }
      await pg.getByRole('button', { name: 'Back to this week' }).click().catch(() => {})
      up += await pg.locator('body').innerText()
      check('setup: Hamlet setup shows the stay it is for', up.indexOf(dshort(plus(6)) + ' – ' + dshort(plus(8))) !== -1 && /Setup clean before Second Family/.test(up), up.slice(0, 900))
      check('setup: diary event setup listed', /Setup clean before Party Prep/.test(up))
      await pg.getByRole('button', { name: 'Later weeks' }).click()
      up = await pg.locator('body').innerText()
      await pg.getByRole('button', { name: 'Back to this week' }).click()
      up += await pg.locator('body').innerText()
      check('setup: Amly setup listed', up.indexOf('Setup clean before Amly Arrivals') !== -1)
      check('setup: box office setup shows the event date and time', /Setup clean before Late Supper/.test(up) && up.indexOf(dshort(plus(12)) + ' · ' + new Date(plus(12) + 'T18:30:00Z').toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' })) !== -1, up.slice(0, 1500))

      await pg.getByRole('tab', { name: 'Bookings', exact: true }).click()
      await pg.getByText('Second Family').first().waitFor({ timeout: 5000 })
      const bk = await pg.locator('body').innerText()
      check('setup: four setup cards on Bookings', (bk.match(/Setup clean/g) || []).length === 4, String((bk.match(/Setup clean/g) || []).length))

      // Sign off the event's setup clean.
      await pg.getByRole('tab', { name: 'Live', exact: true }).click()
      const row = pg.getByText('Still to sign off').locator('..').locator('div[style*="nowrap"]', { hasText: 'Party Prep' }).filter({ has: pg.locator('button') }).last()
      await row.getByRole('button', { name: 'To clean' }).click()
      await pg.getByText('Edita hours').waitFor({ timeout: 5000 })
      check('setup: dialog says when it is needed by', /ready by/.test(await pg.locator('body').innerText()))
      await pg.locator('input[type=number]').nth(0).fill('1.5')
      await pg.getByRole('button', { name: 'Done — ready' }).click()
      await pg.getByText('Edita hours').waitFor({ state: 'detached', timeout: 5000 })
      const r = (hk.hbf_changeovers_v1 || []).find((x) => x.id === 'setup:event:901:grainstore')
      check('setup: sign-off saved under its own id', r && r.kind === 'setup' && r.setupOf === 'event' && r.hours.edita === 1.5, JSON.stringify(hk.hbf_changeovers_v1))
      check('setup: Grain St. ready after the sign-off', (await pillT('Grain St.')) === 'Ready', await pillT('Grain St.'))
      check('setup: no page errors (housekeeping)', c.errors.length === 0, c.errors.join(' | '))
    } finally { await c.close() }

    // Admin: the tick box on the event, and on a letting.
    const ad = setupApp()
    c = await openWith(ad, undefined)
    try {
      const pg = c.page
      await pg.getByRole('group', { name: 'Property status' }).locator('span[title="To clean"]', { hasText: 'Grain St.' }).waitFor({ timeout: 15000 })
      await pg.getByRole('group', { name: 'Property status' }).locator('span[title="To clean"]', { hasText: 'Grain St.' }).click()
      await pg.getByText('Setup clean', { exact: true }).waitFor({ timeout: 10000 })
      const box = pg.locator('label', { has: pg.getByText('Setup clean', { exact: true }) }).locator('input[type=checkbox]')
      check('setup: event form shows it ticked', await box.isChecked())
      await box.click()
      await pg.waitForTimeout(800)
      check('setup: unticking removes only that request', Array.isArray(ad.hbf_setup_cleans_v1) && ad.hbf_setup_cleans_v1.length === 3 &&
        !ad.hbf_setup_cleans_v1.some((x) => x.id === 'setup:event:901'), JSON.stringify(ad.hbf_setup_cleans_v1))
      check('setup: box unticked', !(await box.isChecked()))
      // A letting: the Hamlet tile (guests in) opens First Family.
      await pg.goto(c.origin + '/')
      await pg.getByRole('group', { name: 'Property status' }).locator('span[title]', { hasText: 'Hamlet' }).first().click()
      await pg.getByText('Setup clean', { exact: true }).waitFor({ timeout: 10000 })
      const lbox = pg.locator('label', { has: pg.getByText('Setup clean', { exact: true }) }).locator('input[type=checkbox]')
      check('setup: letting without one is unticked', !(await lbox.isChecked()))
      await lbox.click()
      await pg.waitForTimeout(800)
      check('setup: ticking a letting adds it', ad.hbf_setup_cleans_v1.some((x) => x.id === 'setup:accom:P1' && x.kind === 'accom' && x.refId === 'P1'), JSON.stringify(ad.hbf_setup_cleans_v1))
      check('setup: no page errors (admin)', c.errors.length === 0, c.errors.join(' | '))
    } finally { await c.close() }
  } catch (e) { fails.push('setup run: ' + e.message) }

  // ── Pay: rates by date, the week's sums, Paid ───────────────────────────
  // Last week: Karina at The House Mon 2h (£18) and Tue 3h (£20 — her rise
  // starts on the Tuesday); a changeover on the Wednesday, Edita 4h (£15) and
  // Karina 1h (£20). Edita £60, Karina £36 + £60 + £20 = £116, total £176.
  try {
    const mon = mondayOfT(today)
    const lw = (n) => new Date(Date.parse(mon + 'T00:00:00Z') + (n - 7) * 86400000).toISOString().slice(0, 10)
    const appData = freshApp()
    appData.hawthbush_staff_v5 = [
      { id: 'TM', name: 'Taryn May', role: 'Bar Supervisor', active: true, rate: '£15 incl Roll Up', email: '', phone: '', notes: '' },
      { id: 'ED', name: 'Edita', role: 'Housekeeping', active: true, employment: 'Self-employed', rate: '', email: '', phone: '', notes: '',
        rates: [{ from: '2026-01-01', rate: 15, holidayRollup: false }] },
      { id: 'KA', name: 'Karina', role: 'Housekeeping', active: true, employment: 'Self-employed', rate: '', email: '', phone: '', notes: '',
        rates: [{ from: '2026-01-01', rate: 18, holidayRollup: false }, { from: lw(1), rate: 20, holidayRollup: true }] },
    ]
    appData.hbf_changeovers_v1 = [{ id: 'accom:PAY:hamlet', kind: 'accom', refId: 'PAY', unitId: 'hamlet', unitName: 'The Hamlet', who: 'Pay Guest',
      doneAt: lw(2) + 'T14:00', hours: { edita: 4, karina: 1 }, comments: '', lostProperty: '' }]
    appData.hbf_house_hours_v1 = [{ id: 'karina:' + lw(0), who: 'karina', week: lw(0), days: { mon: 2, tue: 3, wed: 0, thu: 0, fri: 0 }, submitted: true, submittedAt: lw(5) + 'T17:00:00Z' }]
    const c = await openStaff({ distDir: DIST, appData: appData })
    try {
      await c.page.route(HOST + '/rest/v1/app_data', async (route) => {
        const req = route.request()
        if (req.method() !== 'POST') return route.fallback()
        const b = JSON.parse(req.postData() || '{}'); appData[b.key] = b.value
        return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' })
      })
      await c.page.route('**/.netlify/functions/box-admin', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"events":[],"orders":[]}' }))
      await c.page.reload()
      const pg = c.page
      await pg.getByText('Reports', { exact: true }).first().waitFor({ timeout: 15000 })
      await pg.getByText('Reports', { exact: true }).first().click()
      await pg.getByText('Housekeeping Hours', { exact: true }).first().click()
      await pg.getByText(/What each cleaner is owed/).waitFor({ timeout: 10000 })
      const row = pg.locator('div[style*="border-bottom: 1px"]', { hasText: isoCode(lw(0)) + ' · ' + dshort(lw(0)) }).last()
      const rt = await row.innerText()
      check('pay: week code and Monday', rt.indexOf(isoCode(lw(0))) !== -1 && rt.indexOf(dshort(lw(0))) !== -1, rt)
      check('pay: Edita £60.00 (4h at £15)', /£60\.00/.test(rt) && /4 h/.test(rt), rt)
      check('pay: Karina £116.00 (6h: House at £18 then £20, changeover at £20)', /£116\.00/.test(rt) && /6 h/.test(rt), rt)
      check('pay: total £176.00', /£176\.00/.test(rt), rt)
      await row.getByText('details').click()
      const det = await row.innerText()
      check('pay: breakdown shows the rise', /£18\.00\/h/.test(det) && /£20\.00\/h/.test(det) && /The House/.test(det) && /The Hamlet · Pay Guest/.test(det), det)
      await row.getByLabel('Week ' + isoCode(lw(0)) + ' paid').check()
      await pg.waitForTimeout(600)
      const pr = (appData.hbf_housekeeping_pay_v1 || []).find((x) => x.id === lw(0))
      check('pay: Paid saved with the amounts', pr && pr.paid && pr.code === isoCode(lw(0)) && pr.amounts.total === 176 && pr.amounts.karina === 116 && pr.paidOn === today, JSON.stringify(pr))
      await row.getByLabel('Week ' + isoCode(lw(0)) + ' paid on').fill(lw(6))
      await pg.waitForTimeout(600)
      const pr2 = (appData.hbf_housekeeping_pay_v1 || []).find((x) => x.id === lw(0))
      check('pay: paid date can be set', pr2 && pr2.paidOn === lw(6), JSON.stringify(pr2))
      check('pay: still one record for the week', appData.hbf_housekeeping_pay_v1.filter((x) => x.id === lw(0)).length === 1)

      // Staff: rates on the card, employment, kept off rotas.
      await pg.getByText('Settings', { exact: true }).first().click().catch(() => {})
      await pg.getByText('Staff', { exact: true }).first().click()
      await pg.getByText('Staff Database').waitFor({ timeout: 10000 })
      const staffText = await pg.locator('body').innerText()
      check('staff: Karina card shows her current rate', /£20\.00\/hr incl\. holiday from/.test(staffText), staffText.slice(0, 1200))
      check('staff: Self-employed and PAYE shown', /Self-employed/.test(staffText) && /PAYE/.test(staffText))
      const card = pg.locator('div[style*="box-shadow"]', { has: pg.getByText('Karina', { exact: true }) }).first()
      await card.getByRole('button', { name: 'Edit' }).click()
      await pg.getByText('Pay rates by date').waitFor({ timeout: 5000 })
      check('staff: form shows both rates', (await pg.getByLabel('Pounds an hour').count()) === 2)
      check('staff: employment select', (await pg.locator('select').filter({ hasText: 'Self-employed' }).first().inputValue()) === 'Self-employed')
      await pg.getByRole('button', { name: '+ Add a rate' }).click()
      await pg.getByLabel('Rate starts').nth(2).fill('2027-04-01')
      await pg.getByLabel('Pounds an hour').nth(2).fill('21.5')
      await pg.getByRole('button', { name: 'Save Changes' }).click()
      await pg.waitForTimeout(800)
      const ka = (appData.hawthbush_staff_v5 || []).find((x) => x.id === 'KA')
      check('staff: new rate saved as a number with its date', ka && ka.rates.length === 3 && ka.rates[2].from === '2027-04-01' && ka.rates[2].rate === 21.5, JSON.stringify(ka && ka.rates))
      check('staff: other staff untouched', (appData.hawthbush_staff_v5 || []).some((x) => x.id === 'TM' && x.rate === '£15 incl Roll Up'))
      check('pay: no page errors', c.errors.length === 0, c.errors.join(' | '))
    } finally { await c.close() }
  } catch (e) { fails.push('pay run: ' + e.message) }

  // ── Admin lettings calendar: box office events as red E's ────────────────
  // The year view names nothing until hovered, so count the markers with and
  // without box office events.
  const countEs = async (box) => {
    const c = await open({ box: box })
    try {
      await c.page.locator('span[title]', { hasText: 'Hamlet' }).first().waitFor({ timeout: 15000 })
      await c.page.getByText('Lettings', { exact: true }).first().click()
      await c.page.waitForTimeout(1500)
      const n = await c.page.locator('span', { hasText: /^E$/ }).count()
      const asked = c.calls.some((x) => x.fn === 'box:housekeeping.events')
      return { n, asked }
    } finally { await c.close() }
  }
  try {
    const withBox = await countEs(BOX), without = await countEs([])
    // One E per day: a box office event on a day that already has an event adds none.
    const diaryDays = new Set(EVENTS.map((e) => e.date))
    const sameYear = new Set(BOX.map((b) => b.starts_at.slice(0, 10))
      .filter((d) => d.slice(0, 4) === today.slice(0, 4) && !diaryDays.has(d))).size
    check('lettings calendar asks the box office', withBox.asked)
    check('lettings calendar marks box office events', withBox.n - without.n === sameYear, withBox.n + ' vs ' + without.n)
  } catch (e) { fails.push('calendar run: ' + e.message) }

  console.log(passes + ' passed, ' + fails.length + ' failed')
  fails.forEach((f) => console.log('  FAIL ' + f))
  process.exit(fails.length ? 1 : 0)
})()
