// tests/timeline-print-e2e.cjs
//
// "Print for your suppliers" on the portal's Timeline, in the built portal with
// Supabase faked: the sheet opens in a new window with the day, the people to
// ring and the suppliers; if the suppliers cannot be read it still prints and
// the page says what was left out.
//
//   npx vite build --outDir "$HOME/dist-check" --emptyOutDir && node tests/timeline-print-e2e.cjs

const os = require('os'), path = require('path')
const { openPortal, baseRpc, goTab } = require('./portal-harness.cjs')
const DIST = process.env.DIST || path.join(os.homedir(), 'dist-check')

let passes = 0; const fails = []
const check = (n, ok, d) => { if (ok) passes++; else fails.push(n + (d ? ': ' + d : '')) }

const TL = { ok: true, event_type: 'Wedding', ceremony_time: '14:00:00',
  days: [{ day_key: 'event', label: 'The day', fixed: [{ time: '23:45:00', title: 'Bar closes' }] }],
  blocks: [{ id: 'b1', day_key: 'event', start_time: '14:00:00', duration_min: 45, title: 'Ceremony', notes: 'Orchard', supplier_name: null, contact_name: 'Uncle Bob', locked: false, rel_minutes: 0, prompts: '', answers: [] }],
  contacts: [{ id: 'c1', name: 'Uncle Bob', role: 'Usher' }], suppliers: [] }

;(async () => {
  let h = await openPortal({ distDir: DIST, rpc: baseRpc({
    wp_get_timeline: () => TL,
    wp_get_key_contacts: () => ({ ok: true, contacts: [{ id: 'c1', name: 'Uncle Bob', role: 'Usher', phone: '07700 900123' }] }),
    wp_get_suppliers: () => ({ ok: true, categories: [{ slug: 'music', label: 'Music' }], directory: [],
      chosen: [{ id: 's1', supplier_id: 'x', name: 'Band & Co', category: 'music', phone: '01234', email: 'jo@band.test' }] }),
  }) })
  await goTab(h.page, 'Timeline')
  const btn = h.page.getByRole('button', { name: 'Print for your suppliers' })
  await btn.waitFor({ timeout: 8000 })
  const [sheet] = await Promise.all([h.context.waitForEvent('page'), btn.click()])
  await sheet.waitForFunction(() => document.body && /Ceremony/.test(document.body.innerText), null, { timeout: 8000 })
  const text = await sheet.locator('body').innerText()
  check('S1 the sheet opens with the day', /Ceremony/.test(text) && /Bar closes/.test(text) && /14:00–14:45/.test(text), text.slice(0, 200))
  check('S2 people to ring with their phone', /On the day, ring/.test(text) && /07700 900123/.test(text))
  check('S3 suppliers with details', /Band & Co/.test(text) && /jo@band\.test/.test(text) && /Music/.test(text))
  check('S4 titled for the couple', (await sheet.title()) === 'Sam & Alex — timeline', await sheet.title())
  check('S5 no page errors', h.errors.length === 0, h.errors.join(' | '))
  await h.close()

  h = await openPortal({ distDir: DIST, rpc: baseRpc({
    wp_get_timeline: () => TL,
    wp_get_key_contacts: () => ({ ok: true, contacts: [] }),
    wp_get_suppliers: () => { throw new Error('down') },
  }) })
  await goTab(h.page, 'Timeline')
  const btn2 = h.page.getByRole('button', { name: 'Print for your suppliers' })
  await btn2.waitFor({ timeout: 8000 })
  const [sheet2] = await Promise.all([h.context.waitForEvent('page'), btn2.click()])
  await sheet2.waitForFunction(() => document.body && /Ceremony/.test(document.body.innerText), null, { timeout: 8000 })
  check('F1 still prints without the suppliers', !/Suppliers/.test(await sheet2.locator('body').innerText()))
  await h.page.getByText("Printed without your suppliers' details", { exact: false }).waitFor({ timeout: 5000 })
  check('F2 and says what it left out', true)
  await h.close()

  if (fails.length) { console.log(passes + ' passed, FAILED:\n  ' + fails.join('\n  ')); process.exit(1) }
  console.log('ALL ' + passes + ' ASSERTIONS PASSED')
})().catch((e) => { console.error(e); process.exit(1) })
