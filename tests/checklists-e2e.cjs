// tests/checklists-e2e.cjs
//
// Staff checklists in the built app, Supabase faked (tests/portal-harness.cjs →
// openStaff) with a small in-memory stand-in for the chk_ functions:
//   · admin home: a card per live list ("1 of 3 done", OVERDUE in red), the
//     notes left on items with Read, and no Todoist box;
//   · the list on a phone: your items first, a tap ticks, More → Not
//     applicable or Done with a comment, Ignore this list with a reason;
//   · Settings → Checklists: a new pay bar list saved with its trigger and items;
//   · the bar login: live lists above the tabs, and a Checklists tab;
//   · housekeeping: the lists at the top of Live, and a Checklists tab;
//   · the event's Drinks & bar: the office's Pay bar tick.
//
//   npx vite build --outDir "$HOME/dist-check" --emptyOutDir && node tests/checklists-e2e.cjs

const os = require('os'), path = require('path')
const { openStaff } = require('./portal-harness.cjs')
const DIST = process.env.DIST || path.join(os.homedir(), 'dist-check')

let passes = 0; const fails = []
const check = (n, ok, d) => { if (ok) { passes++; console.log('  ok   ' + n) } else { fails.push(n + (d ? ': ' + d : '')); console.log('  FAIL ' + n + (d ? ': ' + d : '')) } }

const now = Date.now()
const iso = (ms) => new Date(ms).toISOString()

function freshState() {
  return {
    runs: [{
      id: 'R1', title: 'Bar opening', context: 'Smith Wedding · Wedding · Sat 31 Oct 12:00', status: 'open', kind: 'event',
      link: { kind: 'event', id: '801' }, anchor_at: iso(now - 3600e3), opens_at: iso(now - 3600e3),
      items: [
        { id: 'I1', title: 'Float in the till', detail: '£150 in coins', who: 'role:bar', who_label: 'Bar', due_at: iso(now - 600e3), state: 'open', mine: false },
        { id: 'I2', title: 'Ice machine on', who: 'role:admin', who_label: 'Office', due_at: iso(now + 3600e3), state: 'open', mine: true },
        { id: 'I3', title: 'Glasswasher filled', who: 'anyone', who_label: 'Anyone', due_at: iso(now + 3600e3), state: 'done', done_by: 'Bar', done_at: iso(now - 60e3), mine: true },
      ]
    }],
    notes: [{ item_id: 'I9', run_id: 'R1', run_title: 'Bar opening', context: 'Smith Wedding', title: 'Lager line', state: 'note',
              comment: 'Lager keg nearly empty', by: 'Bar', at: iso(now - 120e3) }],
    closed: [],
    templates: [],
  }
}

function rpcFor(st, role) {
  const mineFor = (i) => i.who === 'anyone' || i.who === 'role:' + role
  const view = (r) => Object.assign({}, r, { items: r.items.map((i) => Object.assign({}, i, { mine: mineFor(i), can_untick: i.state !== 'open' })) })
  return {
    my_profile: () => ({ id: '00000000-0000-4000-8000-00000000beef', role: role, active: true, name: role === 'admin' ? 'Office' : '' }),
    chk_live: () => ({ ok: true, runs: st.runs.filter((r) => r.status === 'open').map(view),
      notes: role === 'admin' ? st.notes : [], closed: role === 'admin' ? st.closed : [] }),
    chk_run_get: (a) => ({ ok: true, run: view(st.runs.find((r) => r.id === a.p_id)) }),
    chk_past: () => ({ ok: true, runs: st.runs.filter((r) => r.status !== 'open').map(view) }),
    chk_tick: (a) => {
      const r = st.runs.find((x) => x.items.some((i) => i.id === a.p_item))
      const i = r.items.find((x) => x.id === a.p_item)
      if (a.p_state === 'note' && !a.p_comment) return { ok: false, error: 'comment_needed' }
      Object.assign(i, a.p_state === 'open' ? { state: 'open', done_by: null, done_at: null, comment: null }
        : { state: a.p_state, done_by: role === 'admin' ? 'Office' : 'Bar', done_at: iso(Date.now()), comment: a.p_comment || null })
      if (r.items.every((x) => x.state !== 'open')) r.status = 'done'
      return { ok: true, run: view(r) }
    },
    chk_ignore: (a) => { const r = st.runs.find((x) => x.id === a.p_run); r.status = 'ignored'; r.reason = a.p_reason; return { ok: true } },
    chk_seen: (a) => { st.notes = st.notes.filter((n) => (a.p_items || []).indexOf(n.item_id) === -1); return { ok: true } },
    chk_people: () => ({ ok: true, people: [{ who: 'person:aaaa', label: 'Toby' }, { who: 'role:admin', label: 'Office' },
      { who: 'role:bar', label: 'Bar' }, { who: 'role:cleaner', label: 'Housekeeping' }, { who: 'anyone', label: 'Anyone' }] }),
    chk_templates_list: () => ({ ok: true, templates: st.templates }),
    chk_template_save: (a) => { st.saved = a.p; st.templates.push(Object.assign({ id: 'T' + st.templates.length, open_runs: 0 }, a.p)); return { ok: true, id: 'T1' } },
    wp_admin_drinks: () => ({ ok: true, order: { event_id: 801, route: 'classic', pay_bar: true, staff_pay_bar: null }, lines: [], summary: {}, bar_payments: [] }),
    wp_admin_set_pay_bar: (a) => { st.payBar = a; return { ok: true } },
    wp_admin_numbers: () => ({ ok: true, told_us: false }),
  }
}

const EVENTS = [{ id: 801, couple: 'Smith Wedding', date: new Date(now + 3 * 86400e3).toISOString().slice(0, 10), status: 'Confirmed', eventType: 'Wedding (Peak)' }]

async function open(role, st, viewport) {
  const s = await openStaff({ distDir: DIST, rpc: rpcFor(st, role), viewport,
    appData: { hawthbush_bookings_v6: EVENTS, hbf_properties_v1: [{ id: 'hamlet', name: 'The Hamlet' }], hbf_accom_v1: [] } })
  await s.page.route('**/.netlify/functions/box-admin', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ events: [], orders: [] }) }))
  // The bar screens' own data is not faked here; their "came back empty"
  // banner would sit over the page.
  await s.page.waitForTimeout(800)
  const dismiss = s.page.getByRole('button', { name: 'Dismiss' })
  if (await dismiss.count()) await dismiss.first().click().catch(() => {})
  return s
}
const called = (s, fn) => s.calls.filter((c) => c.fn === fn)

;(async () => {
  // ── Office home and a list ─────────────────────────────────────────────────
  let st = freshState()
  let s = await open('admin', st)
  let page = s.page
  try {
    const card = page.getByRole('button', { name: 'Open checklist: Bar opening' })
    await card.waitFor({ timeout: 15000 })
    const text = await card.innerText()
    check('home card: counts', /1 of 3 done/.test(text), text)
    check('home card: overdue shows red', /OVERDUE/.test(text), text)
    check('home card: what it is for', /Smith Wedding/.test(text))
    check('no Todoist box on home', (await page.getByText('Nothing due in the next week.').count()) === 0)
    await page.getByText('Lager keg nearly empty').waitFor({ timeout: 5000 })
    check('note from a list on home', true)
    await page.getByRole('button', { name: 'Read' }).first().click()
    await page.waitForTimeout(300)
    check('Read marks the note seen', called(s, 'chk_seen').length === 1 && called(s, 'chk_seen')[0].args.p_items[0] === 'I9')

    await card.click()
    await page.getByRole('heading', { name: 'Bar opening' }).waitFor({ timeout: 5000 })
    const titles = await page.locator('div[style*="font-size: 15.5px"]').allInnerTexts()
    check('your items first (office: Ice machine, Glasswasher), then others', titles.join('|') === 'Ice machine on|Glasswasher filled|Float in the till', titles.join('|'))
    check('overdue item says so', (await page.getByText(/overdue, was due/).count()) === 1)
    check('done item shows who', (await page.getByText(/Done · Bar/).count()) === 1)
    check('admin can open the event', (await page.getByRole('button', { name: 'Open the event' }).count()) === 1)

    await page.getByRole('button', { name: 'Mark done: Ice machine on' }).click()
    await page.waitForTimeout(300)
    check('a tap ticks it', called(s, 'chk_tick').some((c) => c.args.p_item === 'I2' && c.args.p_state === 'done'))

    await page.getByRole('button', { name: 'More' }).first().click()
    await page.getByRole('button', { name: 'Not applicable' }).click()
    await page.waitForTimeout(300)
    check('More → Not applicable', called(s, 'chk_tick').some((c) => c.args.p_item === 'I1' && c.args.p_state === 'na'))
    check('the last item finishes the list', st.runs[0].status === 'done')
    check('N/A shows on the row', (await page.getByText(/Not applicable · Office/).count()) === 1)

    // a comment
    st.runs[0].status = 'open'; Object.assign(st.runs[0].items[0], { state: 'open', done_by: null })
    await page.locator('.hb-page-back').click()
    await page.getByRole('button', { name: 'Open checklist: Bar opening' }).click()
    await page.getByRole('button', { name: 'More' }).first().click()
    const done = page.getByRole('button', { name: 'Done, with this comment' })
    check('comment button off until something is written', await done.isDisabled())
    await page.locator('textarea').fill('Only £120 in coins')
    await done.click()
    await page.waitForTimeout(300)
    check('Done with a comment', called(s, 'chk_tick').some((c) => c.args.p_state === 'note' && c.args.p_comment === 'Only £120 in coins'))
    await page.getByText('Only £120 in coins').waitFor({ timeout: 3000 })
    check('the comment shows under the item', true)

    // ignore
    st.runs[0].status = 'open'; Object.assign(st.runs[0].items[1], { state: 'open' })
    await page.locator('.hb-page-back').click()
    await page.getByRole('button', { name: 'Open checklist: Bar opening' }).click()
    await page.getByRole('button', { name: 'Ignore this list' }).click()
    await page.getByRole('button', { name: 'Event cancelled' }).click()
    await page.getByRole('button', { name: 'Ignore this list' }).last().click()
    await page.waitForTimeout(300)
    check('Ignore with a reason', called(s, 'chk_ignore').some((c) => c.args.p_run === 'R1' && c.args.p_reason === 'Event cancelled'))

    // ── Settings → Checklists ───────────────────────────────────────────────
    await page.goto(s.origin + '/')
    await page.getByRole('button', { name: 'Open checklist: Bar opening' }).waitFor({ state: 'detached', timeout: 15000 }).catch(() => {})
    await page.locator('.hb-app').getByText('Settings', { exact: true }).first().click()
    await page.getByText('Checklists', { exact: true }).last().click()
    await page.getByRole('button', { name: 'New checklist' }).click()
    await page.getByPlaceholder('e.g. Bar opening').fill('Bar closing')
    await page.locator('select').first().selectOption('event')
    await page.locator('select').nth(1).selectOption('paybar')
    await page.getByPlaceholder('What needs doing').fill('Cash up the till')
    await page.locator('select').filter({ has: page.locator('option[value="role:bar"]') }).first().selectOption('role:bar')
    await page.getByRole('button', { name: 'Save checklist' }).click()
    await page.waitForTimeout(400)
    const saved = st.saved || {}
    check('template saved with its trigger', saved.title === 'Bar closing' && saved.trig && saved.trig.kind === 'event' && saved.trig.event_type === 'paybar', JSON.stringify(saved.trig))
    check('…and its item for the bar', saved.items && saved.items.length === 1 && saved.items[0].who === 'role:bar' && saved.items[0].title === 'Cash up the till', JSON.stringify(saved.items))
    check('the list shows it, in words', (await page.getByText(/events with a pay bar/i).count()) >= 1)
    check('event start times are offered', (await page.getByText('When an event starts').count()) === 1)
  } catch (e) { fails.push('office: ' + e.message) }
  check('office: no page errors', s.errors.length === 0, s.errors.join(' | '))
  await s.close()

  // ── The event's Drinks & bar: the office's pay bar tick ────────────────────
  st = freshState()
  s = await open('admin', st)
  page = s.page
  try {
    await page.goto(s.origin + '/')
    await page.locator('.hb-app').getByText('Events', { exact: true }).first().click()
    await page.getByText('Smith Wedding').first().click()
    await page.getByRole('button', { name: /Drinks/ }).first().click()
    await page.getByText('Office says:').waitFor({ timeout: 8000 })
    check('drinks: client answer shown', (await page.getByText(/Client says:/).count()) === 1)
    check('drinks: has a pay bar (from the client)', (await page.getByText('has a pay bar').count()) === 1)
    await page.getByRole('button', { name: 'No pay bar' }).click()
    await page.waitForTimeout(300)
    check('office override sent', st.payBar && st.payBar.p_event_id === 801 && st.payBar.p_value === false, JSON.stringify(st.payBar))
  } catch (e) { fails.push('drinks: ' + e.message) }
  await s.close()

  // ── The bar login, on a phone ──────────────────────────────────────────────
  st = freshState()
  s = await open('bar', st, { width: 390, height: 844 })
  page = s.page
  try {
    const card = page.getByRole('button', { name: 'Open checklist: Bar opening' })
    await card.waitFor({ timeout: 15000 })
    check('bar: live list above the tabs', true)
    const tabs = await page.getByRole('tab').allInnerTexts()
    check('bar: a Checklists tab', tabs.indexOf('Checklists') !== -1, tabs.join('|'))
    await card.click()
    await page.getByRole('heading', { name: 'Bar opening' }).waitFor({ timeout: 5000 })
    const titles = await page.locator('div[style*="font-size: 15.5px"]').allInnerTexts()
    check('bar: the bar item first', titles[0] === 'Float in the till', titles.join('|'))
    check('bar: no link to the event', (await page.getByRole('button', { name: 'Open the event' }).count()) === 0)
    const box = await page.getByRole('button', { name: 'Mark done: Float in the till' }).boundingBox()
    check('bar: the tick box is big enough for a thumb', box && box.width >= 40 && box.height >= 40)
    const wide = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
    check('bar: no sideways scroll at 390px', wide)
  } catch (e) { fails.push('bar: ' + e.message) }
  check('bar: no page errors', s.errors.length === 0, s.errors.join(' | '))
  await s.close()

  // ── Housekeeping ───────────────────────────────────────────────────────────
  st = freshState()
  st.runs[0].items[0].who = 'role:cleaner'; st.runs[0].items[0].who_label = 'Housekeeping'
  s = await open('cleaner', st, { width: 390, height: 844 })
  page = s.page
  try {
    await page.getByRole('button', { name: 'Open checklist: Bar opening' }).waitFor({ timeout: 15000 })
    check('housekeeping: list at the top of Live', true)
    await page.getByRole('tab', { name: 'Checklists' }).click()
    await page.getByText('Finished and past').waitFor({ timeout: 5000 })
    check('housekeeping: Checklists tab', true)
  } catch (e) { fails.push('housekeeping: ' + e.message) }
  check('housekeeping: no page errors', s.errors.length === 0, s.errors.join(' | '))
  await s.close()

  console.log('\n' + passes + ' passed, ' + fails.length + ' failed')
  fails.forEach((f) => console.log('  FAIL ' + f))
  process.exit(fails.length ? 1 : 0)
})()
