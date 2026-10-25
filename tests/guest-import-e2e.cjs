// tests/guest-import-e2e.cjs
//
// The guest import, in the built portal with Supabase faked (portal-harness):
//   · a Bridebook-style CSV is previewed through wp_merge_guests (p_apply false)
//     before anything is saved, with the counts and names it returns;
//   · Save sends the same rows with p_apply true, including rsvp and notes;
//   · against an older database (no wp_merge_guests) it falls back to
//     wp_import_guests and still adds the list.
//
//   npx vite build --outDir "$HOME/dist-check" --emptyOutDir && node tests/guest-import-e2e.cjs

const os = require('os'), path = require('path')
const { openPortal, baseRpc, goTab } = require('./portal-harness.cjs')
const DIST = process.env.DIST || path.join(os.homedir(), 'dist-check')

let passes = 0; const fails = []
const check = (n, ok, d) => { if (ok) passes++; else fails.push(n + (d ? ': ' + d : '')) }

const CSV = 'First Name,Last Name,RSVP Status,Dietary Requirements\nAda,Lovelace,Attending,Vegan\nTom,Thumb,Declined,\nNew,Person,Attending,'

const guests = () => ({ ok: true, numbers: {}, derived: {}, tables: [],
  guests: [{ id: 'g1', list: 'seated', first_name: 'Ada', last_name: 'Lovelace', age_band: 'adult', rsvp: null, role: null, sort: 0 },
           { id: 'g2', list: 'seated', first_name: 'John', last_name: 'Smith', age_band: 'adult', rsvp: null, role: null, sort: 1 }] })

;(async () => {
  // ── with the merge function ─────────────────────────────────────────────
  let applied = null
  const merge = (a) => {
    if (a.p_apply) applied = a
    return { ok: true, applied: a.p_apply, new: 1, updated: 1, unchanged: 0, declined: 1, missing: 1,
      new_names: ['New Person'], updated_lines: ['Ada Lovelace — reply: coming; notes: Vegan'],
      declined_names: ['Tom Thumb'], missing_names: ['John Smith'] }
  }
  let h = await openPortal({ distDir: DIST, rpc: baseRpc({ wp_get_guests: guests, wp_merge_guests: merge }) })
  const { page } = h
  await goTab(page, 'Guests')
  await page.getByRole('button', { name: 'Paste or upload a list' }).first().click()
  await page.locator('textarea').first().fill(CSV)
  await page.getByText('1 new', { exact: false }).waitFor({ timeout: 5000 })
  const box = await page.locator('.merge-preview').innerText()
  check('P1 preview counts shown', /1\s*new/.test(box) && /1\s*updated/.test(box) && /1\s*not coming/.test(box) && /1\s*on your list but not in this one/.test(box), box)
  const found = await page.locator('.alert-ok').first().innerText()
  check('P2 says which columns it read', /replies/.test(found) && /dietary needs/.test(found), found)
  const prev = h.calls.filter((c) => c.fn === 'wp_merge_guests')
  check('P3 preview asked with p_apply false and the parsed rows', prev.length >= 1 && prev[0].args.p_apply === false &&
    prev[0].args.p_list === 'seated' && prev[0].args.p_rows.length === 3 && prev[0].args.p_rows[0].rsvp === 'yes' &&
    prev[0].args.p_rows[0].access_needs === 'Vegan' && prev[0].args.p_rows[1].rsvp === 'no', JSON.stringify(prev[0] && prev[0].args))
  check('P4 nothing saved yet', applied === null)
  const btn = page.getByRole('button', { name: /Add 1 · update 1/ })
  check('P5 button says what will happen', await btn.count() === 1)
  await btn.click()
  await page.waitForTimeout(400)
  check('P6 save sends p_apply true with the same rows', applied && applied.p_apply === true && applied.p_rows.length === 3)
  check('P7 the import closes after saving', await page.locator('.merge-preview').count() === 0)
  check('P8 no page errors', h.errors.length === 0, h.errors.join(' | '))
  await h.close()

  // ── nothing to change ───────────────────────────────────────────────────
  h = await openPortal({ distDir: DIST, rpc: baseRpc({ wp_get_guests: guests,
    wp_merge_guests: () => ({ ok: true, new: 0, updated: 0, unchanged: 3, declined: 0, missing: 0, new_names: [], updated_lines: [], declined_names: [], missing_names: [] }) }) })
  await goTab(h.page, 'Guests')
  await h.page.getByRole('button', { name: 'Paste or upload a list' }).first().click()
  await h.page.locator('textarea').first().fill(CSV)
  await h.page.getByRole('button', { name: 'Nothing to change' }).waitFor({ timeout: 5000 })
  check('N1 up-to-date list cannot be saved again', await h.page.getByRole('button', { name: 'Nothing to change' }).isDisabled())
  await h.close()

  // ── an older database: add only ─────────────────────────────────────────
  let oldImport = null
  h = await openPortal({ distDir: DIST, rpc: baseRpc({ wp_get_guests: guests, wp_import_guests: (a) => { oldImport = a; return { ok: true, added: 3 } } }) })
  await goTab(h.page, 'Guests')
  await h.page.getByRole('button', { name: 'Paste or upload a list' }).first().click()
  await h.page.locator('textarea').first().fill('Ada Lovelace\nGrace Hopper\nAlan Turing')
  const addBtn = h.page.getByRole('button', { name: 'Add 3' })
  await addBtn.waitFor({ timeout: 5000 })
  await addBtn.click()
  await h.page.waitForTimeout(400)
  check('O1 falls back to wp_import_guests', oldImport && oldImport.p_rows.length === 3 && oldImport.p_list === 'seated')
  check('O2 no page errors', h.errors.length === 0, h.errors.join(' | '))
  await h.close()

  if (fails.length) { console.log(passes + ' passed, FAILED:\n  ' + fails.join('\n  ')); process.exit(1) }
  console.log('ALL ' + passes + ' ASSERTIONS PASSED')
})().catch((e) => { console.error(e); process.exit(1) })
