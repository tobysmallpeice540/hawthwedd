// tests/todos-e2e.cjs — the To-do page and the "+ To-do" button, in the BUILT
// app with Supabase faked (app_data and storage kept in memory here).
//   npx vite build --outDir "$HOME/dist-check" --emptyOutDir
//   node tests/todos-e2e.cjs [shots-dir]
const assert = require('assert')
const path = require('path')
const os = require('os')
const { openStaff } = require('./portal-harness.cjs')

const HOST = 'https://rkqbyisfmvwulsyxzwjz.supabase.co'
const distDir = path.join(os.homedir(), 'dist-check')
const shots = process.argv[2] || null
const ME = '00000000-0000-4000-8000-00000000beef'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

function londonToday() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }) }
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

async function run(viewport, label) {
  const today = londonToday()
  const appData = {
    hbf_todos_v1: [
      { id: 'td_old', title: 'Clear the gutters on the Hamlet', priority: 'week', setOn: addDays(today, -10), who: 'role:admin',
        area: 'hamlet', project: null, state: 'open', createdAt: '2026-10-01T09:00:00Z', createdById: ME, photos: [] },
      { id: 'td_bar', title: 'Restock the ice machine', priority: 'day', setOn: today, who: 'role:bar', area: 'grain-store',
        state: 'open', createdAt: '2026-11-01T09:00:00Z', photos: [] },
    ],
  }
  const files = {}
  const { page, calls, errors, close } = await openStaff({
    distDir, appData, viewport,
    rpc: {
      my_profile: () => ({ id: ME, role: 'admin', active: true, name: 'Toby' }),
      chk_people: () => ({ ok: true, people: [{ who: 'person:' + ME, label: 'Toby' }, { who: 'person:u2', label: 'Rosanna' },
        { who: 'role:admin', label: 'Office' }, { who: 'role:bar', label: 'Bar' }, { who: 'role:cleaner', label: 'Housekeeping' }, { who: 'anyone', label: 'Anyone' }] }),
    },
  })
  // Writes are kept, so the next read (every save re-reads first) sees them.
  await page.route(HOST + '/rest/v1/app_data', async (route) => {
    const req = route.request()
    if (req.method() === 'POST') {
      const b = JSON.parse(req.postData())
      appData[b.key] = b.value
      calls.push({ fn: 'write:app_data', key: b.key })
      return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' })
    }
    return route.fallback()
  })
  await page.route(HOST + '/storage/v1/object/**', async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname.replace(/^.*\/booking-files\//, '')
    if (req.method() === 'POST' && !p.startsWith('/storage')) { files[p] = req.postDataBuffer(); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"Key":"x"}' }) }
    if (req.method() === 'GET') return route.fulfill({ status: files[p] ? 200 : 404, contentType: 'image/png', body: files[p] || '' })
    if (req.method() === 'DELETE') { JSON.parse(req.postData()).prefixes.forEach((k) => { delete files[k] }); return route.fulfill({ status: 200, body: '[]' }) }
    return route.fulfill({ status: 404, body: '' })
  })

  const phone = viewport.width < 700
  // Reach the page from the menu.
  if (phone) { await page.getByRole('button', { name: 'Open menu' }).click() }
  await page.locator('.hb-nav-item', { hasText: 'To-do' }).click()
  await page.getByRole('heading', { name: 'To-do' }).waitFor()
  // The standard areas were written on first open.
  await page.waitForFunction(() => true)
  for (let i = 0; i < 40 && !appData.hbf_todo_areas_v1; i++) await page.waitForTimeout(100)
  assert.ok(Array.isArray(appData.hbf_todo_areas_v1) && appData.hbf_todo_areas_v1.some((a) => a.name === 'Amly Barn'), label + ': areas seeded')

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
  const added = appData.hbf_todos_v1.find((t) => t.title === 'Replace the cinema barn projector bulb')
  assert.ok(added, label + ': saved')
  assert.strictEqual(added.priority, 'month'); assert.strictEqual(added.setOn, today)
  assert.strictEqual(added.who, 'person:u2'); assert.strictEqual(added.whoLabel, 'Rosanna')
  assert.strictEqual(added.area, 'cinema-barn'); assert.strictEqual(added.project, 'cinema-refit')
  assert.strictEqual(added.photos.length, 1); assert.ok(files[added.photos[0].path], label + ': photo stored')
  assert.strictEqual(appData.hbf_todos_v1.length, 3, label + ': nothing lost')
  assert.ok(appData.hbf_todo_projects_v1.some((p) => p.id === 'cinema-refit'))

  // Group by project.
  await page.getByRole('tab', { name: 'Project' }).click()
  await page.locator('section[aria-label="Cinema refit"]').getByText('Replace the cinema barn projector bulb').waitFor()
  if (shots) await page.screenshot({ path: path.join(shots, label + '-project.png'), fullPage: true })

  // Someone else adds one meanwhile; ticking ours must not lose it.
  appData.hbf_todos_v1 = appData.hbf_todos_v1.concat([{ id: 'td_other', title: 'From another phone', priority: 'eventually', who: 'anyone', state: 'open', createdAt: '2026-11-06T10:00:00Z' }])
  await page.getByRole('button', { name: 'Mark done: Clear the gutters on the Hamlet' }).click()
  for (let i = 0; i < 40 && appData.hbf_todos_v1.find((t) => t.id === 'td_old').state !== 'done'; i++) await page.waitForTimeout(100)
  const old = appData.hbf_todos_v1.find((t) => t.id === 'td_old')
  assert.strictEqual(old.state, 'done'); assert.strictEqual(old.doneBy, 'Toby')
  assert.ok(appData.hbf_todos_v1.some((t) => t.id === 'td_other'), label + ': the other phone\'s to-do kept')

  // Done with a comment, from More.
  await page.getByRole('tab', { name: 'Priority' }).click()
  const row = page.locator('[data-todo-id="td_bar"]')
  await row.getByRole('button', { name: 'More' }).click()
  await page.getByPlaceholder('e.g. New latch fitted').fill('Two bags left')
  await page.getByRole('button', { name: 'Done, with this comment' }).click()
  for (let i = 0; i < 40 && appData.hbf_todos_v1.find((t) => t.id === 'td_bar').state !== 'note'; i++) await page.waitForTimeout(100)
  assert.strictEqual(appData.hbf_todos_v1.find((t) => t.id === 'td_bar').comment, 'Two bags left')

  // Show done, untick.
  await page.getByRole('button', { name: /Show done in the last 30 days/ }).click()
  await page.getByRole('button', { name: 'Untick: Clear the gutters on the Hamlet' }).click()
  for (let i = 0; i < 40 && appData.hbf_todos_v1.find((t) => t.id === 'td_old').state !== 'open'; i++) await page.waitForTimeout(100)
  assert.strictEqual(appData.hbf_todos_v1.find((t) => t.id === 'td_old').doneBy, null)

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
  assert.ok(appData.hbf_todos_v1.some((t) => t.title === 'Order more logs' && t.priority === 'eventually' && t.who === 'person:' + ME && t.private === true))
  if (shots) await page.screenshot({ path: path.join(shots, label + '-quickadd.png') })
  await page.getByRole('status').getByRole('button', { name: 'View' }).click()
  await page.getByRole('heading', { name: 'To-do' }).waitFor()
  await page.getByRole('tab', { name: 'Person' }).click()
  if (shots) await page.screenshot({ path: path.join(shots, label + '-person.png'), fullPage: true })

  // Delete takes a second press and removes the photo.
  await page.getByText('Replace the cinema barn projector bulb').click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Press again to delete' }).click()
  for (let i = 0; i < 40 && appData.hbf_todos_v1.some((t) => t.id === added.id); i++) await page.waitForTimeout(100)
  assert.ok(!appData.hbf_todos_v1.some((t) => t.id === added.id))
  for (let i = 0; i < 20 && files[added.photos[0].path]; i++) await page.waitForTimeout(100)
  assert.ok(!files[added.photos[0].path], label + ': photo removed')

  // Areas & projects: rename one; in-use ones cannot be deleted.
  await page.getByRole('button', { name: 'Areas & projects' }).click()
  const hamlet = page.getByLabel('Name of The Hamlet')
  await hamlet.fill('Hamlet')
  await page.getByLabel('Name of Hamlet').or(hamlet).first().press('Tab')
  for (let i = 0; i < 40 && !appData.hbf_todo_areas_v1.some((a) => a.name === 'Hamlet'); i++) await page.waitForTimeout(100)
  assert.ok(appData.hbf_todo_areas_v1.some((a) => a.id === 'hamlet' && a.name === 'Hamlet'))
  assert.ok(await page.getByRole('button', { name: 'Delete Hamlet' }).isDisabled(), label + ': in-use area not deletable')
  // A private project, then made public again.
  await page.getByPlaceholder('New project').fill('Personal admin')
  await page.getByRole('checkbox', { name: /only I see this project/ }).check()
  await page.getByRole('button', { name: 'Add', exact: true }).first().click()
  for (let i = 0; i < 40 && !appData.hbf_todo_projects_v1.some((p) => p.name === 'Personal admin'); i++) await page.waitForTimeout(100)
  const pa = appData.hbf_todo_projects_v1.find((p) => p.name === 'Personal admin')
  assert.ok(pa.private === true && pa.ownerId === ME, label + ': private project')
  await page.getByLabel('Name of Personal admin').locator('xpath=..').getByRole('button', { name: 'Private' }).click()
  for (let i = 0; i < 40 && appData.hbf_todo_projects_v1.find((p) => p.id === pa.id).private; i++) await page.waitForTimeout(100)
  assert.ok(!appData.hbf_todo_projects_v1.find((p) => p.id === pa.id).private, label + ': made public')
  if (shots) await page.screenshot({ path: path.join(shots, label + '-lists.png') })

  assert.deepStrictEqual(errors, [], label + ': no page errors')
  await close()
  console.log('  ok  ' + label)
}

// The housekeeping login: sees what is for Housekeeping or Everyone and what
// it wrote — not the office's own, nor anyone's private ones — can tick, and
// can only look at (not change) what someone else wrote.
async function runHousekeeping() {
  const HK = '00000000-0000-4000-8000-0000000000c1'
  const appData = {
    hbf_todo_areas_v1: [{ id: 'hamlet', name: 'The Hamlet' }],
    hbf_todos_v1: [
      { id: 'h1', title: 'Spare duvet for the Hamlet', priority: 'week', setOn: londonToday(), who: 'role:cleaner', state: 'open', createdById: ME, createdAt: '1' },
      { id: 'h2', title: 'Office only job', priority: 'week', setOn: londonToday(), who: 'role:admin', state: 'open', createdById: ME, createdAt: '2' },
      { id: 'h3', title: 'Everyone job', priority: 'eventually', who: 'anyone', state: 'open', createdById: ME, createdAt: '3' },
      { id: 'h4', title: 'Secret job', priority: 'eventually', who: 'anyone', private: true, state: 'open', createdById: ME, createdAt: '4' },
    ],
  }
  const { page, errors, close } = await openStaff({
    distDir, appData, viewport: { width: 390, height: 844 },
    rpc: { my_profile: () => ({ id: HK, role: 'cleaner', active: true, name: 'Karina' }),
      chk_people: () => ({ ok: true, people: [{ who: 'role:admin', label: 'Office' }, { who: 'role:cleaner', label: 'Housekeeping' }, { who: 'anyone', label: 'Anyone' }] }) },
  })
  await page.route(HOST + '/rest/v1/app_data', async (route) => {
    const req = route.request()
    if (req.method() === 'POST') { const b = JSON.parse(req.postData()); appData[b.key] = b.value; return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' }) }
    return route.fallback()
  })
  await page.getByRole('tab', { name: 'To-do' }).click()
  await page.getByText('Spare duvet for the Hamlet').waitFor()
  assert.ok(await page.getByText('Everyone job').isVisible())
  assert.strictEqual(await page.getByText('Office only job').count(), 0, 'housekeeping: office job hidden')
  assert.strictEqual(await page.getByText('Secret job').count(), 0, 'housekeeping: private job hidden')
  await page.getByText('Spare duvet for the Hamlet').click()
  assert.ok(await page.getByLabel('Heading').isDisabled(), 'housekeeping: cannot change the office\'s to-do')
  assert.strictEqual(await page.getByRole('button', { name: 'Save' }).count(), 0)
  await page.getByText('Close', { exact: true }).click()
  await page.getByRole('button', { name: 'Mark done: Spare duvet for the Hamlet' }).click()
  for (let i = 0; i < 40 && appData.hbf_todos_v1.find((t) => t.id === 'h1').state !== 'done'; i++) await page.waitForTimeout(100)
  assert.strictEqual(appData.hbf_todos_v1.find((t) => t.id === 'h1').doneBy, 'Karina')
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
