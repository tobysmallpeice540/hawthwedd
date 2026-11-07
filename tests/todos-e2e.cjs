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
    categories: [{ id: 'admin', name: 'Admin' }, { id: 'maint', name: 'Maintenance' }, { id: 'to-buy', name: 'To buy' }],
    projects: [{ id: 'upkeep', name: 'Upkeep' }],
    items: [
      { id: 'td_old', title: 'Clear the gutters on the Hamlet', priority: 'week', setOn: addDays(today, -10), who: 'role:admin',
        area: 'hamlet', project: null, createdAt: '2026-10-01T09:00:00Z', createdById: ME },
      { id: 'td_bar', title: 'Restock the ice machine', priority: 'three', setOn: addDays(today, -2), who: 'role:bar', area: 'grain-store',
        createdAt: '2026-11-01T09:00:00Z' },
      { id: 'td_mine', title: 'Ring the farrier', priority: 'three', setOn: addDays(today, -2), who: 'person:' + ME, createdAt: '2026-11-02T09:00:00Z', createdById: ME },
      { id: 'td_someday', title: 'Paint the gate', priority: 'eventually', who: 'person:' + ME, createdAt: '2026-11-02T09:00:00Z', createdById: ME,
        category: 'maint', area: 'farm' },
      { id: 'td_gloves', title: 'Work gloves', priority: 'eventually', setOn: today, who: 'anyone', tags: ['to-buy', 'maint'],
        project: 'upkeep', createdAt: '2026-11-03T08:00:00Z', createdById: ME },
      { id: 'td_bins', title: 'Bins out', priority: 'eventually', repeat: 'weekly', deadline: addDays(today, 3), setOn: today, who: 'anyone',
        category: 'maint', project: 'upkeep', createdAt: '2026-11-03T09:00:00Z', createdById: ME },
      { id: 'td_shower', title: 'Fix the Hamlet shower', priority: 'event', setOn: today, eventOn: addDays(today, 5), who: 'anyone', area: 'hamlet',
        category: 'maint', project: 'upkeep', createdAt: '2026-11-03T10:00:00Z', createdById: ME },
      // Rosanna's private one, which the database never sends to Toby.
      { id: 'td_rosa', title: 'Rosanna private', priority: 'three', setOn: today, who: 'role:admin', private: true, createdById: ROS },
    ],
  })
  const files = {}
  // A Hamlet check-in in five days, for "Before next event".
  const checkIn = addDays(today, 5)
  const { page, errors, close } = await openStaff({
    distDir, viewport,
    appData: { hbf_accom_v1: [{ id: 'acc1', guestName: 'Jones', status: 'confirmed', bookingType: 'Standard',
      stays: [{ propertyId: 'hamlet', checkIn: checkIn, checkOut: addDays(checkIn, 2) }], payments: [] }] },
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
  // One line at the top (7 Nov, Toby): To-do, the count, Projects & areas —
  // no "+ New to-do" (the top bar's + To-do adds one) and no Board / List.
  const tops = await page.evaluate(() => {
    const h = document.querySelector('h1.hb-title'); const row = h.parentElement
    const sub = row.querySelector('.hb-sub'); const b = [...row.querySelectorAll('button')].find((x) => x.textContent === 'Projects & areas')
    const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 }
    return { h: mid(h), sub: sub && mid(sub), b: b && mid(b), subText: sub && sub.textContent, right: b && b.getBoundingClientRect().right, vw: innerWidth }
  })
  assert.ok(tops.sub && tops.b && Math.abs(tops.h - tops.sub) < 14 && Math.abs(tops.h - tops.b) < 14 && tops.right <= tops.vw,
    label + ': title, count and Projects & areas on one line: ' + JSON.stringify(tops))
  assert.ok(/to do/.test(tops.subText), label + ': count beside the title')
  assert.strictEqual(await page.getByRole('button', { name: '+ New to-do' }).count(), 0, label + ': no + New to-do on the page')
  assert.strictEqual(await page.getByRole('group', { name: 'Show as' }).count(), 0, label + ': Board / List not on the page')
  // For, Area and Columns on one line, inside the screen — even with a filter on.
  const filterLine = async (what) => {
    const f = await page.getByRole('group', { name: 'Filters' }).evaluate((g) => {
      const mids = [...g.querySelectorAll('select, button')].map((el) => { const r = el.getBoundingClientRect(); return { mid: r.top + r.height / 2, right: r.right } })
      return { spread: Math.max(...mids.map((m) => m.mid)) - Math.min(...mids.map((m) => m.mid)), right: Math.max(...mids.map((m) => m.right)), vw: innerWidth, n: mids.length }
    })
    assert.ok(f.spread < 6 && f.right <= f.vw, label + ': filters on one line ' + what + ': ' + JSON.stringify(f))
  }
  await filterLine('')
  await page.locator('#todo-f-who').selectOption('mine')
  await page.getByRole('button', { name: 'Clear filters' }).waitFor()
  await filterLine('with Clear')
  await page.getByRole('button', { name: 'Clear filters' }).click()

  // ── The board: one column per project, round ticks, filters ──
  const board = page.getByRole('region', { name: 'To-do board' })
  await board.waitFor()
  // The board scrolls inside itself; the page never goes wider than the screen
  // (7 Nov: on an iPhone the page scrolled sideways and the edit sheet sat off
  // to one side).
  const widths = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth, wide = []
    document.querySelectorAll('body *').forEach((el) => {
      if (el.closest('[aria-label="To-do board"]')) return
      const r = el.getBoundingClientRect()
      if (r.right > vw + 1) wide.push(el.tagName + ' ' + Math.round(r.width) + ' ' + (el.getAttribute('style') || '').slice(0, 90))
    })
    return { vw, sw: document.documentElement.scrollWidth, wide: wide.slice(0, 6) }
  })
  if (process.env.TODO_PROBE) console.log(label, JSON.stringify(widths, null, 1))
  assert.ok(widths.sw <= widths.vw, label + ': page wider than the screen: ' + JSON.stringify(widths))
  assert.deepStrictEqual(await board.locator('section').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))), ['Upkeep', 'No project'],
    label + ': columns by project')
  const shower = board.locator('[data-todo-id="td_shower"]')
  await shower.getByText('Before check-in').waitFor()
  assert.ok(await shower.getByText(new RegExp(String(Number(checkIn.slice(8))) + ' ')).isVisible(), label + ': due on the Hamlet check-in')
  assert.ok(await board.locator('[data-todo-id="td_bins"]').getByText(/Every week/).isVisible(), label + ': repeat shown')
  if (shots) await page.screenshot({ path: path.join(shots, label + '-board.png'), fullPage: false })
  // Tags: highlight one, then a second as well (either will do).
  const tagBar = page.getByRole('group', { name: 'Tags' })
  await tagBar.getByRole('button', { name: 'To buy' }).click()
  assert.deepStrictEqual(await board.locator('[data-todo-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-todo-id')).sort()),
    ['td_gloves'], label + ': one tag')
  await tagBar.getByRole('button', { name: 'Maintenance' }).click()
  assert.deepStrictEqual(await board.locator('[data-todo-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-todo-id')).sort()),
    ['td_bins', 'td_gloves', 'td_shower', 'td_someday'], label + ': two tags highlighted')
  assert.strictEqual(await tagBar.getByRole('button', { name: 'All' }).getAttribute('aria-pressed'), 'false')
  await tagBar.getByRole('button', { name: 'To buy' }).click()
  assert.deepStrictEqual(await board.locator('[data-todo-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-todo-id')).sort()),
    ['td_bins', 'td_gloves', 'td_shower', 'td_someday'], label + ': gloves stay, tagged Maintenance too')
  // Columns by tag: a to-do with two tags is in both.
  await page.locator('#todo-f-by').selectOption('tag')
  assert.deepStrictEqual(await board.locator('section').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))), ['Maintenance', 'To buy'],
    label + ': tag columns')
  await page.locator('#todo-f-by').selectOption('project')
  await page.locator('#todo-f-area').selectOption('farm')
  assert.deepStrictEqual(await board.locator('section').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))), ['No project'],
    label + ': empty columns go')
  // A new one from a filtered board starts with that tag and area.
  await page.getByRole('button', { name: 'New to-do in No project' }).click()
  const sheetTags = page.getByRole('dialog').getByRole('group', { name: 'Tags' })
  assert.strictEqual(await sheetTags.getByRole('button', { name: /Maintenance/ }).getAttribute('aria-pressed'), 'true')
  assert.strictEqual(await page.getByRole('dialog').getByRole('group', { name: 'Areas' }).getByRole('button', { name: /Farm/ }).getAttribute('aria-pressed'), 'true')
  // The sheet never slides sideways inside itself (7 Nov, on an iPhone).
  const sheetBox = await page.getByRole('dialog').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, x: el.getBoundingClientRect().left, ox: getComputedStyle(el).overflowX }))
  assert.ok(sheetBox.sw <= sheetBox.cw && sheetBox.x >= 0 && sheetBox.ox === 'hidden', label + ': sheet fits: ' + JSON.stringify(sheetBox))
  await page.getByText('Cancel', { exact: true }).click()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  // "Before next event", set now, is fixed to the next Hamlet check-in.
  await page.locator('.hb-top-todo').click()
  await page.getByLabel('Heading').fill('Hamlet bulbs')
  // Two areas: the Hamlet's check-in is before any Grain Store event, so it wins.
  await page.getByRole('dialog').getByRole('group', { name: 'Areas' }).getByRole('button', { name: 'The Hamlet' }).click()
  await page.getByRole('dialog').getByRole('group', { name: 'Areas' }).getByRole('button', { name: 'Glamping' }).click()
  // Two tags on one to-do.
  await page.getByRole('dialog').getByRole('group', { name: 'Tags' }).getByRole('button', { name: 'Maintenance' }).click()
  await page.getByRole('dialog').getByRole('group', { name: 'Tags' }).getByRole('button', { name: 'To buy' }).click()
  await page.getByRole('radio', { name: 'Before next event' }).click()
  await page.getByText(/the next check-in at The Hamlet or Glamping: due/).waitFor()
  await page.getByRole('button', { name: 'Add to-do' }).click()
  await page.getByLabel('Heading').waitFor({ state: 'detached' })
  const bulbs = [...db.items.values()].find((t) => t.title === 'Hamlet bulbs')
  assert.strictEqual(bulbs.eventOn, checkIn, label + ': event day fixed when set')
  assert.deepStrictEqual(bulbs.tags, ['maint', 'to-buy'], label + ': two tags saved')
  assert.deepStrictEqual(bulbs.areas, ['hamlet', 'glamping'], label + ': two areas saved')
  await board.locator('[data-todo-id="' + bulbs.id + '"]').getByText('Before check-in').waitFor()
  db.items.delete(bulbs.id)

  // Urgent: star a card from the board; it goes first, gets a filter, and is on
  // the home card whatever its day.
  await board.locator('[data-todo-id="td_someday"]').getByRole('button', { name: 'Urgent: Paint the gate' }).click()
  await until(() => item('td_someday').urgent === true, 'star from the card')
  await page.waitForFunction(() => {
    const c = document.querySelector('[aria-label="To-do board"] section[aria-label="No project"] [data-todo-id]')
    return c && c.getAttribute('data-todo-id') === 'td_someday'
  }, null, { timeout: 5000 }).catch(() => {})
  assert.strictEqual(await board.locator('section[aria-label="No project"] [data-todo-id]').first().getAttribute('data-todo-id'), 'td_someday',
    label + ': urgent first in its column')
  await page.getByRole('group', { name: 'Tags' }).getByRole('button', { name: /Urgent/ }).click()
  assert.deepStrictEqual(await board.locator('[data-todo-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-todo-id'))), ['td_someday'],
    label + ': urgent filter')
  await page.getByRole('group', { name: 'Tags' }).getByRole('button', { name: /Urgent/ }).click()
  // The edit sheet's toggle takes it off again.
  await board.locator('[data-todo-id="td_someday"] [role=button]').click()
  await page.getByRole('dialog').getByRole('button', { name: /Urgent$/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: /Mark urgent$/ }).waitFor()
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByLabel('Heading').waitFor({ state: 'detached' })
  assert.strictEqual(item('td_someday').urgent, false, label + ': unstarred in the sheet')

  // The sheet says which day a repeat keeps, and when the next one will be.
  await board.locator('[data-todo-id="td_bins"] [role=button]').click()
  const binsDay = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(addDays(today, 3) + 'T00:00:00Z').getUTCDay()]
  await page.getByRole('dialog').getByText('Every ' + binsDay + '. When it is ticked the next one appears', { exact: false }).waitFor()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.getByLabel('Heading').waitFor({ state: 'detached' })

  // A repeat, ticked, leaves the next one.
  await board.getByRole('button', { name: 'Mark done: Bins out' }).click()
  await until(() => item('td_bins').state === 'done' && item('td_bins').nextId, 'repeat ticked')
  const nextBins = item(item('td_bins').nextId)
  assert.strictEqual(nextBins.deadline, addDays(today, 10), label + ': next bins a week on')
  await board.locator('[data-todo-id="' + nextBins.id + '"]').waitFor()

  // Overdue goes first, whatever its priority.
  await page.locator('#todo-f-by').selectOption('priority')
  const firstGroup = await page.locator('section').first().getAttribute('aria-label')
  assert.strictEqual(firstGroup, 'Overdue', label + ': overdue first')
  assert.ok(await page.locator('section[aria-label="Overdue"]').getByText('Clear the gutters on the Hamlet').isVisible())

  // A new project from the edit sheet, then a to-do in it with a photo.
  await page.locator('.hb-top-todo').click()
  await page.getByLabel('Heading').fill('Replace the cinema barn projector bulb')
  await page.getByRole('radio', { name: '1 month' }).click()
  await page.getByRole('radio', { name: 'Rosanna' }).click()
  await page.getByRole('dialog').getByRole('group', { name: 'Areas' }).getByRole('button', { name: 'Cinema Barn' }).click()
  page.once('dialog', (d) => d.accept('Cinema refit'))
  await page.locator('#todo-project').selectOption('__new')
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
  assert.deepStrictEqual(added.areas, ['cinema-barn']); assert.strictEqual(added.project, 'cinema-refit')
  assert.strictEqual(added.photos.length, 1)
  assert.ok(added.photos[0].path.startsWith(added.id + '/'), label + ': photo filed under its to-do')
  assert.ok(files[added.photos[0].path], label + ': photo stored in the private bucket')
  assert.ok(db.lists.project.some((p) => p.id === 'cinema-refit'))

  // Columns by project.
  await page.locator('#todo-f-by').selectOption('project')
  await page.locator('section[aria-label="Cinema refit"]').getByText('Replace the cinema barn projector bulb').waitFor()
  if (shots) await page.screenshot({ path: path.join(shots, label + '-project.png'), fullPage: true })

  // Tick from the list.
  await page.getByRole('button', { name: 'Mark done: Clear the gutters on the Hamlet' }).click()
  await until(() => item('td_old').state === 'done', 'tick')
  assert.strictEqual(item('td_old').doneBy, 'Toby')

  // Done with a comment, from More.
  await page.locator('#todo-f-by').selectOption('priority')
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
  // The list, grouped by person: Board / List is in Projects & areas.
  await page.getByRole('button', { name: 'Projects & areas' }).click()
  await page.getByRole('dialog').getByRole('group', { name: 'Show as' }).getByRole('button', { name: 'List', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  await page.locator('#todo-f-by').selectOption('person')
  assert.strictEqual(await page.getByRole('region', { name: 'To-do board' }).count(), 0, label + ': list view')
  if (shots) await page.screenshot({ path: path.join(shots, label + '-person.png'), fullPage: true })

  // Delete takes a second press and removes the photo.
  await page.getByText('Replace the cinema barn projector bulb').click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Press again to delete' }).click()
  await until(() => !db.items.has(added.id), 'delete')
  await until(() => !files[added.photos[0].path], 'photo taken down')

  // Areas & projects: rename one; in-use ones cannot be deleted.
  await page.getByRole('button', { name: 'Projects & areas' }).click()
  // Categories are kept there too.
  await page.getByPlaceholder('New tag').fill('Garden')
  await page.getByPlaceholder('New tag').press('Enter')
  await until(() => db.lists.category.some((c) => c.name === 'Garden'), 'add a tag')
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
