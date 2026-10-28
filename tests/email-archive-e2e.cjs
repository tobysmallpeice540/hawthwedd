// tests/email-archive-e2e.cjs
//
// The emails on a record, end to end. Built app, Supabase faked
// (tests/portal-harness.cjs → openStaff), the email-archive function faked:
//   · an enquiry shows its emails from the archive — from the guest, from us —
//     and the app's own from the log, each once, newest first, with no Gmail
//     connection;
//   · an email opens to its text; its attachments have Save to files, which
//     asks the function for that one attachment under the record's folder and
//     adds it to Files as "Email attachment from guest";
//   · Files shows each file's flavour (Uploaded, Contract, from guest / from
//     Hawthbush); Delete takes a second press;
//   · an app email opens in full;
//   · anybody the database does not take for an admin sees only the app's emails; before the
//     migration the page says so and still works;
//   · a letting has Emails and Files; an event's Contact has Emails;
//   · Settings has the Email archive card; on a phone the date stays on the
//     subject's line.
//
//   npx vite build --outDir "$HOME/dist-check" --emptyOutDir && node tests/email-archive-e2e.cjs

const os = require('os'), path = require('path')
const { openStaff } = require('./portal-harness.cjs')
const DIST = process.env.DIST || path.join(os.homedir(), 'dist-check')
const HOST = 'https://rkqbyisfmvwulsyxzwjz.supabase.co'

let passes = 0; const fails = []
const check = (n, ok, d) => { if (ok) passes++; else fails.push(n + (d ? ': ' + d : '')) }

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
const plus = (n) => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)

const ENQUIRIES = [{ id: 'enq_1', name: 'Amy Smith', email: 'Amy@X.com', contacts: [], viewings: [], outcome: 'undecided', temperature: 'warm',
  files: [{ name: 'old-notes.pdf', path: 'enquirys/enq_1/1_old-notes.pdf', url: HOST + '/storage/v1/object/authenticated/booking-files/enquirys/enq_1/1_old-notes.pdf', type: 'application/pdf', uploadedAt: '2026-01-02' },
          { name: 'Signed contract.pdf', path: 'enquirys/enq_1/2_c.pdf', url: HOST + '/storage/v1/object/authenticated/booking-files/enquirys/enq_1/2_c.pdf', type: 'application/pdf', uploadedAt: '2026-01-03', signwellDocumentId: 'sw1' }] }]
const BOOKINGS = [{ id: 701, couple: 'Upcoming Couple', date: plus(3), status: 'Confirmed', eventType: 'Wedding (Peak)', email: 'couple@x.com', invoiceEmails: 'Email pay@x.com' }]
const ACCOM = [{ id: 'A100', guestName: 'Michael and Sonia', email: 'gina@x.com', status: 'confirmed', bookingType: 'Standard', source: 'direct',
  stays: [{ propertyId: 'hamlet', propertyName: 'The Hamlet', checkIn: plus(2), checkOut: plus(5), value: 900 }], schedule: [] }]
const LOG = [
  { id: 'L1', to: 'amy@x.com', subject: 'Your brochure', template: 'brochure_request', body: 'Here it is, Amy.', sentAt: '2026-10-01T09:00:00.000Z' },
  { id: 'L2', to: 'amy@x.com', subject: 'Viewing confirmed', template: 'viewing_confirm', body: 'See you Tuesday', sentAt: '2026-10-05T09:00:00.000Z' },
  { id: 'L3', to: 'someone@else.com', subject: 'Not hers', sentAt: '2026-10-06T09:00:00.000Z' },
  { id: 'L4', to: 'gina@x.com', subject: 'Booking confirmed', template: 'booking_confirmed', bookingId: 'A100', body: 'Booked', sentAt: '2026-10-07T09:00:00.000Z' },
]
const ARCHIVE = {
  'amy@x.com': [
    { id: '18a2', thread: 't1', at: '2026-10-10T14:00:00Z', dir: 'in', from: 'amy@x.com', from_name: 'Amy Smith', to: ['hawthbushfarm@gmail.com'], cc: [],
      subject: 'Our floor plan ideas for the barn', body: 'Hi both,\nHere is our sketch.\nAmy', atts: [{ part: '1', name: 'floorplan.pdf', mime: 'application/pdf', size: 245000 }] },
    { id: '18a1', thread: 't1', at: '2026-10-08T10:00:00Z', dir: 'out', from: 'hawthbushfarm@gmail.com', to: ['amy@x.com'], cc: [], subject: 'Re: dates', body: 'The 14th is free.', atts: [] },
    // already copied in by the worker: the log's copy must not show twice
    { id: 'app:L2', at: '2026-10-05T09:00:00Z', dir: 'app', from: 'hello@hawthbushfarm.co.uk', to: ['amy@x.com'], subject: 'Viewing confirmed', body: 'See you Tuesday', html: '', kind: 'viewing_confirm', atts: [] },
  ],
  'couple@x.com': [{ id: '18c1', thread: 't9', at: '2026-09-01T10:00:00Z', dir: 'in', from: 'couple@x.com', to: [], cc: [], subject: 'Menu question', body: 'Vegan options?', atts: [] }],
  'gina@x.com': [{ id: '18g1', thread: 't8', at: '2026-10-09T10:00:00Z', dir: 'in', from: 'gina@x.com', to: [], cc: [], subject: 'Parking for two cars?', body: 'Thanks', atts: [] }],
}
const archiveRpc = (role) => ({
  my_profile: () => ({ id: '00000000-0000-4000-8000-00000000beef', role: 'admin', active: true, name: 'Office' }),
  email_admin_messages: (a) => {
    if (role === 'refused') return { ok: false, error: 'not_admin' }
    const out = []
    ;(a.p_addresses || []).forEach((x) => (ARCHIVE[x] || []).forEach((m) => out.push(m)))
    return { ok: true, messages: out.sort((p, q) => (q.at > p.at ? 1 : -1)) }
  },
  email_admin_status: () => ({ ok: true, connected: true, account: 'hawthbushfarm@gmail.com', messages: 812, app_messages: 214, oldest: '2025-01-03T10:00:00Z',
    last_sync_at: new Date().toISOString(), last_result: { pending: 40, addresses: 280 }, last_error: null }),
})

async function open(opts) {
  const o = opts || {}
  const appData = JSON.parse(JSON.stringify({ hbf_enquiries_v1: ENQUIRIES, hawthbush_bookings_v6: BOOKINGS, hbf_accom_v1: ACCOM, hbf_email_log_v1: LOG }))
  const rpc = o.rpc || archiveRpc(o.role)
  const s = await openStaff({ distDir: DIST, appData: appData, rpc: rpc, viewport: o.viewport })
  s.appData = appData; s.fn = []
  await s.page.route(HOST + '/rest/v1/app_data', async (route) => {
    const req = route.request()
    if (req.method() !== 'POST') return route.fallback()
    const b = JSON.parse(req.postData() || '{}')
    appData[b.key] = b.value
    s.calls.push({ fn: 'write:app_data', args: b })
    return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' })
  })
  await s.page.route(HOST + '/storage/v1/**', async (route) => {
    s.calls.push({ fn: 'storage:' + route.request().method(), args: route.request().postData() })
    return route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4' })
  })
  await s.page.route('**/.netlify/functions/email-archive', async (route) => {
    const b = JSON.parse(route.request().postData() || '{}')
    s.fn.push(b)
    if (b.action === 'attachment') return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, path: b.folder + '/1761650000000_floorplan.pdf', name: 'floorplan.pdf', mime: 'application/pdf', size: 245000, direction: 'in' }) })
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, stored: 3, more: false }) })
  })
  await s.page.route('**/.netlify/functions/box-admin', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"events":[],"orders":[]}' }))
  await s.page.reload()
  await s.page.getByText('Upcoming Events', { exact: false }).first().waitFor({ timeout: 15000 })
  return s
}
async function openEnquiry(s) {
  await s.page.locator('nav, aside').getByText('Enquiries', { exact: true }).first().click()
  await s.page.getByText('Amy Smith', { exact: true }).first().click()
  await s.page.locator('h3', { hasText: /^Emails$/ }).first().waitFor({ timeout: 8000 })
  await s.page.waitForTimeout(600)
}
const rows = (page) => page.locator('[data-email-row]')

;(async () => {
  // ── An enquiry, as an admin ─────────────────────────────────────────────
  let s = await open()
  let page = s.page
  try {
    await openEnquiry(s)
    const ids = await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-email-row')))
    check('A1 archive and log, each once, newest first', ids.join('|') === '18a2|18a1|app:L2|app:L1', ids.join('|'))
    const txt = await page.locator('h3', { hasText: /^Emails$/ }).locator('..').innerText()
    check('A2 who sent it, in words', /From guest/.test(txt) && /From Hawthbush/.test(txt) && /Sent by the app · Brochure/.test(txt) && /Sent by the app · Viewing confirmed/.test(txt), txt.slice(0, 400))
    check('A3 no Connect Gmail needed', !/Connect Gmail \(button/.test(txt) && !/Connect Gmail to see/.test(txt))
    check('A4 not another person\'s', !/Not hers/.test(txt))
    check('A5 an attachment count on the row', /📎 1/.test(await rows(page).first().innerText()))
    check('A6 asked with the address in lower case', s.calls.some((c) => c.fn === 'email_admin_messages' && JSON.stringify(c.args.p_addresses) === '["amy@x.com"]'),
      JSON.stringify(s.calls.filter((c) => c.fn === 'email_admin_messages').map((c) => c.args)))

    // Open it, save the attachment.
    await rows(page).first().locator('[role=button]').click()
    const open1 = await rows(page).first().innerText()
    check('B1 opens to its text', /Here is our sketch\./.test(open1) && /Open in Gmail/.test(open1), open1)
    check('B2 attachment listed with Save to files', /floorplan\.pdf/.test(open1) && /239 KB/.test(open1) && /Save to files/.test(open1), open1)
    await rows(page).first().getByRole('button', { name: 'Save to files' }).click()
    await rows(page).first().getByText('✓ In Files').waitFor({ timeout: 5000 })
    const req = s.fn.find((b) => b.action === 'attachment')
    check('B3 one attachment, under the record\'s folder', req && req.gmail_id === '18a2' && req.part === '1' && req.folder === 'enquirys/enq_1', JSON.stringify(req))
    const saved = (s.appData.hbf_enquiries_v1.find((e) => e.id === 'enq_1') || {}).files || []
    const f = saved.find((x) => x.name === 'floorplan.pdf')
    check('B4 added to Files as from the guest', f && f.source === 'email-in' && f.gmailId === '18a2' && f.gmailPart === '1' && f.path === 'enquirys/enq_1/1761650000000_floorplan.pdf', JSON.stringify(f))
    check('B5 the files already there kept', saved.length === 3, saved.map((x) => x.name).join())

    // Files: flavours, two-press delete.
    const filesCard = page.locator('div', { hasText: /^Files$/ }).first().locator('..')
    await page.waitForTimeout(300)
    const flav = await page.locator('[data-file-source]').evaluateAll((els) => els.map((e) => e.getAttribute('data-file-source') + '=' + e.textContent))
    check('C1 each file says where it came from', flav.indexOf('uploaded=Uploaded') !== -1 && flav.indexOf('contract=Contract') !== -1 && flav.indexOf('email-in=Email attachment from guest') !== -1, flav.join(' | '))
    const delBtns = filesCard.getByRole('button', { name: '✕ Delete' })
    const before = (await delBtns.count())
    check('C2 every file has Delete', before === 3, String(before))
    await delBtns.first().click()
    check('C3 the first press only asks', (await filesCard.getByRole('button', { name: 'Delete for good?' }).count()) === 1
      && ((s.appData.hbf_enquiries_v1[0].files || []).length === 3))
    await filesCard.getByRole('button', { name: 'Delete for good?' }).click()
    await page.waitForTimeout(600)
    const after = (s.appData.hbf_enquiries_v1[0].files || []).map((x) => x.name)
    check('C4 the second press deletes it, from the record and storage', after.length === 2 && s.calls.some((c) => c.fn === 'storage:DELETE'), after.join() + ' ' + s.calls.filter((c) => /^storage/.test(c.fn)).map((c) => c.fn).join())

    // An app email opens in full.
    await rows(page).filter({ hasText: 'Your brochure' }).locator('[role=button]').click()
    await page.getByText('Here it is, Amy.').nth(1).waitFor({ timeout: 4000 })
    check('D1 an app email opens in full', true)
    await page.getByRole('button', { name: 'Close' }).click()

    // Settings.
    await page.locator('nav, aside').getByText('Settings', { exact: true }).first().click()
    await page.getByText('Email archive', { exact: true }).first().waitFor({ timeout: 8000 })
    const card = await page.getByText('Email archive', { exact: true }).first().locator('..').innerText()
    check('E1 Settings: what is kept and how far', /812 emails kept/.test(card) && /214 sent by the app/.test(card) && /40 of 280 addresses to go/.test(card) && /hawthbushfarm@gmail\.com/.test(card), card)
    await page.getByRole('button', { name: 'Read now' }).click()
    await page.getByText(/3 emails added\. Up to date\./).waitFor({ timeout: 5000 })
    check('E2 Read now runs the sync', s.fn.some((b) => b.action === 'sync'))

    // A letting: Emails and Files (from Home's check-ins).
    await page.locator('nav, aside').getByText('Home', { exact: true }).first().click()
    await page.getByText('Michael and Sonia', { exact: true }).first().click()
    await page.locator('h3', { hasText: /^Emails$/ }).first().waitFor({ timeout: 8000 })
    await page.waitForTimeout(500)
    const let1 = await page.locator('body').innerText()
    check('F1 a letting shows its guest\'s emails and the app\'s', /Parking for two cars\?/.test(let1) && /Booking confirmed/.test(let1), let1.slice(0, 200))
    check('F2 and has Files', /Drag files here|Upload Files/.test(let1))
    check('F3 asked by booking id too', s.calls.some((c) => c.fn === 'email_admin_messages' && c.args.p_ref === 'A100'))

    // An event: Contact → Emails, invoice address included.
    await page.locator('nav, aside').getByText('Home', { exact: true }).first().click()
    await page.getByText('Upcoming Couple', { exact: true }).first().click()
    await page.getByRole('button', { name: /^Contact/ }).first().click()
    await page.getByText('Menu question').waitFor({ timeout: 8000 })
    check('G1 an event shows its emails', true)
    check('G2 every address on it, the invoice one too', s.calls.some((c) => c.fn === 'email_admin_messages' && JSON.stringify(c.args.p_addresses) === '["couple@x.com","pay@x.com"]'),
      JSON.stringify(s.calls.filter((c) => c.fn === 'email_admin_messages').map((c) => c.args.p_addresses)))
    check('X1 no page errors', s.errors.length === 0, s.errors.join(' | '))
  } catch (e) { fails.push('admin run threw: ' + e.message) }
  await s.close()

  // ── The database says not an admin: only the app's emails ──────────────────
  // (A bar or cleaner login has its own screens and never reaches a record;
  // this is the database refusing whoever it is.)
  s = await open({ role: 'refused' })
  try {
    await openEnquiry(s)
    const ids = await rows(s.page).evaluateAll((els) => els.map((e) => e.getAttribute('data-email-row')))
    check('H1 not admin: the app\'s emails only, no error', ids.join('|') === 'app:L2|app:L1' && !/Couldn't read the email archive/.test(await s.page.locator('body').innerText()), ids.join('|'))
  } catch (e) { fails.push('refused run threw: ' + e.message) }
  await s.close()

  // ── Before the migration ─────────────────────────────────────────────────
  s = await open({ rpc: { my_profile: () => ({ id: '00000000-0000-4000-8000-00000000beef', role: 'admin', active: true, name: 'Office' }) } })
  try {
    await openEnquiry(s)
    const body = await s.page.locator('body').innerText()
    check('I1 says the archive is not installed, still shows the app\'s', /not installed yet \(migration 2026-10-28s\)/.test(body) && (await rows(s.page).count()) === 2)
    check('I2 no page errors', s.errors.length === 0, s.errors.join(' | '))
  } catch (e) { fails.push('absent run threw: ' + e.message) }
  await s.close()

  // ── A phone ─────────────────────────────────────────────────────────────
  s = await open({ viewport: { width: 375, height: 800 } })
  try {
    await s.page.goto(s.origin + '/')
    await s.page.waitForTimeout(1500)
    const menu = s.page.getByRole('button', { name: /menu/i }).first()
    if (await menu.count()) await menu.click().catch(() => {})
    await s.page.getByText('Enquiries', { exact: true }).first().click()
    await s.page.getByText('Amy Smith', { exact: true }).first().click()
    await rows(s.page).first().waitFor({ timeout: 8000 })
    const r0 = rows(s.page).first()
    const subj = await r0.getByText('Our floor plan ideas for the barn').boundingBox()
    const date = await r0.getByText('10 Oct 2026', { exact: true }).boundingBox()
    check('P1 on a phone the date stays on the subject\'s line', subj && date && Math.abs(subj.y - date.y) < 8, JSON.stringify([subj, date]))
    const w = await s.page.evaluate(() => document.documentElement.scrollWidth)
    check('P2 no sideways scroll', w <= 380, String(w))
  } catch (e) { fails.push('phone run threw: ' + e.message) }
  await s.close()

  console.log(passes + ' passed, ' + fails.length + ' failed')
  fails.forEach((f) => console.log('  FAIL ' + f))
  process.exit(fails.length ? 1 : 0)
})()
