// Settings → WhatsApp and the mobile on Settings → Staff, on the BUILT app.
// npx vite build --outDir "$HOME/dist-check" --emptyOutDir && node tests/whatsapp-page-e2e.cjs
const assert = require('assert')
const path = require('path')
const { openStaff } = require('./portal-harness.cjs')
const DIST = process.env.DIST || path.join(process.env.HOME, 'dist-check')

;(async () => {
  const s = await openStaff({ distDir: DIST, appData: { hbf_whatsapp_settings_v1: { checklistReminders: { on: false, leadMin: 60 } } } })
  const fnCalls = []
  let linked = false
  await s.page.route('**/.netlify/functions/**', async (route) => {
    const req = route.request(); const name = new URL(req.url()).pathname.split('/').pop()
    let body = {}; try { body = JSON.parse(req.postData() || '{}') } catch (e) {}
    fnCalls.push(name + ':' + (body.action || ''))
    const reply = (o, st) => route.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(o) })
    if (name === 'whatsapp-send' && body.action === 'status') return reply({ configured: true,
      number: { display: '+44 1825 000000', name: 'Hawthbush Farm', nameStatus: 'PENDING_REVIEW' }, numberOnAccount: true,
      linkedApps: linked ? ['Netlify HF app'] : [], templates: [], catalogue: [{ name: 'checklist_reminder', label: 'Checklist reminder (staff)', language: 'en_GB', status: 'not submitted' }],
      staff: [{ name: 'Lisa', hasMobile: false }, { name: 'Toby', hasMobile: true }] })
    if (name === 'whatsapp-send' && body.action === 'subscribe') { linked = true; return reply({ ok: true }) }
    if (name === 'whatsapp-send' && body.action === 'createTemplate') return reply({ ok: true, status: 'PENDING' })
    if (name === 'user-admin' && body.action === 'users.list') return reply({ ok: true, me: 'u1', users: [
      { id: 'u1', name: 'Toby', email: 't@x', role: 'admin', active: true, mobile: '447900683355' },
      { id: 'u2', name: 'Lisa', email: 'l@x', role: 'admin', active: true, mobile: null },
      { id: 'u3', name: '', email: 'bar@x', role: 'bar', active: true }] })
    if (name === 'user-admin' && body.action === 'users.setMobile') return reply({ ok: true, id: body.id, mobile: '447000000001' })
    return reply({ error: 'unexpected ' + name }, 404)
  })
  const page = s.page
  await page.getByText('Settings', { exact: true }).first().click()
  await page.getByText('WhatsApp', { exact: true }).first().click()
  await page.getByText('Sending from').waitFor({ timeout: 10000 })
  assert.ok(await page.getByText('not linked to it yet').isVisible())
  await page.getByRole('button', { name: 'Link it now' }).click()
  await page.getByText('Replies reach the app').waitFor({ timeout: 5000 })
  await page.getByRole('button', { name: 'Submit to Meta' }).click()
  await page.getByText('Submitted to Meta').waitFor({ timeout: 5000 })
  assert.ok(await page.getByText('no mobile').isVisible(), 'Lisa shown without a mobile')
  await page.getByLabel('Send checklist reminders').click()
  await page.waitForTimeout(800)
  const msg = await page.locator('text=/Saved\.|refus|fail|error/i').first().textContent().catch(() => '(none)')
  console.log('after toggle:', msg)
  const wrote = s.calls.filter((c) => c.fn === 'write:app_data').map((c) => c.args).join('\n')
  assert.ok(/"on":true/.test(wrote) && /hbf_whatsapp_settings_v1/.test(wrote), 'reminders switched on and saved: ' + wrote.slice(0, 200))
  assert.ok(await page.getByText("Nothing will go until Meta approves").isVisible())

  // Staff: Toby's mobile shown pretty, Lisa's input flagged; the bar login has none.
  await page.getByText('Staff', { exact: true }).first().click()
  await page.getByPlaceholder('Add mobile').waitFor({ timeout: 10000 })
  assert.strictEqual(await page.locator('input[value="07900 683355"]').count(), 1)
  assert.strictEqual(await page.locator('input[type="tel"]').count(), 2, 'admins only')
  await page.getByPlaceholder('Add mobile').fill('07000 000001')
  await page.getByPlaceholder('Add mobile').press('Enter')
  await page.getByText('Mobile saved.').waitFor({ timeout: 5000 })
  assert.ok(fnCalls.includes('user-admin:users.setMobile'))
  assert.deepStrictEqual(s.errors, [])
  await s.close()
  console.log('whatsapp-page-e2e: all tests passed')
})().catch((e) => { console.error(e); process.exit(1) })
