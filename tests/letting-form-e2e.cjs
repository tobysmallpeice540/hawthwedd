// The letting form in tabs, on a phone, and checklists on their record
// (29 Oct 2026). Runs the BUILT app with Supabase faked.
//
//   npx vite build --outDir "$HOME/dist-check" --emptyOutDir && node tests/letting-form-e2e.cjs
//
// SHOTS=<dir> also saves screenshots there.
const path = require('path')
const os = require('os')
const { openStaff } = require('./portal-harness.cjs')

const DIST = process.env.DIST || path.join(os.homedir(), 'dist-check')
const SHOTS = process.env.SHOTS || ''
let passes = 0; const fails = []
const check = (n, ok, d) => { if (ok) passes++; else fails.push(n + (d ? ': ' + d : '')) }
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
const plus = (n) => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)
const LONG_NOTES = Array.from({ length: 14 }, (_, i) => 'Line ' + (i + 1) + ' of the guest notes, which must all be readable.').join('\n')

const ACCOM = [
  { id: 'L1', guestName: 'Emma Juner', email: 'emma@example.invalid', phone: '07700 900123', status: 'confirmed', source: 'direct', value: 1200,
    extras: [{ desc: 'Hot tub', amount: 60 }], breakage: 200, notes: LONG_NOTES,
    schedule: [
      { label: 'Deposit', amount: 360, dueDate: plus(-20), paid: true, paidDate: plus(-20) },
      { label: 'Balance', amount: 840, dueDate: plus(10), paid: false },
    ],
    stays: [{ propertyId: 'hamlet', propertyName: 'The Hamlet', checkIn: plus(30), checkOut: plus(33), guestCount: 6, value: 1200 }] },
]
const iso = (d, hm) => d + 'T' + hm + ':00Z'
const run = (o) => Object.assign({ items: [{ id: o.id + 'i1', title: 'Beds made', state: o.status === 'open' ? 'open' : 'done', due_at: o.anchor_at, mine: false }] }, o)
const L1_RUNS = [
  run({ id: 'R1', title: 'Hamlet pre-arrival', status: 'done', context: 'The Hamlet · Emma Juner · in ' + plus(-1) + ' 15:00',
        link: { kind: 'accom', id: 'L1' }, anchor_at: iso(plus(-1), '15:00'), opens_at: iso(plus(-2), '15:00'), closed_at: iso(today, '09:00'), closed_by: 'Toby' }),
]
const PAST = L1_RUNS.concat([
  run({ id: 'R2', title: 'Hamlet departure check', status: 'done', context: 'The Hamlet · Emma Juner · out ' + plus(-1) + ' 10:00',
        link: { kind: 'accom', id: 'L1' }, anchor_at: iso(plus(-1), '10:00'), closed_at: iso(plus(-1), '12:00'), closed_by: 'Housekeeping' }),
  run({ id: 'R3', title: 'Bar closing', status: 'done', context: 'Smith · Wedding · ' + plus(-1) + ' 12:00',
        link: { kind: 'event', id: '7' }, anchor_at: iso(plus(-1), '12:00'), closed_at: iso(today, '01:00'), closed_by: 'Bar' }),
  run({ id: 'R4', title: 'Weekly fire check', status: 'done', context: plus(-3) + ' 09:00',
        link: null, anchor_at: iso(plus(-3), '09:00'), closed_at: iso(plus(-1), '09:00'), closed_by: 'Toby' }),
])

;(async () => {
  const h = await openStaff({ distDir: DIST, appData: { hbf_accom_v1: ACCOM }, rpc: {
    chk_live: () => ({ ok: true, now: new Date().toISOString(), me: { role: 'admin', label: 'Toby' }, runs: [], notes: [], closed: [] }),
    chk_past: () => ({ ok: true, runs: PAST }),
    chk_for_record: (a) => ({ ok: true, runs: a.p_kind === 'accom' && a.p_id === 'L1' ? L1_RUNS : [] }),
    chk_run_get: (a) => ({ ok: true, run: PAST.find((r) => r.id === a.p_id) }),
  } })
  const page = h.page
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }) }
  try {
    await page.getByText('Upcoming Events', { exact: false }).first().waitFor({ timeout: 15000 }).catch(() => {})
    await page.locator('nav, aside').getByText('Lettings', { exact: true }).first().click()
    await page.locator('nav, aside').getByText('Bookings', { exact: true }).first().click()
    await page.getByText('Emma Juner', { exact: true }).first().click()

    // ── Title and tabs ──────────────────────────────────────────────────────
    await page.locator('.hb-title', { hasText: 'Emma Juner' }).first().waitFor({ timeout: 8000 })
    check('T1 the guest name is the page title', true)
    const sub = await page.locator('.hb-sub').first().innerText()
    check('T2 the subtitle says where and the status', /Hamlet/.test(sub) && /Confirmed/.test(sub), sub)
    const tabs = await page.getByRole('tab').allInnerTexts()
    check('T3 four tabs', ['Details', 'Payments', 'Emails', 'Files'].every((t) => tabs.some((x) => x.indexOf(t) === 0)), tabs.join(','))
    let body = await page.locator('body').innerText()
    check('T4 Details has no payment schedule or emails', !/Payment schedule/.test(body) && !/Send an email now/.test(body))

    await page.setViewportSize({ width: 390, height: 860 })
    await page.waitForTimeout(400)

    // ── Details on a phone ──────────────────────────────────────────────────
    const top = async (sel) => page.locator(sel).first().evaluate((el) => Math.round(el.getBoundingClientRect().top))
    const labelTop = (txt) => page.getByText(txt, { exact: true }).first().evaluate((el) => Math.round(el.getBoundingClientRect().top))
    const [nameTop, statusTop, emailTop, phoneTop] = await Promise.all(['Guest name', 'Status', 'Email', 'Phone'].map(labelTop))
    check('P1 guest, status, email and phone in two rows on a phone', nameTop === statusTop && emailTop === phoneTop && emailTop > nameTop, [nameTop, statusTop, emailTop, phoneTop].join())
    // WhatsApp consent (30 Oct): an older direct booking with no answer shows ticked.
    const consent = page.getByLabel(/OK to contact the guest by WhatsApp/)
    check('P1b WhatsApp consent ticked by default, stay information only', (await consent.count()) === 1 && (await consent.isChecked()))
    const notes = page.locator('label', { has: page.getByText('Notes', { exact: true }) }).locator('textarea').first()
    const n = await notes.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, oy: getComputedStyle(el).overflowY }))
    check('P2 the notes box grows to its text', n.ch >= n.sh - 4 || n.oy === 'auto', JSON.stringify(n))
    check('P3 every line of the notes can be read', (await notes.inputValue()).split('\n').length === 14)
    await page.getByText('Checklists for this letting', { exact: true }).waitFor({ timeout: 5000 })
    check('P4 the letting shows its checklist', (await page.getByRole('button', { name: 'Open checklist: Hamlet pre-arrival' }).count()) === 1)
    const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
    check('P5 no sideways scroll at 390px', noScroll)
    await shot('letting-details-phone')

    await page.getByRole('button', { name: 'Open checklist: Hamlet pre-arrival' }).click()
    await page.getByRole('dialog', { name: 'Checklist' }).waitFor({ timeout: 5000 })
    check('P6 the list opens over the letting', (await page.locator('.hb-title', { hasText: 'Emma Juner' }).count()) > 0)
    await page.keyboard.press('Escape').catch(() => {})
    await page.mouse.click(5, 5)
    await page.waitForTimeout(300)
    check('P7 closing it leaves the letting open', (await page.getByRole('dialog', { name: 'Checklist' }).count()) === 0
      && (await page.locator('.hb-title', { hasText: 'Emma Juner' }).count()) > 0)

    // ── Payments on a phone ─────────────────────────────────────────────────
    await page.getByRole('tab', { name: 'Payments' }).click()
    await page.getByText('Payment schedule', { exact: true }).waitFor({ timeout: 5000 })
    const rowTops = await Promise.all(['Payment', 'Amount', 'Due date', 'Paid'].map((l) =>
      page.getByLabel(l, { exact: true }).first().evaluate((el) => Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2))))
    check('M1 name, amount, due date and paid on one line', Math.max.apply(null, rowTops) - Math.min.apply(null, rowTops) <= 4, rowTops.join(','))
    const labelW = await page.getByLabel('Payment', { exact: true }).first().evaluate((el) => el.getBoundingClientRect().width)
    check('M2 the payment name keeps room to read', labelW >= 70, String(labelW))
    const extraTops = await page.locator('input[placeholder="Description"]').first().evaluate((el) => {
      const row = el.parentElement; return Array.from(row.children).map((c) => { const r = c.getBoundingClientRect(); return Math.round(r.top + r.height / 2) })
    })
    check('M3 an extra is one line', Math.max.apply(null, extraTops) - Math.min.apply(null, extraTops) <= 2, extraTops.join(','))
    check('M4 no sideways scroll at 390px', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    await shot('letting-payments-phone')

    // ── Emails ──────────────────────────────────────────────────────────────
    await page.getByRole('tab', { name: 'Emails' }).click()
    body = await page.locator('body').innerText()
    check('E1 Send an email now is on Emails', /Send an email now/.test(body))
    await shot('letting-emails-phone')

    // ── Checklists: finished and past ───────────────────────────────────────
    await page.setViewportSize({ width: 1200, height: 900 })
    await page.getByRole('button', { name: 'Exit' }).first().click()
    await page.locator('nav, aside').getByText('Checklists', { exact: true }).first().click()
    await page.getByRole('tab', { name: 'Finished and past' }).click()
    await page.getByText('For the Emma Juner letting', { exact: true }).waitFor({ timeout: 5000 })
    await page.setViewportSize({ width: 390, height: 860 })
    await page.waitForTimeout(300)
    body = await page.locator('main, .app-shell, body').first().innerText()
    const iY = body.indexOf('YESTERDAY') >= 0 ? body.indexOf('YESTERDAY') : body.indexOf('Yesterday')
    const iEmma = body.indexOf('For the Emma Juner letting')
    const iWed = body.indexOf('For the Smith wedding')
    const iFire = body.indexOf('Weekly fire check')
    check('G1 grouped by the day it was for, not when it finished', iY >= 0 && iEmma > iY && iWed > iY, [iY, iEmma, iWed].join())
    check('G2 both of Emma Juner\'s lists under her letting, in order of time',
      body.indexOf('Hamlet departure check') > iEmma && body.indexOf('Hamlet pre-arrival') > body.indexOf('Hamlet departure check'))
    check('G3 the wedding is its own group', iWed > 0)
    check('G4 a list with no booking sits on its own day', iFire > body.indexOf(new Date(Date.parse(plus(-3))).getUTCDate() + ' ') - 1 && iFire > iWed)
    await shot('checklists-past-phone')

    check('X1 no page errors', !h.errors.length, h.errors.join(' | '))
  } catch (e) { fails.push('run threw: ' + e.message) }
  await h.close()
  console.log(passes + ' passed' + (fails.length ? ', FAILURES:\n  ' + fails.join('\n  ') : ', 0 failed'))
  process.exit(fails.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
