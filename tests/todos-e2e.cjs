// tests/todos-e2e.cjs — the To-do page, the home card and the "+ To-do"
// button, in the BUILT app with Supabase faked: the todo_ functions by
// tests/todos/fake-db.cjs, the todo-photos bucket kept in memory here.
//   npx vite build --outDir "$HOME/dist-check" --emptyOutDir
//   node tests/todos-e2e.cjs [shots-dir]
const assert = require('assert')
const path = require('path')
const os = require('os')
const { openStaff } = require('./portal-harness.cjs')
const { makeTodoDb } = require('./todos/fake-db.cjs')

const HOST = 'https://rkqbyisfmvwulsyxzwjz.supabase.co'
const distDir = path.join(os.homedir(), 'dist-check')
const shots = process.argv[2] || null
const ME = '00000000-0000-4000-8000-00000000beef'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

function londonToday() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }) }
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

const ROS = '00000000-0000-4000-8000-0000000000a2'
const PEOPLE = [{ who: 'person:' + ME, label: 'Toby' }, { who: 'person:' + ROS, label: 'Rosanna' },
  { who: 'role:admin', label: 'Office' }, { who: 'role:bar', label: 'Bar' }, { who: 'role:cleaner', label: 'Housekeeping' }, { who: 'anyone', label: 'Anyone' }]
const LABELS = {}; PEOPLE.forEach((p) => { LABELS[p.who] = p.label })

// The private bucket, in memory.
async function fakePhotos(page, files) {
  await page.route(HOST + '/storage/v1/object/**', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname.replace(/^.*\/(todo-photos|booking-files)\//, '')
    if (req.method() === 'POST' && !p.startsWith('/storage')) { files[p] = req.postDataBuffer(); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"Key":"x"}' }) }
    if (req.method() === 'GET') return route.fulfill({ status: files[p] ? 200 : 404, contentType: 'image/png', body: files[p] || '' })
    if (req.method() === 'DELETE') { JSON.parse(req.postData()).prefixes.forEach((k) => { delete files[k] }); return route.fulfill({ status: 200, body: '[]' }) }
    return route.fulfill({ status: 404, body: '' })
  })
}
async function until(fn, what) {
  for (let i = 0; i < 50; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 100)) }
  throw new Error('timed out: ' + what)
}

async function run(viewport, label) {
  const today = londonToday()
  const db = await makeTodoDb({
    me: { id: ME, role: 'admin', name: 'Toby' }, labels: LABELS,
    items: [
      { id: 'td_old', title: 'Clear the gutters on the Hamlet', priority: 'week', setOn: addDays(today, -10), who: 'role:admin',
        area: 'hamlet', project: null, createdAt: '2026-10-01T09:00:00Z', createdById: ME },
      { id: 'td_bar', title: 'Restock the ice machine', priority: 'day', setOn: today, who: 'role:bar', area: 'grain-store',
        createdAt: '2026-11-01T09:00:00Z' },
      { id: 'td_mine', title: 'Ring the farrier', priority: 'day', setOn: today, who: 'person:' + ME, createdAt: '2026-11-02T09:00:00Z', createdById: ME },
      { id: 'td_someday', title: 'Paint the gate', priority: 'eventually', who: 'person:' + ME, createdAt: '2026-11-02T09:00:00Z', createdById: ME },
      // Rosanna's private one, which the database never sends to Toby.
      { id: 'td_rosa', title: 'Rosanna private', priority: 'day', setOn: today, who: 'role:admin', private: true, createdById: ROS },
    ],
  })
  const files = {}
  const { page, errors, close } = await openStaff({
    distDir, appData: {}, viewport,
    rpc: Object.assign({ chk_people: () => ({ ok: true, people: PEOPLE }) }, db.rpc),
  })
  await fakePhotos(page, files)
  const phone = viewport.width < 700
  const item = (id) => db.items.get(id)

  // ── Home: this week's for me, overdue marked, Eventually left off ──
  const card = page.locator('section[aria-label="To-do for you"]')
  await card.getByText('Clear the gutters on the Hamlet').waitFor()
  assert.ok(await card.getByText('Ring the farrier').isVisible(), label + ': due tomorrow is on the card')
  assert.strictEqual(await card.getByText('Paint the gate').count(), 0, label + ': Eventually is not')
  assert.strictEqual(await card.getByText('Restock the ice machine').count(), 0, label + ': the bar\'s is not mine')
  assert.ok(await card.getByText('1 OVERDUE').isVisible(), label + ': overdue count')
  assert.strictEqual(await page.getByText('Rosanna private').count(), 0, label + ': someone else\'s private one never arrives')
  if (shots) await page.screenshot({ path: path.join(shots, label + '-home.png'), fullPage: false })
  await card.getByRole('button', { name: 'Mark done: Ring the farrier' }).click()
  await until(() => item('td_mine').state === 'done', 'tick from the home card')
  await card.getByText('Ring the farrier').waitFor({ state: 'detached' })
  await card.getByRole('button', { name: 'All to-dos' }).click()
  await page.getByRole('heading', { name: 'To-do' }).waitFor()

  // Overdue goes first, whatever its priority.
  const firstGroup = await page.locator('section').first().getAttribute('aria-label')
  assert.strictEqual(firstGroup, 'Overdue', label + ': overdue first')
  assert.ok(await page.locator('section[aria-label="Overdue"]').getByText('Clear the gutters on the Hamlet').isVisible())

  // A new project from the edit sheet, then a to-do in it with a photo.
  await page.locator('.hb-actions, div').getByRole('button', { name: '+ New to-do' }).first().click()
  await page.getByLabel('Heading').fill('Replace the cinema barn projector bulb')
  await page.getByRole('radio', { name: '1 month' }).click()
  await page.getByRole('radio', { name: 'Rosanna' }).click()
  await page.getByLabel('Area').selectOption('cinema-barn')
  page.once('dialog', (d) => d.accept('Cinema refit'))
  await page.getByLabel('Project').selectOption('__new')
  await page.waitForFunction(() => document.querySelector('#todo-project').value === 'cinema-refit')
  await page.locator('input[type=file]').setInputFiles({ name: 'bulb.png', mimeType: 'image/png', buffer: PNG })
  await page.getByRole('button', { name: 'Remove photo' }).waitFor()
  if (shots) await page.screenshot({ path: path.join(shots, label + '-edit.png'), fullPage: false })
  await page.getByRole('button', { name: 'Add to-do' }).click()
  await page.getByLabel('Heading').waitFor({ state: 'detached' })   // the sheet closes once saved
  const added = [...db.items.values()].find((t) => t.title === 'Replace the cinema barn projector bulb')
  assert.ok(added, label + ': saved')
  assert.strictEqual(added.priority, 'month'); assert.strictEqual(added.setOn, today)
  assert.strictEqual(added.who, 'person:' + ROS); assert.strictEqual(added.whoLabel, 'Rosanna')
  assert.strictEqual(added.area, 'cinema-barn'); assert.strictEqual(added.project, 'cinema-refit')
  assert.strictEqual(added.photos.length, 1)
  assert.ok(added.photos[0].path.startsWith(added.id + '/'), label + ': photo filed under its to-do')
  assert.ok(files[added.photos[0].path], label + ': photo stored in the private bucket')
  assert.ok(db.lists.project.some((p) => p.id === 'cinema-refit'))

  // Group by project.
  await page.getByRole('tab', { name: 'Project' }).click()
  await page.locator('section[aria-label="Cinema refit"]').getByText('Replace the cinema barn projector bulb').waitFor()
  if (shots) await page.screenshot({ path: path.join(shots, label + '-project.png'), fullPage: true })

  // Tick from the list.
  await page.getByRole('button', { name: 'Mark done: Clear the gutters on the Hamlet' }).click()
  await until(() => item('td_old').state === 'done', 'tick')
  assert.strictEqual(item('td_old').doneBy, 'Toby')

  // Done with a comment, from More.
  await page.getByRole('tab', { name: 'Priority' }).click()
  const row = page.locator('[data-todo-id="td_bar"]')
  await row.getByRole('button', { name: 'More' }).click()
  await page.getByPlaceholder('e.g. New latch fitted').fill('Two bags left')
  await page.getByRole('button', { name: 'Done, with this comment' }).click()
  await until(() => item('td_bar').state === 'note', 'done with a comment')
  assert.strictEqual(item('td_bar').comment, 'Two bags left')

  // Show done, untick.
  await page.getByRole('button', { name: /Show done in the last 30 days/ }).click()
  await page.getByRole('button', { name: 'Untick: Clear the gutters on the Hamlet' }).click()
  await until(() => item('td_old').state === 'open', 'untick')
  assert.strictEqual(item('td_old').doneBy, null)

  // "+ To-do" from another page.
  if (phone) { await page.getByRole('button', { name: 'Open menu' }).click() }
  await page.locator('.hb-nav-item', { hasText: 'Enquiries' }).click()
  // The faked back end has no enquiries functions, so that page raises the
  // red "could not read" banner over the top bar; put it away first.
  await page.waitForTimeout(500)
  for (const b of await page.getByRole('button', { name: 'Dismiss' }).all()) { if (await b.isVisible()) await b.click() }
  await page.locator('.hb-top-todo').click()
  await page.getByLabel('Heading').fill('Order more logs')
  await page.getByRole('radio', { name: 'Eventually' }).click()
  await page.getByRole('checkbox', { name: /Private/ }).check()
  await page.getByRole('button', { name: 'Add to-do' }).click()
  await page.getByRole('status').getByText('Added: Order more logs').waitFor()
  assert.ok([...db.items.values()].some((t) => t.title === 'Order more logs' && t.priority === 'eventually' && t.who === 'person:' + ME && t.private === true))
  if (shots) await page.screenshot({ path: path.join(shots, label + '-quickadd.png') })
  await page.getByRole('status').getByRole('button', { name: 'View' }).click()
  await page.getByRole('heading', { name: 'To-do' }).waitFor()
  await page.getByRole('tab', { name: 'Person' }).click()
  if (shots) await page.screenshot({ path: path.join(shots, label + '-person.png'), fullPage: true })

  // Delete takes a second press and removes the photo.
  await page.getByText('Replace the cinema barn projector bulb').click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Press again to delete' }).click()
  await until(() => !db.items.has(added.id), 'delete')
  await until(() => !files[added.photos[0].path], 'photo taken down')

  // Areas & projects: rename one; in-use ones cannot be deleted.
  await page.getByRole('button', { name: 'Areas & projects' }).click()
  const hamlet = page.getByLabel('Name of The Hamlet')
  await hamlet.fill('Hamlet')
  await page.getByLabel('Name of Hamlet').or(hamlet).first().press('Tab')
  await until(() => db.lists.area.some((a) => a.id === 'hamlet' && a.name === 'Hamlet'), 'rename an area')
  assert.ok(await page.getByRole('button', { name: 'Delete Hamlet' }).isDisabled(), label + ': in-use area not deletable')
  // A private project, then made public again.
  await page.getByPlaceholder('New project').fill('Personal admin')
  await page.getByRole('checkbox', { name: /only I see this project/ }).check()
  await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  await until(() => db.lists.project.some((p) => p.name === 'Personal admin'), 'add a private project')
  const pa = db.lists.project.find((p) => p.name === 'Personal admin')
  assert.ok(pa.private === true && pa.ownerId === ME, label + ': private project')
  await page.getByLabel('Name of Personal admin').locator('xpath=..').getByRole('button', { name: 'Private' }).click()
  await until(() => !pa.private, 'made public')
  // An unused project can be deleted (after a confirm).
  page.once('dialog', (d) => d.accept())
  await page.getByRole('button', { name: 'Delete Cinema refit' }).click()
  await until(() => !db.lists.project.some((p) => p.id === 'cinema-refit'), 'delete an unused project')
  if (shots) await page.screenshot({ path: path.join(shots, label + '-lists.png') })
  await page.getByText('Done', { exact: true }).last().click()

  // Todoist CSV (office only): an error is shown; then the sheet downloads.
  let todoistReply = { status: 400, body: { error: "Todoist isn't connected yet. Add TODOIST_API_TOKEN." } }
  await page.route('**/.netlify/functions/todoist-export', (route) =>
    route.fulfill({ status: todoistReply.status, contentType: 'application/json', body: JSON.stringify(todoistReply.body) }))
  await page.getByRole('button', { name: 'Todoist CSV' }).click()
  await page.getByText(/TODOIST_API_TOKEN/).waitFor()
  todoistReply = { status: 200, body: { ok: true,
    projects: [{ id: 'p1', name: 'Inbox', inbox: true }, { id: 'p2', name: 'Wood Store', shared: false }],
    sections: [], people: [],
    tasks: [{ id: 't1', content: 'Stack logs', projectId: 'p2', labels: [], priority: 1, order: 1 },
      { id: 't2', content: 'Renew insurance', projectId: 'p1', labels: [], priority: 4, order: 2 }] } }
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Todoist CSV' }).click()])
  assert.ok(/^todoist-to-do-mapping-\d{4}-\d{2}-\d{2}\.csv$/.test(dl.suggestedFilename()), label + ': csv name')
  const csv = require('fs').readFileSync(await dl.path(), 'utf8')
  assert.ok(csv.includes('"Import","Stack logs","Wood Store","project"'), label + ': mapped row')
  assert.ok(csv.includes('"Renew insurance",""'), label + ': no area found')
  await page.getByText(/2 Todoist tasks in the sheet · 1 with no area yet\. Nothing has been imported\./).waitFor()
  if (shots) await page.screenshot({ path: path.join(shots, label + '-todoist.png') })

  assert.deepStrictEqual(errors, [], label + ': no page errors')
  await close()
  console.log('  ok  ' + label)
}

// The housekeeping login: sees what is for Housekeeping or Everyone and what
// it wrote — not the office's own, nor anyone's private ones — can tick, and
// can only look at (not change) what someone else wrote.
async function runHousekeeping() {
  const HK = '00000000-0000-4000-8000-0000000000c1'
  const db = await makeTodoDb({
    me: { id: HK, role: 'cleaner', name: 'Housekeeping' }, labels: LABELS,
    items: [
      { id: 'h1', title: 'Spare duvet for the Hamlet', priority: 'week', setOn: londonToday(), who: 'role:cleaner', createdById: ME, createdAt: '1' },
      { id: 'h2', title: 'Office only job', priority: 'week', setOn: londonToday(), who: 'role:admin', createdById: ME, createdAt: '2' },
      { id: 'h3', title: 'Everyone job', priority: 'eventually', who: 'anyone', createdById: ME, createdAt: '3' },
      { id: 'h4', title: 'Secret job', priority: 'eventually', who: 'anyone', private: true, createdById: ME, createdAt: '4' },
    ],
  })
  const { page, errors, close } = await openStaff({
    distDir, appData: {}, viewport: { width: 390, height: 844 },
    rpc: Object.assign({ my_profile: () => ({ id: HK, role: 'cleaner', active: true, name: 'Karina' }),
      chk_people: () => ({ ok: true, people: [{ who: 'role:admin', label: 'Office' }, { who: 'role:cleaner', label: 'Housekeeping' }, { who: 'anyone', label: 'Anyone' }] }) }, db.rpc),
  })
  await page.getByRole('tab', { name: 'To-do' }).click()
  await page.getByText('Spare duvet for the Hamlet').waitFor()
  assert.ok(await page.getByText('Everyone job').isVisible())
  assert.strictEqual(await page.getByText('Office only job').count(), 0, 'housekeeping: office job hidden')
  assert.strictEqual(await page.getByText('Secret job').count(), 0, 'housekeeping: private job hidden')
  await page.getByText('Spare duvet for the Hamlet').click()
  assert.ok(await page.getByLabel('Heading').isDisabled(), 'housekeeping: cannot change the office\'s to-do')
  assert.strictEqual(await page.getByRole('button', { name: 'Save' }).count(), 0)
  assert.strictEqual(await page.getByRole('button', { name: 'Todoist CSV' }).count(), 0, 'housekeeping: no Todoist CSV')
  await page.getByText('Close', { exact: true }).click()
  await page.getByRole('button', { name: 'Mark done: Spare duvet for the Hamlet' }).click()
  await until(() => db.items.get('h1').state === 'done', 'housekeeping tick')
  assert.strictEqual(db.items.get('h1').doneBy, 'Housekeeping')
  // Their own report to the office, defaulting to Office.
  await page.getByRole('button', { name: '+ New to-do' }).click()
  assert.strictEqual(await page.getByRole('radio', { name: 'Office' }).getAttribute('aria-checked'), 'true')
  await page.getByLabel('Heading').fill('Hamlet shower head dripping')
  await page.getByRole('button', { name: 'Add to-do' }).click()
  await page.getByLabel('Heading').waitFor({ state: 'detached' })
  assert.ok(await page.getByText('Hamlet shower head dripping').isVisible(), 'housekeeping: own report shown')
  assert.deepStrictEqual(errors, [])
  await close()
  console.log('  ok  housekeeping')
}

;(async () => {
  await runHousekeeping()
  await run({ width: 1300, height: 900 }, 'desktop')
  await run({ width: 390, height: 844 }, 'phone')
  console.log('todos-e2e passed')
})().catch((e) => { console.error(e); process.exit(1) })
