// tests/contracts-e2e.cjs
//
// Contracts signed in the app, on screen (4 Nov 2026):
//   · the couple's Booking form page in the portal — read, fill in, sign;
//     "booking form only"; on a phone without sideways scrolling
//   · the event's Contract tab — send for signing
//   · Settings → Contracts — a template's own fields, saving, importing a Word file
// Runs the BUILT app with Supabase faked (tests/portal-harness.cjs).
//
//   npx vite build --outDir "$HOME/dist-check" --emptyOutDir && node tests/contracts-e2e.cjs

const path = require('path')
const os = require('os')
const fs = require('fs')
const { openPortal, openStaff, baseRpc, goTab } = require('./portal-harness.cjs')
const DIST = process.env.DIST || path.join(os.homedir(), 'dist-check')
const HOST = 'https://rkqbyisfmvwulsyxzwjz.supabase.co'
const ROOT = path.join(__dirname, '..')

let passes = 0; const fails = []
const check = (n, ok, d) => { if (ok) passes++; else fails.push(n + (d !== undefined ? ': ' + String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 300) : '')) }

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
const plus = (n) => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)

;(async () => {
  const D = await import(path.join(ROOT, 'src/shared/contractDoc.js'))
  const { DEFAULT_CONTRACT_TEMPLATE } = await import(path.join(ROOT, 'src/shared/contractTemplate.js'))
  const f = { eventName: 'Sam & Alex', eventType: 'Wedding (Peak)', eventDate: '2027-06-12', accessBefore: 'Midday to 4.30pm',
    accessDay: '10am to Midnight', accessAfter: '10am to 11.30am', maxGuests: '200', venueFee: '5670', nonStandard: '',
    amlyFee: '1050', amlyFrom: '2027-06-11', amlyTo: '2027-06-13', glampingFeePd: '1750', glampingFrom: '2027-06-12',
    glampingTo: '2027-06-13', glamping2Fee: '2675', glamping2From: '2027-06-11', glamping2To: '2027-06-13' }
  const parsed = D.parseContractTemplate(DEFAULT_CONTRACT_TEMPLATE)
  const acc = D.contractAccommodation(f)
  const body = { format: 1, title: D.contractTitle(parsed.nodes), event: { id: 222, name: 'Sam & Alex', date: '2027-06-12' },
    blocks: D.resolveContractNodes(parsed.nodes, { fields: f, event: { id: 222 }, hasAccommodation: true, today }).blocks,
    accommodation: acc, data: f, parties: { one: false, client1: 'Sam Smith', client2: 'Alex Jones' },
    venue: { company: 'Hawthbush Farm Ltd', name: 'Rosanna Greenwood', signed_at: '2026-11-04T10:00:00Z' } }

  // ── 1. The portal ─────────────────────────────────────────────────────────
  let answers = { client1Name: 'Sam Smith', client2Name: 'Alex Jones' }
  const saves = []
  const ctFor = () => ({ ok: true, booking_form_only: true, contract: {
    id: 'c-1', version: 1, status: 'out', body, body_sha256: 'x', one_signer: false, sent_at: '2026-11-04T10:00:00Z',
    pdf_ready: false, answers, locked: false, missing: D.contractMissing(body, false, answers), my_role: 'client1', can_sign: true,
    signers: [{ role: 'client1', name: 'Sam Smith', signed: false }, { role: 'client2', name: 'Alex Jones', signed: false }] } })
  for (const vp of [null, { width: 375, height: 780 }]) {
    const h = await openPortal({ distDir: DIST, viewport: vp || undefined, rpc: baseRpc({
      ct_my_contract: ctFor,
      wp_my_documents: () => ({ ok: true, contract: { status: 'Pending', sent_at: '2026-11-04T10:00:00Z' }, documents: [] }),
      ct_save_answers: (a) => { saves.push(a.p_answers); answers = Object.assign({}, answers, a.p_answers); return { ok: true, answers, missing: D.contractMissing(body, false, answers) } },
    }) })
    const page = h.page
    const signCalls = []
    await page.route('**/.netlify/functions/contract-sign', async (route) => {
      signCalls.push(JSON.parse(route.request().postData() || '{}'))
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ signed: true, complete: false }) })
    })
    const tag = vp ? 'phone ' : ''
    try {
      await page.getByText('Booking Form and Terms & Conditions').first().waitFor({ timeout: 15000 })
      check(tag + 'P1 a couple with a form to sign land on it', true)
      const menu = await page.locator('.side-list .tab').allInnerTexts()
      check(tag + 'P2 "booking form only" shows just the form and their documents', menu.map((x) => x.trim()).join('|') === 'Overview|Booking form|Documents', menu)
      if (vp) {
        const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        check('phone P3 the form fits a phone without sideways scrolling', wide <= 1, wide)
        await h.close()
        continue
      }
      check('P3 the sign button waits until everything is filled in', (await page.getByRole('button', { name: 'Sign the booking form' }).count()) === 0)
      check('P4 and says what is missing', /Before you can sign, please fill in: your mobile/.test(await page.locator('body').innerText()))
      const box = (label) => page.locator('label', { hasText: label }).locator('input, textarea').first()
      await page.locator('label', { hasText: 'Mobile' }).nth(0).locator('input').fill('07700 900001')
      await page.locator('label', { hasText: 'Mobile' }).nth(1).locator('input').fill('07700 900002')
      await box('Correspondence address').fill('1 Lane, Lewes')
      await page.getByRole('radiogroup', { name: 'Amly Barn (3 bedrooms)' }).getByRole('radio', { name: 'Yes' }).click()
      await page.getByRole('radiogroup', { name: 'Glamping (7 tents, 20 beds)' }).getByRole('radio', { name: 'Hold' }).click()
      await page.getByText(/2 nights · /).click()
      await page.getByRole('button', { name: 'Sign the booking form' }).waitFor({ timeout: 8000 })
      await page.waitForTimeout(1200)   // the save waits a moment after the last change
      const merged = Object.assign({}, ...saves)
      check('P5 answers save themselves', merged.amly === 'yes' && merged.glamping === 'hold' && merged.glampingNights === 2 && merged.address === '1 Lane, Lewes', merged)
      check('P6 the price of both glamping options is shown', /1 night · .*£1,750/.test(await page.locator('body').innerText()) && /2 nights · .*£2,675/.test(await page.locator('body').innerText()))
      const signBtn = page.getByRole('button', { name: 'Sign the booking form' })
      check('P7 signing needs the tick', await signBtn.isDisabled())
      await page.locator('label', { hasText: 'Type your full name' }).locator('input').fill('Sam Smith')
      await page.getByText(/I have read this booking form/).click()
      await signBtn.click()
      await page.waitForTimeout(500)
      check('P8 signing sends the typed name and the tick', signCalls.length === 1 && signCalls[0].name === 'Sam Smith' && signCalls[0].agree === true, signCalls)
      await goTab(page, 'Documents')
      await page.getByText('Terms and conditions').first().waitFor({ timeout: 8000 })
      const docs = await page.locator('body').innerText()
      check('P9 the documents page no longer sends couples to the accommodation terms', !/Read the terms/.test(docs) && /part of your booking form/.test(docs), docs.slice(0, 300))
      check('P10 no page errors', h.errors.length === 0, h.errors)
    } finally { if (!vp) await h.close() }
  }

  // A portal with no contracts database yet: nothing breaks, no new tab.
  {
    const h = await openPortal({ distDir: DIST, rpc: baseRpc({}) })
    try {
      await h.page.locator('.side-list .tab').first().waitFor({ timeout: 15000 })
      const menu = await h.page.locator('.side-list .tab').allInnerTexts()
      check('P11 before the migration the portal is as it was', !menu.some((x) => /Booking form/.test(x)) && h.errors.length === 0, menu)
    } finally { await h.close() }
  }

  // ── 2. The Contract tab ───────────────────────────────────────────────────
  const app = {
    hawthbush_bookings_v6: [{ id: 300, couple: 'Sam & Alex', date: plus(4), status: 'Confirmed', eventType: 'Wedding (Peak)',
      email: 'sam@example.com', email2: 'alex@example.com', client1Name: 'Sam Smith', client2Name: 'Alex Jones', phone: '07700 900001',
      venueFee: '5670', amlyFee: '1050', campingFee: '', glamping2Fee: '', files: [] }],
    hawthbush_staff_v5: [],
  }
  let issued = null, invites = 0
  let contracts = []
  const h = await openStaff({ distDir: DIST, appData: app, rpc: {
    ct_admin_for_event: () => ({ ok: true, booking_form_only: true, contracts }),
    ct_admin_statuses: () => ({ ok: true, contracts: [] }),
    wp_list_access: () => ({ ok: true, access: [] }),
    ct_admin_issue: (a) => {
      issued = a
      contracts = [{ id: 'c-9', version: 1, status: 'out', body: a.p_body, body_sha256: 'abc', sent_at: new Date().toISOString(), sent_by_name: 'Office',
        answers: a.p_prefill, signers: [{ role: 'client1', name: 'Sam Smith', email: 'sam@example.com' }, { role: 'client2', name: 'Alex Jones', email: 'alex@example.com' }], log: [] }]
      return { ok: true, id: 'c-9', version: 1, sent_at: new Date().toISOString(), venue_name: 'Office' }
    },
  } })
  const page = h.page
  await page.route(HOST + '/rest/v1/app_data', async (route) => {
    const req = route.request()
    if (req.method() !== 'POST') return route.fallback()
    const b = JSON.parse(req.postData() || '{}')
    app[b.key] = b.value
    h.calls.push({ fn: 'write:app_data', args: req.postData() })
    return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' })
  })
  await page.route('**/.netlify/functions/contract-admin', async (route) => {
    const b = JSON.parse(route.request().postData() || '{}')
    if (b.action === 'invite') invites++
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [{ email: 'sam@example.com', ok: true }, { email: 'alex@example.com', ok: true }] }) })
  })
  try {
    await page.reload()
    await page.getByText('Sam & Alex', { exact: true }).first().waitFor({ timeout: 15000 })
    await page.getByText('Sam & Alex', { exact: true }).first().click()
    const tab = page.getByRole('tab', { name: /^Contract/ })
    if (await tab.count()) await tab.first().click(); else await page.getByText('Contract', { exact: true }).first().click()
    await page.getByRole('button', { name: 'Send for signing' }).waitFor({ timeout: 10000 })
    const t = await page.locator('body').innerText()
    check('C1 the Contract tab is the new one', /Signed by the couple in their planner/.test(t) && !/Test mode/.test(t))
    check('C2 the wedding contract is chosen', /Standard booking form/.test(await page.locator('select').first().innerText()))
    check('C3 "booking form only" is on for a couple with no planner login', await page.getByText('Show them only the booking form in their planner').locator('xpath=preceding-sibling::input').isChecked())
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    check('C4 the preview shows the form as the couple will see it', (await page.getByText('Booking Form and Terms & Conditions').count()) > 0)
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'staff-contract-draft.png'), fullPage: false })
    await page.getByRole('button', { name: 'Send for signing' }).click()
    await page.getByText('Out for signing').first().waitFor({ timeout: 10000 })
    if (process.env.SHOTS) { await page.getByText('Out for signing').first().scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(process.env.SHOTS, 'staff-contract-out.png') }) }
    check('C5 the contract is issued from the template, filled in', issued && issued.p_event_id === 300 && Array.isArray(issued.p_body.blocks) &&
      /£5,670/.test(JSON.stringify(issued.p_body.blocks)) && issued.p_body.accommodation.length === 1 && issued.p_body.accommodation[0].key === 'amly', issued && issued.p_body.accommodation)
    check('C6 to both clients, with their names prefilled for them', issued.p_client2.email === 'alex@example.com' && issued.p_prefill.client1Mobile === '07700 900001' && issued.p_booking_form_only === true)
    check('C7 the body carries no email addresses', !/@example\.com/.test(JSON.stringify(issued.p_body)))
    check('C8 and the emails go as a separate step', invites === 1)
    const ev = (app.hawthbush_bookings_v6 || []).find((e) => e.id === 300) || {}
    check('C9 the event records the contract the way the pipeline reads it', ev.contract && ev.contract.provider === 'hawthbush' && ev.contract.contractId === 'c-9' && ev.contract.status === 'Pending' && ev.contract.sentAt, ev.contract)
    check('C10 no page errors', h.errors.length === 0, h.errors)

    // ── 3. Settings → Contracts ─────────────────────────────────────────────
    await page.locator('nav, aside').getByText('Settings', { exact: true }).first().click()
    await page.locator('nav, aside').getByText('Contracts', { exact: true }).first().click()
    await page.getByText('Which contract each kind of event gets').waitFor({ timeout: 10000 })
    const ta = page.locator('textarea').first()
    await ta.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('\nCeremony at {{Ceremony location}}.\n')
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, 'staff-settings.png') })
    check('S1 an unknown {{label}} becomes the template\'s own field', /Its own fields \(a box on the Contract tab\): Ceremony location/.test(await page.locator('body').innerText()))
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByText('Saved').first().waitFor({ timeout: 8000 })
    const saved = app.hbf_contract_templates_v1 || []
    check('S2 saving writes the template, with who and when', saved.length === 1 && saved[0].id === 'standard' && /Ceremony location/.test(saved[0].body) && saved[0].savedAt, saved.map((x) => x.id))
    await page.locator('input[type=file]').setInputFiles(path.join(ROOT, 'node_modules/mammoth/test/test-data/tables.docx'))
    await page.getByText(/^Imported\./).waitFor({ timeout: 15000 })
    const val = await page.locator('textarea').first().inputValue()
    check('S3 a Word document imports, tables and all', /^\| .* \|$/m.test(val) && /\[\[Signatures\]\]/.test(val), val.slice(0, 200))
    check('S4 no page errors', h.errors.length === 0, h.errors)
  } finally { await h.close() }

  console.log(passes + ' passed' + (fails.length ? ', ' + fails.length + ' FAILED:\n  ' + fails.join('\n  ') : ''))
  process.exit(fails.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
