// tests/upcoming-e2e.cjs
//
// The housekeeping login after 6 Nov 2026 (Toby): Upcoming first, Live and
// Bookings gone. Built app, Supabase faked (portal-harness → openStaff), the
// browser clock fixed so the lozenges can be checked at set moments:
//   · tabs Upcoming | House | Calendar | Checklists, Upcoming open;
//   · before it can be cleaned a lozenge is grey and inert, one line
//     "Su 8 – Tu 10" (two-letter day, no month): a letting from its check-out day, the Grain Store
//     from the day after the event, by the next check-in day (the next timed
//     event's day; the day before an untimed diary event);
//   · "Guests" only from the check-in TIME to the check-out time;
//   · amber "To clean" over "by Tu 10" once it can be done; red after its last day;
//   · an extra clean is listed in the week of what it is for, just before it,
//     and turns amber when it opens (a week ahead in the Grain Store);
//   · a Note button opens the housekeeper notes in a bubble, × closes it;
//   · unsigned cleans from earlier weeks are listed under Still to sign off,
//     and sign off from there.
//
//   npx vite build --outDir "$HOME/dist-check" --emptyOutDir && node tests/upcoming-e2e.cjs

const os = require('os'), path = require('path')
const { openStaff } = require('./portal-harness.cjs')
const DIST = process.env.DIST || path.join(os.homedir(), 'dist-check')
const HOST = 'https://rkqbyisfmvwulsyxzwjz.supabase.co'

let passes = 0; const fails = []
const check = (n, ok, d) => { if (ok) passes++; else fails.push(n + (d ? ': ' + d : '')) }

const PROPS = [
  { id: 'hamlet', name: 'The Hamlet', colour: '#2563eb' },
  { id: 'amly', name: 'Amly Barn', colour: '#16a34a' },
  { id: 'glamping', name: 'Glamping', colour: '#9333ea' },
]
const stay = (p, a, b) => ({ propertyId: p, checkIn: a, checkOut: b, value: 0 })
const ACCOM = [
  { id: 'H1', guestName: 'Harrison', status: 'confirmed', stays: [stay('hamlet', '2026-11-06', '2026-11-08')], schedule: [] },
  { id: 'H2', guestName: 'Lister Party', status: 'confirmed', stays: [stay('hamlet', '2026-11-10', '2026-11-11')], schedule: [] },
  { id: 'H3', guestName: 'Hardy', status: 'confirmed', stays: [stay('hamlet', '2026-11-13', '2026-11-16')], schedule: [] },
  { id: 'H4', guestName: 'Lawrence', status: 'confirmed', stays: [stay('hamlet', '2026-11-20', '2026-11-22')], schedule: [] },
]
const EVENTS = [
  { id: 229, couple: 'Lister', date: '2026-11-10', status: 'Confirmed', eventType: 'Party' },
  { id: 240, couple: 'Cave', date: '2026-11-30', status: 'Confirmed', eventType: 'Wedding (Peak)' },
]
const BOX = [
  { id: 'b-supper', name: 'Supper Club', starts_at: '2026-11-20T18:00:00Z', ends_at: '2026-11-20T21:00:00Z', venue_name: 'The Grain Store' },
]
const SETUPS = [
  { id: 'setup:event:229', kind: 'event', refId: 229 },
  { id: 'note:event:229', kind: 'note', of: 'event', refId: 229, text: 'clean the barn before the party' },
  { id: 'setup:box:b-supper', kind: 'box', refId: 'b-supper' },
  { id: 'note:box:b-supper', kind: 'note', of: 'box', refId: 'b-supper', text: 'floor and toilets beforehand' },
]
const CHANGEOVERS = [
  { id: 'setup:event:229:grainstore', kind: 'setup', setupOf: 'event', refId: 229, unitId: 'grainstore', unitName: 'Grain Store',
    who: 'Extra clean · Lister', due: '2026-11-10', doneAt: '2026-11-04T09:32', hours: { edita: 4, karina: 0 }, comments: '', lostProperty: '' },
]
const cleanerRpc = { my_profile: () => ({ id: '00000000-0000-4000-8000-00000000beef', role: 'cleaner', active: true, name: 'Housekeeping' }) }

async function open(at) {
  const appData = JSON.parse(JSON.stringify({ hbf_properties_v1: PROPS, hbf_accom_v1: ACCOM, hawthbush_bookings_v6: EVENTS,
    hbf_changeovers_v1: CHANGEOVERS, hbf_setup_cleans_v1: SETUPS }))
  const s = await openStaff({ distDir: DIST, appData, rpc: cleanerRpc, viewport: { width: 390, height: 1600 } })
  // The fixed clock may be past the faked session's expiry: push it out.
  await s.page.addInitScript(() => {
    const k = 'sb-rkqbyisfmvwulsyxzwjz-auth-token'
    try { const v = JSON.parse(localStorage.getItem(k)); v.expires_at = 4102444800; localStorage.setItem(k, JSON.stringify(v)) } catch (e) { /* none */ }
  })
  await s.page.clock.setFixedTime(new Date(at))
  await s.page.route(HOST + '/rest/v1/app_data', async (route) => {
    const req = route.request()
    if (req.method() !== 'POST') return route.fallback()
    const b = JSON.parse(req.postData() || '{}')
    appData[b.key] = b.value
    s.calls.push({ fn: 'write:app_data', args: req.postData() })
    return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' })
  })
  await s.page.route('**/.netlify/functions/box-admin', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ events: BOX }) }))
  await s.page.reload()
  await s.page.getByRole('tab', { name: 'Upcoming', exact: true }).waitFor({ timeout: 15000 })
  await s.page.getByText('Harrison').first().waitFor({ timeout: 15000 })
  return s
}
// A row on Upcoming: the line holding `text` and a lozenge.
const rowOf = (scope, text) => {
  const pg = typeof scope.page === 'function' ? scope.page() : scope
  return scope.locator('div[style*="nowrap"]', { hasText: text }).filter({ has: pg.locator('button[aria-label]') }).last()
}
const lozenge = (row) => row.locator('button[aria-label]').last()
const weekCard = (page, title) => page.locator('div[style*="border-radius: 10px"]', { hasText: title }).first()

;(async () => {
  // ── Fri 6 Nov, 05:30 — before the Hamlet guests arrive ──────────────────
  {
    const s = await open('2026-11-06T05:30:00Z'); const pg = s.page
    try {
      const tabs = await pg.getByRole('tab').allInnerTexts()
      check('tabs', tabs.join('|') === 'Upcoming|House|Calendar|Checklists', tabs.join('|'))
      check('Upcoming open', (await pg.getByRole('tab', { name: 'Upcoming', exact: true }).getAttribute('aria-selected')) === 'true')
      check('no Live, no Bookings', (await pg.getByRole('tab', { name: 'Live' }).count()) === 0 && (await pg.getByRole('tab', { name: 'Bookings' }).count()) === 0)

      const h = lozenge(rowOf(pg, 'Harrison'))
      check('before check-in: grey dates, not Guests', (await h.innerText()).replace(/\s+/g, ' ') === 'Su 8 – Tu 10', await h.innerText())
      check('before check-in: inert', await h.isDisabled())
      check('before check-in: says so', /^Not yet, can be cleaned from Sun 8 Nov 26 to Tue 10 Nov 26/.test(await h.getAttribute('aria-label')), await h.getAttribute('aria-label'))

      const party = lozenge(rowOf(pg, 'Lister · Party'))
      check('Grain Store: from the day after, by the next timed event', (await party.innerText()).replace(/\s+/g, ' ') === 'We 11 – Fr 20', await party.innerText())
      const hardy = lozenge(rowOf(pg, 'Hardy'))
      check('letting: same day, by the next check-in', (await hardy.innerText()).replace(/\s+/g, ' ') === 'Mo 16 – Fr 20', await hardy.innerText())
      const supper = lozenge(rowOf(pg, 'Supper Club · Box office'))
      check('untimed diary event next: by the day before', (await supper.innerText()).replace(/\s+/g, ' ') === 'Sa 21 – Su 29', await supper.innerText())

      // The supper club's extra clean opens on the 13th but is listed in the
      // week of the 20th, just before the supper club.
      const wk9 = await weekCard(pg, 'Week of Mon 9 Nov 26').innerText()
      const wk16 = await weekCard(pg, 'Week of Mon 16 Nov 26').innerText()
      check('extra clean not in the week it opens', !/Before Supper Club/.test(wk9), wk9)
      check('extra clean in the week of its event, just before it', /Before Supper Club · by 16:00[\s\S]*Supper Club · Box office/.test(wk16) && !/Hardy[\s\S]*Before Supper Club[\s\S]*Lawrence/.test(wk16), wk16)
      const ex = lozenge(rowOf(pg, 'Before Supper Club'))
      check('extra clean: grey with its dates until it opens', (await ex.innerText()).replace(/\s+/g, ' ') === 'Fr 13 – Fr 20' && await ex.isDisabled(), await ex.innerText())
      check('signed extra clean: Ready', (await lozenge(rowOf(pg, 'Before Lister')).innerText()) === 'Ready')
      check('no Still to sign off', (await pg.getByText('Still to sign off').count()) === 0)

      // Notes: a button, the text only in the bubble.
      check('note text not in the list', !/floor and toilets/.test(await pg.locator('body').innerText()))
      check('no note button where there is no note', (await rowOf(pg, 'Hardy').getByRole('button', { name: 'Show note' }).count()) === 0)
      await rowOf(pg, 'Before Supper Club').getByRole('button', { name: 'Show note' }).click()
      const bubble = pg.getByRole('note')
      await bubble.waitFor({ timeout: 5000 })
      check('bubble: the note', /For Supper Club, on Fri 20 Nov 26: floor and toilets beforehand/.test(await bubble.innerText()), await bubble.innerText())
      check('one bubble at a time', (await pg.getByRole('note').count()) === 1)
      await pg.getByRole('button', { name: 'Close note' }).click()
      check('× closes it', (await pg.getByRole('note').count()) === 0)
      await rowOf(pg, 'Lister · Party').getByRole('button', { name: 'Show note' }).click()
      check('event row: its own note', /Note on this event[\s\S]*clean the barn before the party/.test(await pg.getByRole('note').innerText()))
      check('no page errors', s.errors.length === 0, s.errors.join(' | '))
    } catch (e) { fails.push('Fri 05:30 run: ' + e.message) }
    await s.close()
  }

  // ── Fri 6 Nov, 16:30 — the guests are in ────────────────────────────────
  {
    const s = await open('2026-11-06T16:30:00Z'); const pg = s.page
    try {
      const h = lozenge(rowOf(pg, 'Harrison'))
      check('after check-in time: Guests', (await h.innerText()) === 'Guests', await h.innerText())
      check('Guests: can still be opened', !(await h.isDisabled()))
    } catch (e) { fails.push('Fri 16:30 run: ' + e.message) }
    await s.close()
  }

  // ── Sun 8 Nov, 11:00 — they have checked out ────────────────────────────
  {
    const s = await open('2026-11-08T11:00:00Z'); const pg = s.page
    try {
      const h = lozenge(rowOf(pg, 'Harrison'))
      check('after check-out: amber To clean, by the next check-in', (await h.innerText()).replace(/\s+/g, ' ') === 'To clean by Tu 10', await h.innerText())
      const col = await h.evaluate((b) => getComputedStyle(b).borderTopColor)
      check('amber', col === 'rgb(217, 119, 6)', col)
      const party = lozenge(rowOf(pg, 'Lister · Party'))
      check('Grain Store before its event: grey', await party.isDisabled())
    } catch (e) { fails.push('Sun run: ' + e.message) }
    await s.close()
  }

  // ── Fri 13 Nov, 09:00 — the supper club's extra clean has opened ────────
  {
    const s = await open('2026-11-13T09:00:00Z'); const pg = s.page
    try {
      const ex = lozenge(rowOf(pg, 'Before Supper Club'))
      check('extra clean opens a week ahead: amber', (await ex.innerText()).replace(/\s+/g, ' ') === 'To clean by Fr 20' && !(await ex.isDisabled()), await ex.innerText())
      const party = lozenge(rowOf(pg, 'Lister · Party'))
      check('Grain Store the days after the event: amber', (await party.innerText()).replace(/\s+/g, ' ') === 'To clean by Fr 20', await party.innerText())
    } catch (e) { fails.push('Fri 13 run: ' + e.message) }
    await s.close()
  }

  // ── Tue 17 Nov, 09:00 — earlier weeks left unsigned ─────────────────────
  {
    const s = await open('2026-11-17T09:00:00Z'); const pg = s.page
    try {
      await pg.getByText('Still to sign off').waitFor({ timeout: 10000 })
      const box = weekCard(pg, 'Still to sign off')
      const txt = await box.innerText()
      check('Still to sign off lists last week', /Harrison/.test(txt) && /Lister · Party/.test(txt), txt)
      check('a signed one is not listed', !/Before Lister/.test(txt), txt)
      const h = lozenge(rowOf(box, 'Harrison'))
      const col = await h.evaluate((b) => getComputedStyle(b).borderTopColor)
      check('past its last day: red', col === 'rgb(220, 38, 38)', col)
      await h.click()
      await pg.getByText('Edita hours').waitFor({ timeout: 5000 })
      await pg.locator('input[type=number]').nth(0).fill('3')
      await pg.getByRole('button', { name: 'Done — ready' }).click()
      await pg.getByText('Edita hours').waitFor({ state: 'detached', timeout: 5000 })
      const w = s.calls.filter((c) => c.fn === 'write:app_data').map((c) => JSON.parse(c.args)).filter((x) => x.key === 'hbf_changeovers_v1').pop()
      const rec = w && w.value.find((r) => r.id === 'accom:H1:hamlet')
      check('signed off from Still to sign off', rec && rec.hours.edita === 3, w && JSON.stringify(w.value))
      check('the earlier sign-off kept', w && w.value.some((r) => r.id === 'setup:event:229:grainstore'))
      const after = await weekCard(pg, 'Still to sign off').innerText().catch(() => '')
      check('gone from Still to sign off', !/Harrison/.test(after), after)
    } catch (e) { fails.push('Tue 17 run: ' + e.message) }
    await s.close()
  }

  console.log(passes + ' passed, ' + fails.length + ' failed')
  fails.forEach((f) => console.log('  FAIL ' + f))
  process.exit(fails.length ? 1 : 0)
})()
