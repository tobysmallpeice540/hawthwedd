// Settings → WhatsApp, the checklist ticks, the letting consent tick and the
// mobile on Settings → Staff — on the BUILT app, Supabase and functions faked.
// npx vite build --outDir "$HOME/dist-check" --emptyOutDir && node tests/whatsapp-page-e2e.cjs
const assert = require('assert')
const path = require('path')
const { openStaff } = require('./portal-harness.cjs')
const T = require('../netlify/functions/whatsapp-reminders/templates.js')
const DIST = process.env.DIST || path.join(process.env.HOME, 'dist-check')

;(async () => {
  const s = await openStaff({ distDir: DIST, appData: { hbf_whatsapp_settings_v1: { templates: { checklist_live: { on: false } } },
    hbf_properties_v1: [{ id: 'hamlet', name: 'The Hamlet' }, { id: 'amly', name: 'Amly Barn' }],
    hbf_email_templates_v1: [
      { id: 'arrival_general', name: 'Arrival Info (General)', subject: 's', body: 'b', attachments: [{ name: 'hamlet.pdf', size: 2048, type: 'application/pdf', dataUrl: 'data:application/pdf;base64,SA==' }] },
      { id: 'arrival_event', name: 'Arrival Info (Wedding/Event)', subject: 's', body: 'b', attachments: [{ name: 'party.pdf', size: 2048, type: 'application/pdf', dataUrl: 'data:application/pdf;base64,UA==' }] }] } })
  const fnCalls = []
  let linked = false
  const catalogue = Object.keys(T.TEMPLATES).map((k) => ({ name: k, label: T.TEMPLATES[k].label, audience: T.TEMPLATES[k].audience,
    when: T.TEMPLATES[k].when, language: 'en_GB', fields: T.TEMPLATES[k].fields, defaultBody: T.TEMPLATES[k].body, footer: T.FOOTER,
    buttons: T.buttonLabels(k), status: k === 'checklist_live' ? 'APPROVED' : 'not submitted', submitted: null }))
  await s.page.route('**/.netlify/functions/**', async (route) => {
    const req = route.request(); const name = new URL(req.url()).pathname.split('/').pop()
    let body = {}; try { body = JSON.parse(req.postData() || '{}') } catch (e) {}
    fnCalls.push({ name, body })
    const reply = (o, st) => route.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(o) })
    if (name === 'whatsapp-send' && body.action === 'status') return reply({ configured: true,
      number: { display: '+44 1825 000000', name: 'Hawthbush Farm', nameStatus: 'APPROVED' }, numberOnAccount: true,
      linkedApps: linked ? ['Netlify HF app'] : [], templates: [], catalogue, staff: [{ name: 'Lisa', hasMobile: false }, { name: 'Toby', hasMobile: true }] })
    if (name === 'whatsapp-send' && body.action === 'subscribe') { linked = true; return reply({ ok: true }) }
    if (name === 'whatsapp-send' && body.action === 'submit') return reply({ ok: true, status: 'PENDING', edited: false })
    if (name === 'whatsapp-send' && body.action === 'log') return reply({ ok: true,
      people: [{ number: '447900683355', name: 'Toby', count: 2 }, { number: '447111222333', name: 'Karina', count: 1 }],
      messages: (body.number === '447111222333' ? [] : [{ id: 'w1', direction: 'out', number: '447900683355', to_name: 'Toby', template: 'checklist_live',
        body: 'Hi Toby, the Arrival checklist is now live', at: '2026-10-30T09:05:00Z', status: 'read' },
        { id: 'w2', direction: 'in', number: '447900683355', record_name: 'Emma Juner letting', body: 'Test hello', at: '2026-10-30T08:00:00Z', media: { type: 'image' } }]) })
    if (name === 'user-admin' && body.action === 'users.list') return reply({ ok: true, me: 'u1', users: [
      { id: 'u1', name: 'Toby', email: 't@x', role: 'admin', active: true, mobile: '447900683355' },
      { id: 'u2', name: 'Lisa', email: 'l@x', role: 'admin', active: true, mobile: null },
      { id: 'u3', name: 'Edyta cleaner', email: 'e@x', role: 'cleaner', active: true }] })
    if (name === 'user-admin' && body.action === 'users.setMobile') return reply({ ok: true, id: body.id, mobile: '447000000001' })
    return reply({ error: 'unexpected ' + name }, 404)
  })
  const page = s.page
  const writes = () => s.calls.filter((c) => c.fn === 'write:app_data').map((c) => c.args).join('\n')
  await page.getByText('Settings', { exact: true }).first().click()
  await page.getByText('WhatsApp', { exact: true }).first().click()

  // Setup
  await page.getByText('Sending from').waitFor({ timeout: 10000 })
  await page.getByRole('button', { name: 'Link it now' }).click()
  await page.getByText('Replies reach the app').waitFor({ timeout: 5000 })
  // Housekeepers start as Edita and Karina with no numbers; save one.
  const mobiles = page.getByPlaceholder('Mobile', { exact: true })
  assert.strictEqual(await mobiles.count(), 2)
  await mobiles.nth(1).fill('07111 222333')
  await page.getByRole('button', { name: 'Save numbers' }).click()
  await page.getByText("Housekeepers' numbers saved.").waitFor({ timeout: 5000 })
  assert.ok(/"recipients":\[\{"name":"Edita","mobile":""\},\{"name":"Karina","mobile":"07111 222333"\}\]/.test(writes()), writes().slice(-300))

  // Pre-arrival: day, gate code, a pack per property.
  await page.locator('select').filter({ hasText: 'the arrival day' }).selectOption('1')
  await page.getByText('Saved.').waitFor({ timeout: 5000 })
  assert.ok(/"daysBefore":1/.test(writes()))
  assert.ok(await page.getByText('change it on the Messages tab if it goes the day before').isVisible())
  await page.getByPlaceholder('e.g. 1234').fill('4321')
  const packs = page.getByPlaceholder("(optional) own link — else the arrival email's pack")
  assert.strictEqual(await packs.count(), 2, 'one pack link per property')
  await packs.nth(0).fill('not a link')
  await page.getByRole('button', { name: 'Save gate code and packs' }).click()
  await page.getByText('must be full web addresses').waitFor({ timeout: 3000 })
  await packs.nth(0).fill('https://example.com/hamlet.pdf')
  await page.getByRole('button', { name: 'Save gate code and packs' }).click()
  await page.getByText('Gate code and arrival packs saved.').waitFor({ timeout: 5000 })
  assert.ok(/"gateCode":"4321","packs":\{"hamlet":"https:\/\/example.com\/hamlet.pdf"\}/.test(writes()), writes().slice(-300))

  // Messages
  await page.getByRole('tab', { name: 'Messages' }).click()
  await page.getByText('Pre-arrival (guests)').waitFor({ timeout: 5000 })
  const card = page.locator('div', { has: page.getByText('Pre-arrival (guests)', { exact: true }) }).filter({ has: page.getByRole('button', { name: 'Wording' }) }).last()
  await card.getByRole('button', { name: 'Wording' }).click()
  const ta = card.locator('textarea')
  assert.strictEqual(await ta.inputValue(), T.TEMPLATES.pre_arrival.body)
  assert.ok(await card.getByText(/Hi Emma, we're looking forward to seeing you at The Hamlet later today. The gate code is 1234/).isVisible(), 'preview fills examples')
  for (const b of ['Before 6pm', '6pm to 9pm', 'After 9pm']) assert.ok(await card.getByText(b, { exact: true }).isVisible(), 'button ' + b)
  await ta.fill('Hi {{guestName}}, see you at {{property}} from {{checkInTime}} today. Safe travels.')
  await card.getByRole('button', { name: 'Submit to Meta' }).click()
  await page.getByText(/Sent to Meta/).waitFor({ timeout: 5000 })
  const sub = fnCalls.filter((c) => c.body.action === 'submit')[0]
  assert.strictEqual(sub.body.name, 'pre_arrival')
  assert.strictEqual(sub.body.body, 'Hi {{guestName}}, see you at {{property}} from {{checkInTime}} today. Safe travels.')
  assert.ok(/pre_arrival[^}]*"body":"Hi \{\{guestName\}\}, see you at/.test(writes()), 'wording kept in settings')
  // Switch the approved one on.
  const liveCard = page.locator('div', { has: page.getByText('Checklist is live', { exact: true }) }).filter({ has: page.getByRole('button', { name: 'Wording' }) }).last()
  await liveCard.getByLabel('Send').click()
  await page.getByText('Switched on.').waitFor({ timeout: 5000 })
  assert.ok(/"checklist_live":\{"on":true\}/.test(writes()))

  // Sent
  await page.getByRole('tab', { name: 'Sent' }).click()
  await page.getByText('Hi Toby, the Arrival checklist is now live').waitFor({ timeout: 5000 })
  assert.ok(await page.getByText('sent image').isVisible())
  await page.locator('select').filter({ hasText: 'Everyone' }).selectOption('447111222333')
  await page.getByText('Nothing yet.').waitFor({ timeout: 5000 })

  // Staff: a mobile box for every staff login, all optional.
  await page.getByText('Staff', { exact: true }).first().click()
  await page.getByPlaceholder('Mobile (optional)').first().waitFor({ timeout: 10000 })
  assert.strictEqual(await page.getByPlaceholder('Mobile (optional)').count(), 3)
  assert.strictEqual(await page.locator('input[value="07900 683355"]').count(), 1)
  await page.getByPlaceholder('Mobile (optional)').nth(1).fill('07000 000001')
  await page.getByPlaceholder('Mobile (optional)').nth(1).press('Enter')
  await page.getByText('Mobile saved.').waitFor({ timeout: 5000 })

  // Settings → Email templates → Lettings: each attachment says who it goes to
  // — a property on the General one, a kind of event on the Wedding/Event one.
  await page.getByText('Email templates', { exact: true }).first().click()
  await page.getByRole('button', { name: 'Arrival Info (General)' }).click()
  const forG = page.getByLabel('Who gets hamlet.pdf')
  await forG.waitFor({ timeout: 10000 })
  assert.deepStrictEqual(await forG.locator('option').allInnerTexts(), ['For everyone', 'For The Hamlet', 'For Amly Barn'])
  await forG.selectOption('hamlet')
  await page.getByRole('button', { name: 'Arrival Info (Wedding/Event)' }).click()
  const forE = page.getByLabel('Who gets party.pdf')
  assert.deepStrictEqual(await forE.locator('option').allInnerTexts(), ['For everyone', 'For Weddings', 'For Parties', 'For Celebrations of life', 'For Other events'])
  await forE.selectOption('event-party')
  await page.getByRole('button', { name: /^Save/ }).first().click()
  await page.waitForTimeout(600)
  const tw = s.calls.filter((c) => c.fn === 'write:app_data' && /hbf_email_templates_v1/.test(c.args)).map((c) => c.args).pop() || ''
  assert.ok(/"name":"hamlet.pdf"[^}]*"for":"hamlet"/.test(tw) && /"name":"party.pdf"[^}]*"for":"event-party"/.test(tw), tw.slice(0, 400))

  assert.deepStrictEqual(s.errors, [])
  await s.close()
  console.log('whatsapp-page-e2e: all tests passed')
})().catch((e) => { console.error(e); process.exit(1) })
