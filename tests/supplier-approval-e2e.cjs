// tests/supplier-approval-e2e.cjs
//
// Events → Portal settings → Suppliers, in the built app with Supabase faked
// (tests/portal-harness.cjs → openStaff):
//   · a couple's own supplier is listed under "Couples' suppliers" with the
//     wedding that added it, unticked;
//   · changing the category and the line, then ticking "Approved for sharing",
//     saves the review FIRST and then approves — so what is approved is what
//     is on screen;
//   · unticking reports when other weddings keep it;
//   · before the migration, ticking says which database change is needed.
//
//   npx vite build --outDir "$HOME/dist-check" --emptyOutDir && node tests/supplier-approval-e2e.cjs

const os = require('os'), path = require('path')
const { openStaff } = require('./portal-harness.cjs')
const DIST = process.env.DIST || path.join(os.homedir(), 'dist-check')

let passes = 0; const fails = []
const check = (n, ok, d) => { if (ok) passes++; else fails.push(n + (d ? ': ' + d : '')) }

const BOOKINGS = [{ id: 501, couple: 'Jo & Sam', date: '2027-05-01', status: 'Confirmed', eventType: 'Wedding (Peak)' }]
const sup = (o) => Object.assign({ contact_name: 'Pat', email: 'pat@x.test', phone: null, website: null, blurb: null, pli_held: false,
  pli_expires: null, internal_note: null, active: true, public_listed: false, share_offered_at: null, suppressed_at: null,
  promoted_from_event_id: null, promoted_at: null, used_by: 1 }, o)

async function openSuppliers(rpc) {
  const h = await openStaff({ distDir: DIST, appData: { hawthbush_bookings_v6: BOOKINGS }, rpc })
  await h.page.locator('nav, aside').getByText('Events', { exact: true }).first().click()
  await h.page.getByText('Portal settings', { exact: true }).first().click()
  await h.page.getByRole('tab', { name: /Supplier directory/ }).first().click()
  await h.page.getByText('Couples’ suppliers', { exact: false }).first().waitFor({ timeout: 8000 })
  return h
}

;(async () => {
  let state = [
    sup({ id: 's1', name: 'Couple Snaps', category: 'other', owner_event_id: 501, share_offered_at: '2026-10-20T10:00:00Z' }),
    sup({ id: 's2', name: 'Venue Flowers', category: 'flowers', owner_event_id: null, contact_name: null }),
  ]
  const order = []
  let h = await openSuppliers({
    wp_admin_suppliers: () => ({ ok: true, suppliers: state }),
    wp_admin_review_supplier: (a) => { order.push('review'); state = state.map((x) => x.id === a.p_id ? Object.assign({}, x, { category: a.p_category, blurb: a.p_blurb, internal_note: a.p_internal_note }) : x); return { ok: true } },
    wp_admin_approve_supplier: (a) => {
      order.push('approve:' + a.p_approve)
      state = state.map((x) => x.id !== a.p_id ? x : a.p_approve
        ? Object.assign({}, x, { owner_event_id: null, promoted_from_event_id: 501, promoted_at: '2026-10-25T10:00:00Z' })
        : Object.assign({}, x, { active: false }))
      return a.p_approve ? { ok: true, approved: true } : { ok: true, approved: false, mode: 'withdrawn', kept_by: 2 }
    },
  })
  const page = h.page
  const row = page.locator('[data-supplier="s1"]')
  const txt = await row.innerText()
  check('S1 the couple\'s supplier is listed with the wedding that added it', /Couple Snaps/.test(txt) && /Jo & Sam/.test(txt), txt)
  check('S2 and shows the couple offered them', /OFFERED BY COUPLE/.test(txt))
  check('S3 not yet approved', !(await row.getByLabel('Approved for sharing').isChecked()))
  check('S4 the venue\'s own supplier is not in the couples\' list', (await page.locator('[data-supplier="s2"]').count()) === 0)

  await row.locator('select').selectOption('photography')
  await row.getByPlaceholder(/documentary/).fill('Shot two weddings here')
  await row.getByLabel('Approved for sharing').check()
  await page.waitForTimeout(600)
  check('S5 the review is saved before the approval', order.join(',') === 'review,approve:true', order.join(','))
  check('S6 with the new category and line', state[0].category === 'photography' && state[0].blurb === 'Shot two weddings here', JSON.stringify(state[0]))
  const after = await page.locator('[data-supplier="s1"]').innerText()
  check('S7 shown as shared', /SHARED/.test(after), after)
  const dir = await page.locator('body').innerText()
  check('S8 and appears in the directory, marked as from the couple', /from Jo & Sam/.test(dir))

  await page.locator('[data-supplier="s1"]').getByLabel('Approved for sharing').uncheck()
  await page.waitForTimeout(600)
  const w = await page.locator('[data-supplier="s1"]').innerText()
  check('S9 unticking says the weddings that chose them keep them', /2 other weddings that chose them keep them/.test(w), w)
  check('S10 no page errors', h.errors.length === 0, h.errors.join(' | '))
  await h.close()

  // Before the migration
  h = await openSuppliers({ wp_admin_suppliers: () => ({ ok: true, suppliers: [sup({ id: 's1', name: 'Couple Snaps', category: 'other', owner_event_id: 501 })] }) })
  await h.page.locator('[data-supplier="s1"]').getByLabel('Approved for sharing').click()
  await h.page.waitForTimeout(600)
  check('M1 a database without the function says what is needed',
    (await h.page.getByText('2026-10-25o-supplier-approval.sql', { exact: false }).count()) > 0)
  check('M2 and raises no red failure banner', !(await h.page.getByText(/failed \(404\)/).count()))
  await h.close()

  console.log(passes + ' passed, ' + fails.length + ' failed')
  fails.forEach((f) => console.log('  FAIL ' + f))
  process.exit(fails.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
