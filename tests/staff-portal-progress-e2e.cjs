// tests/staff-portal-progress-e2e.cjs
//
// Two staff screens from the 25 Oct build, in the built app with Supabase
// faked (tests/portal-harness.cjs → openStaff):
//   · Events → Portal settings → Who's behind: rows from
//     wp_admin_portal_progress, red/amber/ok filtering, a click opens the event,
//     and a database without the function says so instead of failing;
//   · Settings → Email templates → Client portal → Deadline reminder: the
//     Monday switch saves as on:true alongside the other templates (and keeps a
//     template this screen does not know), and the preview lists who would get
//     one, from the function's dry run.
//
//   npx vite build --outDir "$HOME/dist-check" --emptyOutDir && node tests/staff-portal-progress-e2e.cjs

const os = require('os'), path = require('path')
const { openStaff } = require('./portal-harness.cjs')
const DIST = process.env.DIST || path.join(os.homedir(), 'dist-check')

let passes = 0; const fails = []
const check = (n, ok, d) => { if (ok) passes++; else fails.push(n + (d ? ': ' + d : '')) }

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
const plus = (n) => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)
const row = (o) => Object.assign({ event_type: 'Wedding', status: 'Confirmed', logins: 1, last_seen: '2026-10-20T10:00:00Z',
  visible: ['guests', 'timeline', 'checklist', 'layout'], ready: [], reopened: [], numbers: { adults: 80 }, guests_seated: 0,
  guests_evening: 0, guests_at_tables: 0, tables: 0, timeline_lines: 3, drinks_route: null, drinks_locked: false,
  checklist_overdue: 0, checklist_soon: 0, checklist_done: 2, checklist_total: 10, next_payment: null, last_reminder: null, last_change: null, invited: null }, o)
const BOARD = { ok: true, today, events: [
  row({ event_id: 901, couple: 'Red Couple', date: plus(40), numbers: null, timeline_lines: 0 }),
  row({ event_id: 902, couple: 'Amber Couple', date: plus(300), checklist_soon: 1 }),
  row({ event_id: 903, couple: 'Fine Couple', date: plus(400), ready: ['guests'] }),
] }
const BOOKINGS = [
  { id: 901, couple: 'Red Couple', date: plus(40), status: 'Confirmed', eventType: 'Wedding (Peak)' },
  { id: 902, couple: 'Amber Couple', date: plus(300), status: 'Confirmed', eventType: 'Wedding (Peak)' },
  { id: 903, couple: 'Fine Couple', date: plus(400), status: 'Confirmed', eventType: 'Wedding (Peak)' },
]

async function openBoard(h) {
  await h.page.locator('nav, aside').getByText('Events', { exact: true }).first().click()
  await h.page.getByText('Portal settings', { exact: true }).first().click()
  await h.page.getByText("Who's behind", { exact: false }).first().waitFor({ timeout: 8000 })
}

;(async () => {
  // ── the board ───────────────────────────────────────────────────────────
  let h = await openStaff({ distDir: DIST, appData: { hawthbush_bookings_v6: BOOKINGS }, rpc: { wp_admin_portal_progress: () => BOARD } })
  await openBoard(h)
  await h.page.locator('tr[data-event]').first().waitFor({ timeout: 8000 })
  let ids = await h.page.locator('tr[data-event]').evaluateAll((els) => els.map((e) => e.getAttribute('data-event')))
  check('B1 opens on "behind": red and amber, not the fine one', ids.join(',') === '901,902', ids.join(','))
  const red = await h.page.locator('tr[data-event="901"]').innerText()
  check('B2 the red row says why', /No numbers/.test(red) && /No timeline/.test(red), red)
  await h.page.getByRole('tab', { name: /All coming/ }).click()
  ids = await h.page.locator('tr[data-event]').evaluateAll((els) => els.map((e) => e.getAttribute('data-event')))
  check('B3 "All coming" shows everyone', ids.length === 3, ids.join(','))
  const fine = await h.page.locator('tr[data-event="903"]').innerText()
  check('B4 marked-done counts only pages that can be marked (checklist cannot)', /1 of 3/.test(fine), fine)
  await h.page.locator('tr[data-event="902"] button').first().click()
  await h.page.waitForTimeout(800)
  const body = await h.page.locator('body').innerText()
  check('B5 a click opens the event', /Amber Couple/.test(body) && !(await h.page.locator('tr[data-event]').count()), body.slice(0, 200))
  check('B6 no page errors', h.errors.length === 0, h.errors.join(' | '))
  await h.close()

  // ── before the migration ────────────────────────────────────────────────
  h = await openStaff({ distDir: DIST, appData: { hawthbush_bookings_v6: BOOKINGS } })
  await openBoard(h)
  await h.page.getByText('2026-10-25n-nudges-progress.sql', { exact: false }).waitFor({ timeout: 8000 })
  check('M1 a database without the function says what is needed', true)
  check('M2 and raises no red failure banner', !(await h.page.getByText(/failed \(404\)/).count()))
  await h.close()

  // ── the deadline reminder switch and preview ────────────────────────────
  let dry = null
  h = await openStaff({ distDir: DIST, appData: { hbf_portal_email_templates_v1: [{ id: 'invite', subject: 'Hi', body: 'B', button: 'Go' }, { id: 'future_one', subject: 'S', body: 'B' }] } })
  await h.page.route('**/.netlify/functions/portal-nudges', async (route) => {
    dry = JSON.parse(route.request().postData() || '{}')
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, dryRun: true, on: false, today: dry.today,
      due: [{ event_id: 901, who: 'Red Couple', to: ['a@x.test'], subject: 'Coming up', items: 3, text: 'Hello Sam,\n\nStill to do…' }] }) })
  })
  await h.page.locator('nav, aside').getByText('Settings', { exact: true }).first().click()
  await h.page.getByText('Email templates', { exact: true }).first().click()
  await h.page.getByRole('tab', { name: 'Client portal' }).click()
  await h.page.getByText('Deadline reminder (weekly)').click()
  const box = h.page.getByLabel('Send this every Monday morning')
  check('N1 off to begin with', !(await box.isChecked()))
  await h.page.getByRole('button', { name: 'Who would get one next Monday?' }).click()
  await h.page.getByText('Red Couple', { exact: false }).first().waitFor({ timeout: 5000 })
  check('N2 preview asks the function for next Monday, as a dry run', dry && dry.dryRun === true && new Date(dry.today + 'T12:00:00Z').getUTCDay() === 1, JSON.stringify(dry))
  await h.page.getByText('Red Couple', { exact: false }).first().click()
  check('N3 the email can be read in the preview', await h.page.getByText('Still to do…', { exact: false }).count() > 0)
  await box.check()
  await h.page.getByRole('button', { name: 'Save', exact: true }).click()
  await h.page.getByText('Saved', { exact: true }).waitFor({ timeout: 5000 })
  const writes = h.calls.filter((c) => c.fn === 'write:app_data').map((c) => { try { return JSON.parse(c.args) } catch (e) { return null } })
    .filter((w) => w && w.key === 'hbf_portal_email_templates_v1')
  const saved = writes.length ? writes[writes.length - 1].value : []
  const nudge = saved.find((x) => x.id === 'nudge')
  check('N4 saved with on:true', nudge && nudge.on === true, JSON.stringify(nudge))
  check('N5 a template this screen does not know is kept', saved.some((x) => x.id === 'future_one'))
  check('N6 the other templates keep no "on" switch', saved.filter((x) => x.id !== 'nudge').every((x) => !('on' in x)))
  check('N7 no page errors', h.errors.length === 0, h.errors.join(' | '))
  await h.close()

  if (fails.length) { console.log(passes + ' passed, FAILED:\n  ' + fails.join('\n  ')); process.exit(1) }
  console.log('ALL ' + passes + ' ASSERTIONS PASSED')
})().catch((e) => { console.error(e); process.exit(1) })
