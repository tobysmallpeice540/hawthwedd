// Staff page and the housekeepers (4 Nov 2026, Toby: "can't put cleaner
// rates in the staff area"; "put cleaner phone no in WhatsApp settings but
// not appearing in staff page").
//
// Housekeeping pay is priced from a STAFF record (role Housekeeping, first
// name Edita / Karina) — a cleaner login is not one, and the page said nothing.
//   · a missing housekeeper gets "+ Add <name>", which opens the form filled
//     in: name, role Housekeeping, the WhatsApp summary number, a first rate
//     from CHANGEOVER_FROM waiting for its £
//   · saved, the record prices her and the prompt goes
//   · "Edyta" (her login's spelling) counts as Edita
//   · a cleaner login with no mobile is offered the summary number
//
//   npx vite build --outDir "$HOME/dist-check" --emptyOutDir && node tests/staff-housekeepers-e2e.cjs

const os = require('os'), path = require('path')
const { openStaff } = require('./portal-harness.cjs')
const DIST = process.env.DIST || path.join(os.homedir(), 'dist-check')
const HOST = 'https://rkqbyisfmvwulsyxzwjz.supabase.co'

let passes = 0; const fails = []
const check = (n, ok, d) => { if (ok) passes++; else fails.push(n + (d ? ': ' + d : '')) }

;(async () => {
  try {
    const appData = {
      hawthbush_staff_v5: [
        { id: 'TM', name: 'Taryn May', role: 'Bar Supervisor', active: true, rate: '£15 incl Roll Up', email: '', phone: '', notes: '' },
        { id: 'ED', name: 'Ed Smith', role: 'Bar Staff', active: true, email: '', phone: '', notes: '' },   // takes "ED"
      ],
      hbf_whatsapp_settings_v1: { summary: { day: 0, hour: 8, recipients: [{ name: 'Edita', mobile: '07700 900123' }, { name: 'Karina', mobile: '07700 900456' }] } },
    }
    const users = [
      { id: 'u-ed', email: 'edyta@test.invalid', name: 'Edyta cleaner', role: 'cleaner', active: true, mobile: null },
      { id: 'u-ka', email: 'karina@test.invalid', name: 'Karina Cleaner', role: 'cleaner', active: true, mobile: '447700900456' },
      { id: 'u-to', email: 'toby@test.invalid', name: 'Toby Cleaner', role: 'cleaner', active: true, mobile: null },
    ]
    const adminCalls = []
    const c = await openStaff({ distDir: DIST, appData: appData })
    try {
      await c.page.route(HOST + '/rest/v1/app_data', async (route) => {
        const req = route.request()
        if (req.method() !== 'POST') return route.fallback()
        const b = JSON.parse(req.postData() || '{}'); appData[b.key] = b.value
        return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' })
      })
      await c.page.route('**/.netlify/functions/box-admin', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"events":[],"orders":[]}' }))
      await c.page.route('**/.netlify/functions/user-admin', async (r) => {
        const b = JSON.parse(r.request().postData() || '{}'); adminCalls.push(b)
        if (b.action === 'users.setMobile') { const u = users.find((x) => x.id === (b.payload || b).id); if (u) u.mobile = '447700900123' }
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ users: users, me: 'x' }) })
      })
      await c.page.reload()
      const pg = c.page
      await pg.getByText('Settings', { exact: true }).first().waitFor({ timeout: 15000 })
      await pg.getByText('Settings', { exact: true }).first().click().catch(() => {})
      await pg.getByText('Staff', { exact: true }).first().click()
      await pg.getByText('Staff Database').waitFor({ timeout: 10000 })

      await pg.getByText(/Housekeeping pay: Edita and Karina have no staff record yet/).waitFor({ timeout: 5000 })
      passes++

      // Logins: Edyta has no mobile and is offered Edita's summary number; Karina
      // already has one; Toby's test login is nobody's.
      const useBtn = pg.getByRole('button', { name: 'Use 07700 900123' })
      check('logins: Edyta offered the summary number', (await useBtn.count()) === 1)
      check('logins: no offer for a login that has a mobile or is not a housekeeper', (await pg.getByRole('button', { name: /^Use 0/ }).count()) === 1)
      await useBtn.click()
      await pg.waitForTimeout(500)
      const sm = adminCalls.find((x) => x.action === 'users.setMobile')
      check('logins: setMobile sent for Edyta with the number', sm && JSON.stringify(sm).indexOf('u-ed') !== -1 && JSON.stringify(sm).indexOf('07700 900123') !== -1, JSON.stringify(sm))

      // Add Edita: the form comes up filled in.
      await pg.getByRole('button', { name: '+ Add Edita' }).click()
      await pg.getByText('New Staff Member').waitFor({ timeout: 5000 })
      const form = pg.locator('#staff-form')
      const vals = await form.locator('input').evaluateAll((els) => els.map((e) => e.value))
      check('form: initials suggested and not clashing', vals.indexOf('ED2') !== -1, JSON.stringify(vals))
      check('form: name Edita', vals.indexOf('Edita') !== -1, JSON.stringify(vals))
      check('form: phone from WhatsApp settings', vals.indexOf('07700 900123') !== -1, JSON.stringify(vals))
      check('form: role Housekeeping', (await form.locator('select').first().inputValue()) === 'Housekeeping')
      check('form: one rate line from 5 Oct', (await pg.getByLabel('Rate starts').count()) === 1 && (await pg.getByLabel('Rate starts').inputValue()) === '2026-10-05')
      await pg.getByLabel('Pounds an hour').fill('15')
      await pg.getByRole('button', { name: 'Add Staff Member', exact: true }).click()
      await pg.waitForTimeout(800)
      const ed = (appData.hawthbush_staff_v5 || []).find((x) => x.id === 'ED2')
      check('saved: Edita with role, phone and her rate', ed && ed.role === 'Housekeeping' && ed.name === 'Edita' && ed.phone === '07700 900123' &&
        ed.rates.length === 1 && ed.rates[0].from === '2026-10-05' && ed.rates[0].rate === 15, JSON.stringify(ed))
      check('saved: others untouched', appData.hawthbush_staff_v5.some((x) => x.id === 'TM' && x.rate === '£15 incl Roll Up') && appData.hawthbush_staff_v5.some((x) => x.id === 'ED' && x.name === 'Ed Smith'))
      const body = await pg.locator('body').innerText()
      check('prompt: now only Karina', /Housekeeping pay: Karina has no staff record yet/.test(body) && !/\+ Add Edita/.test(body), body.slice(0, 800))
      check('card: rate shown', /£15\.00\/hr from/.test(body), (body.match(/£15[^\n]*/g) || []).join(' / '))

      // Her login's spelling counts: a record named "Edyta Nowak" is Edita.
      appData.hawthbush_staff_v5 = [{ id: 'EN', name: 'Edyta Nowak', role: 'Housekeeping', active: true, email: '', phone: '', notes: '',
        rates: [{ from: '2026-10-05', rate: 15, holidayRollup: false }] }]
      await pg.reload()
      await pg.getByText('Settings', { exact: true }).first().waitFor({ timeout: 15000 })
      await pg.getByText('Settings', { exact: true }).first().click().catch(() => {})
      await pg.getByText('Staff', { exact: true }).first().click()
      await pg.getByText('Staff Database').waitFor({ timeout: 10000 })
      await pg.waitForTimeout(400)
      const b2 = await pg.locator('body').innerText()
      check('alias: Edyta counts as Edita', /Housekeeping pay: Karina has no staff record yet/.test(b2), b2.slice(0, 800))
      check('no page errors', c.errors.length === 0, c.errors.join(' | '))
    } finally { await c.close() }
  } catch (e) { fails.push('run: ' + e.message) }

  console.log(passes + ' passed, ' + fails.length + ' failed')
  fails.forEach((f) => console.log('  FAIL ' + f))
  process.exit(fails.length ? 1 : 0)
})()
