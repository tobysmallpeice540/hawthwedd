// The Handyman login and Other users' view (7 Nov 2026, Toby).
//
// A handyman is role "admin" with profiles.access "handyman" (migration
// 2026-11-07b). He gets the office app less:
//   · Settings, Enquiries and Other users' view
//   · Events → Invoices and Portal settings
//   · Lettings → Report, Import and Settings
//   · Box Office → Settings
//   · every report but Rota Overview and Event Rota
//   · checklist set-up
// A page he cannot have, reached by a link, says so instead of opening.
//
// An admin's "Other users' view" opens on Housekeeping; a dropdown changes it to
// Handyman (the whole app with his limits, a bar across every page) or Bar
// (the bar login's screens). Back to admin leaves.
//
//   npx vite build --outDir "$HOME/dist-check" --emptyOutDir && node tests/handyman-e2e.cjs

const os = require('os'), path = require('path')
const { openStaff } = require('./portal-harness.cjs')
const DIST = process.env.DIST || path.join(os.homedir(), 'dist-check')

let passes = 0; const fails = []
const check = (n, ok, d) => { if (ok) passes++; else fails.push(n + (d ? ': ' + d : '')) }

async function navItems(pg) {
  return (await pg.locator('.hb-nav-item span:first-of-type').allInnerTexts()).map((t) => t.trim())
}
async function subItems(pg) {
  return (await pg.locator('.hb-nav-subitem span:first-of-type').allInnerTexts()).map((t) => t.trim())
}
async function openNav(pg, label) {
  await pg.locator('.hb-nav-item', { hasText: label }).first().click()
  await pg.waitForTimeout(300)
}

async function stub(c) {
  await c.page.route('**/.netlify/functions/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"events":[],"orders":[]}' }))
}

;(async () => {
  // ── The handyman's own login ──
  try {
    const c = await openStaff({ distDir: DIST, rpc: {
      my_profile: () => ({ id: '00000000-0000-4000-8000-00000000beef', role: 'admin', access: 'handyman', active: true, name: 'Archie' }),
    } })
    try {
      await stub(c)
      const pg = c.page
      await pg.locator('.hb-nav-item').first().waitFor({ timeout: 15000 })
      const top = await navItems(pg)
      check('handyman: no Settings', top.indexOf('Settings') === -1, top.join('|'))
      check('handyman: no Enquiries', top.indexOf('Enquiries') === -1, top.join('|'))
      check("handyman: no Other users' view", top.indexOf("Other users' view") === -1, top.join('|'))
      check('handyman: keeps Events, Lettings, Viewings, Box Office, Bar, Reports, Checklists, To-do',
        ['Events', 'Lettings', 'Viewings', 'Box Office', 'Bar', 'Reports', 'Checklists', 'To-do'].every((x) => top.indexOf(x) !== -1), top.join('|'))

      await openNav(pg, 'Events')
      let kids = await subItems(pg)
      check('handyman: Events has no Invoices or Portal settings', kids.indexOf('Invoices') === -1 && kids.indexOf('Portal settings') === -1, kids.join('|'))
      check('handyman: Events keeps All events and the calendar', kids.indexOf('All events') !== -1 && kids.indexOf('Events calendar') !== -1, kids.join('|'))

      await openNav(pg, 'Lettings')
      kids = await subItems(pg)
      check('handyman: Lettings is Calendar and Bookings only', kids.join('|') === 'Calendar|Bookings', kids.join('|'))

      await openNav(pg, 'Box Office')
      kids = await subItems(pg)
      check('handyman: Box Office has no Settings', kids.indexOf('Settings') === -1 && kids.indexOf('Events') !== -1, kids.join('|'))

      await openNav(pg, 'Reports')
      kids = await subItems(pg)
      check('handyman: Reports is the two rota reports', kids.join('|') === 'Rota Overview|Event Rota', kids.join('|'))
      const crumbs = await pg.locator('.hb-crumbs').innerText()
      check('handyman: Reports opens on Rota Overview', /Rota Overview/.test(crumbs), crumbs)

      await openNav(pg, 'Checklists')
      check('handyman: no checklist set-up button', (await pg.getByRole('button', { name: 'Set up checklists' }).count()) === 0)

      check('handyman: no page errors', c.errors.length === 0, c.errors.join(' | '))
    } finally { await c.close() }
  } catch (e) { fails.push('handyman run: ' + e.message) }

  // ── An admin's Other users' view ──
  try {
    const c = await openStaff({ distDir: DIST })
    try {
      await stub(c)
      const pg = c.page
      await pg.locator('.hb-nav-item').first().waitFor({ timeout: 15000 })
      const top = await navItems(pg)
      check("admin: Other users' view in the menu (not Housekeeper's view)", top.indexOf("Other users' view") !== -1 && top.indexOf("Housekeeper's view") === -1, top.join('|'))
      check('admin: Settings and Enquiries still there', top.indexOf('Settings') !== -1 && top.indexOf('Enquiries') !== -1)

      await openNav(pg, "Other users' view")
      const sel = pg.getByRole('combobox', { name: 'Whose view' })
      await sel.waitFor({ timeout: 10000 })
      check('other: opens on Housekeeping', (await sel.inputValue()) === 'cleaner')
      let body = await pg.locator('body').innerText()
      check('other: housekeeping shell and note', /Housekeeping view/.test(body) && /saved for real/.test(body))
      const opts = await sel.locator('option').allInnerTexts()
      check('other: the three views', opts.join('|') === 'Housekeeping view|Handyman view|Bar view', opts.join('|'))

      await sel.selectOption('bar')
      await pg.getByText('Bar Management').first().waitFor({ timeout: 10000 })
      body = await pg.locator('body').innerText()
      check('other: bar view shows the bar tabs', /Ticket Check-in/.test(body) && /Bar view/.test(body), body.slice(0, 300))
      check('other: no Sign out while looking', (await pg.getByRole('button', { name: 'Sign out' }).count()) === 0)

      await pg.getByRole('combobox', { name: 'Whose view' }).selectOption('handyman')
      await pg.locator('strong', { hasText: 'Handyman view' }).waitFor({ timeout: 10000 })
      const htop = await navItems(pg)
      check('other: handyman view uses his menu', htop.indexOf('Settings') === -1 && htop.indexOf('Enquiries') === -1, htop.join('|'))
      await openNav(pg, 'Lettings')
      check('other: handyman banner stays on every page', (await pg.locator('strong', { hasText: 'Handyman view' }).count()) === 1)

      await pg.getByRole('button', { name: '← Back to admin' }).click()
      await pg.waitForTimeout(300)
      const back = await navItems(pg)
      check('other: back to admin gives the full menu again', back.indexOf('Settings') !== -1 && back.indexOf('Enquiries') !== -1, back.join('|'))
      check('other: back on the page you were on', (await pg.locator('.hb-crumbs').innerText()).indexOf('Lettings') !== -1)

      // Opened again, it is Housekeeping again whatever was chosen last.
      await openNav(pg, "Other users' view")
      await pg.getByRole('combobox', { name: 'Whose view' }).waitFor({ timeout: 10000 })
      check('other: always opens on Housekeeping', (await pg.getByRole('combobox', { name: 'Whose view' }).inputValue()) === 'cleaner')
      check('admin: no page errors', c.errors.length === 0, c.errors.join(' | '))
    } finally { await c.close() }
  } catch (e) { fails.push('admin run: ' + e.message) }

  console.log(passes + ' passed, ' + fails.length + ' failed')
  fails.forEach((f) => console.log('  FAIL ' + f))
  process.exit(fails.length ? 1 : 0)
})()
