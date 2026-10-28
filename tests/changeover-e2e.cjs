// tests/changeover-e2e.cjs
//
// The housekeeping sign-off, end to end. Built app, Supabase faked
// (tests/portal-harness.cjs → openStaff), box-admin faked here:
//   · the cleaner login has Live / Calendar / Bookings / Hours / App;
//   · Live's status line: one line of short names (Hamlet, Amly, Glamping,
//     Grain St.), red waiting, yellow in use, green ready — box office events
//     count for the Grain Store;
//   · the lozenge says the status; tapping it opens the sign-off (hours per
//     cleaner, editable time, comments, lost property) which saves one record
//     to hbf_changeovers_v1; a green one reopens with what was saved;
//   · Bookings: lettings and Grain Store events (diary and box office) on one
//     page, filtered by property buttons, no prices, the lozenge on the same
//     line on a phone;
//   · Hours totals a month per cleaner and scrolls month to month;
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
    check('tab order', tabNames.join('|') === 'Live|Calendar|Bookings|Hours|App', tabNames.join('|'))
    check('no "next 14 days" heading', !/The next 14 days/.test(await page.locator('body').innerText()))

    // Status line.
    const pill = async (name) => page.locator('span[title]', { hasText: name }).first().getAttribute('title')
    const pillText = (await page.locator('span[title]').allInnerTexts()).join('|')
    check('short names on the strip', pillText === 'Hamlet|Amly|Glamping|Grain St. ×2', pillText)
    check('Hamlet waiting', (await pill('Hamlet')) === 'Needs cleaning', await pill('Hamlet'))
    check('Amly in use', (await pill('Amly')) === 'In use', await pill('Amly'))
    check('Glamping ready', (await pill('Glamping')) === 'Ready', await pill('Glamping'))
    check('Grain St. waiting', (await pill('Grain St.')) === 'Needs cleaning', await pill('Grain St.'))

    const overdue = await page.getByText('Still to sign off').locator('..').innerText()
    check('overdue has Red Guest', /Red Guest/.test(overdue), overdue)
    check('overdue has Messy Do', /Messy Do/.test(overdue), overdue)
    check('overdue has the box office event', /Quiz Night · Box office/.test(overdue), overdue)
    check('untracked old stay not overdue', !/Ancient Guest/.test(overdue))
    check('lozenge says the status', /Needs cleaning/.test(overdue) && !/\bDone\b/.test(overdue), overdue)

    // Sign off the Hamlet.
    const row = page.getByText('Still to sign off').locator('..').locator('div[style*="nowrap"]', { hasText: 'Red Guest' }).filter({ has: page.locator('button') }).last()
    await row.getByRole('button', { name: 'Needs cleaning' }).click()
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

    // Hours: the month of the Hamlet sign-off.
    await page.getByRole('tab', { name: 'Hours', exact: true }).click()
    await page.getByText('Changeovers', { exact: true }).waitFor({ timeout: 5000 })
    const target = monthOf(plus(-1))
    if (target !== monthOf(today)) await page.getByRole('button', { name: 'Previous month' }).click()
    const inMonth = (w2 ? w2.value : []).filter((r) => monthOf(r.doneAt) === target)
    const sum = (k) => Math.round(inMonth.reduce((a, r) => a + (Number(r.hours[k]) || 0), 0) * 100) / 100
    const hrs = await page.locator('body').innerText()
    check('Hours: Edita total', hrs.indexOf('Edita\n' + sum('edita')) !== -1, 'want ' + sum('edita') + ' · ' + hrs.slice(hrs.indexOf('Edita'), hrs.indexOf('Edita') + 40))
    check('Hours: Karina total', hrs.indexOf('Karina\n' + sum('karina')) !== -1, 'want ' + sum('karina'))
    check('Hours: changeover count', new RegExp('Changeovers\\n' + inMonth.length + '\\b').test(hrs), String(inMonth.length))
    await page.getByRole('button', { name: 'Previous month' }).click()
    await page.getByRole('button', { name: 'Next month' }).click()
    check('Hours: scrolls back and forth', (await page.locator('body').innerText()).indexOf('Edita\n' + sum('edita')) !== -1)

    // App tab.
    await page.getByRole('tab', { name: 'App', exact: true }).click()
    check('App tab explains', await page.getByText('Put the app on your phone').isVisible())
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

    await page.getByRole('tab', { name: 'Hours', exact: true }).click()
    await page.getByText('Changeovers', { exact: true }).waitFor({ timeout: 5000 })
    if (monthOf(plus(-2)) !== monthOf(today)) await page.getByRole('button', { name: 'Previous month' }).click()
    check('Hours: no sideways scroll', await noScroll())
    await page.screenshot({ path: path.join(os.tmpdir(), 'changeover-phone-hours.png') })
    await page.getByRole('tab', { name: 'App', exact: true }).click()
    await page.screenshot({ path: path.join(os.tmpdir(), 'changeover-phone-app.png') })
  } catch (e) { fails.push('phone run: ' + e.message) }
  await s.close()

  // ── Admin ───────────────────────────────────────────────────────────────
  s = await open({})
  page = s.page
  try {
    await page.getByText('Lost property:').first().waitFor({ timeout: 15000 })
    await page.getByText(/Needs cleaning ×2/).waitFor({ timeout: 5000 })
    const home = await page.locator('body').innerText()
    check('home: Glamping lost property', /Lost property: black hat/.test(home))
    check('home: Glamping comment', /Tent 4 zip sticking/.test(home))
    check('home: Hamlet needs cleaning', /The Hamlet[\s\S]{0,40}Needs cleaning/.test(home))
    check('home: Amly in use', /Amly Barn[\s\S]{0,20}In use/.test(home))
    check('home: Grain Store counts the box office event', /Grain Store[\s\S]{0,40}Needs cleaning ×2/.test(home))
    await page.screenshot({ path: path.join(os.tmpdir(), 'changeover-home.png') })

    // The Glamping tile opens Hat Guest's booking, which shows the sign-off.
    await page.locator('div[title="Open the booking"]', { hasText: 'Glamping' }).click()
    await page.getByText(/ready .* · Edita 2h/).waitFor({ timeout: 10000 })
    const form = await page.locator('body').innerText()
    check('booking shows lost property', /Lost property: black hat/.test(form))
    check('booking shows hours', /Edita 2h · Karina 1h/.test(form))

    // Reports → Housekeeping Hours, listed before Hours Worked.
    await page.getByText('Reports', { exact: true }).first().click()
    await page.getByText('Housekeeping Hours', { exact: true }).first().click()
    await page.getByText('Changeovers', { exact: true }).waitFor({ timeout: 10000 })
    const nav = await page.locator('body').innerText()
    check('Reports: Housekeeping Hours sits above Hours Worked', nav.indexOf('Housekeeping Hours') < nav.lastIndexOf('Hours Worked'))
    check('no page errors (admin)', s.errors.length === 0, s.errors.join(' | '))
  } catch (e) { fails.push('admin run: ' + e.message) }
  await s.close()

  // ── Admin lettings calendar: box office events as red E's ────────────────
  // The year view names nothing until hovered, so count the markers with and
  // without box office events.
  const countEs = async (box) => {
    const c = await open({ box: box })
    try {
      await c.page.getByText('Lost property:').first().waitFor({ timeout: 15000 })
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
