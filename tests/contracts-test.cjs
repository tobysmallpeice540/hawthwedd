// tests/contracts-test.cjs
//
// Contracts signed in the app (4 Nov 2026): the template model
// (src/shared/contractDoc.js), the PDF (contract-lib/pdf.js), and the three
// functions — contract-sign, contract-admin, contract-reminders — with
// Supabase, Resend and the Supabase auth endpoints faked at fetch.
//
//   node tests/contracts-test.cjs
//
// The SQL side is pinned by supabase/2026-11-04a-contracts-test.sql; the
// screens by tests/contracts-e2e.cjs.

process.env.SUPABASE_SERVICE_KEY = 'svc-key'
process.env.RESEND_API_KEY = 're-key'
process.env.HBF_ADMIN_TOKEN = 'admin-token-123'

const path = require('path')
const ROOT = path.join(__dirname, '..')

let passes = 0; const fails = []
const check = (n, ok, d) => { if (ok) passes++; else fails.push(n + (d !== undefined ? ': ' + (typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 400) : '')) }

// ── A fake world ────────────────────────────────────────────────────────────
const world = {
  users: { 'couple-jwt': { id: 'u-sam', email: 'Sam@Example.com' }, 'admin-jwt': { id: 'u-admin', email: 'office@hawthbushfarm.co.uk' } },
  profiles: { 'u-admin': { role: 'admin', active: true, name: 'Rosanna Greenwood' } },
  appData: {},
  rpc: {},
  emails: [], uploads: [], deletes: [], rpcCalls: [],
}
function json(status, body) { return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body } }

global.fetch = async function (url, opt) {
  const o = opt || {}
  const u = new URL(url)
  const auth = String((o.headers || {}).Authorization || '').replace(/^Bearer /, '')
  if (u.host === 'api.resend.com') { world.emails.push(JSON.parse(o.body)); return json(200, { id: 'e' + world.emails.length }) }
  if (u.pathname === '/auth/v1/user') { const usr = world.users[auth]; return usr ? json(200, usr) : json(401, { msg: 'bad jwt' }) }
  if (u.pathname === '/auth/v1/admin/users') return json(422, { msg: 'exists' })
  if (u.pathname === '/auth/v1/admin/generate_link') {
    const b = JSON.parse(o.body)
    return json(200, { properties: { hashed_token: 'tok-' + b.email, email_otp: '12345678' } })
  }
  if (u.pathname.startsWith('/rest/v1/rpc/')) {
    const fn = u.pathname.split('/').pop()
    const args = o.body ? JSON.parse(o.body) : {}
    world.rpcCalls.push({ fn, args, as: auth })
    const h = world.rpc[fn]
    if (!h) return json(404, { code: 'PGRST202', message: 'no ' + fn })
    return json(200, await h(args, auth))
  }
  if (u.pathname.startsWith('/rest/v1/profiles')) {
    const id = (u.searchParams.get('id') || '').replace(/^eq\./, '')
    return json(200, world.profiles[id] ? [world.profiles[id]] : [])
  }
  if (u.pathname === '/rest/v1/app_data') {
    if ((o.method || 'GET') === 'GET') {
      const k = (u.searchParams.get('key') || '').replace(/^eq\./, '')
      return json(200, world.appData[k] !== undefined ? [{ key: k, value: world.appData[k] }] : [])
    }
    const b = JSON.parse(o.body); world.appData[b.key] = b.value; return json(201, [])
  }
  if (u.pathname.startsWith('/storage/v1/object/sign/')) return json(200, { signedURL: '/object/sign/booking-files/x?token=t' })
  if (u.pathname.startsWith('/storage/v1/object/booking-files/')) {
    world.uploads.push({ path: u.pathname.replace('/storage/v1/object/booking-files/', ''), bytes: o.body })
    return json(200, { Key: 'k' })
  }
  if (u.pathname === '/storage/v1/object/booking-files' && o.method === 'DELETE') { world.deletes.push(JSON.parse(o.body)); return json(200, []) }
  return json(404, { error: 'not faked: ' + u.pathname })
}

;(async () => {
  const D = await import(path.join(ROOT, 'src/shared/contractDoc.js'))
  const { DEFAULT_CONTRACT_TEMPLATE } = await import(path.join(ROOT, 'src/shared/contractTemplate.js'))

  // ── 1. The template model ─────────────────────────────────────────────────
  const p = D.parseContractTemplate(DEFAULT_CONTRACT_TEMPLATE)
  check('T1 the standard form parses with no warnings', p.warnings.length === 0, p.warnings)
  check('T2 every field in it is a known one', p.custom.length === 0, p.custom)
  check('T3 it has each section once', p.blocks.accommodation === 1 && p.blocks.signatures === 1 && p.blocks.invoicing === 1 && p.blocks.requirements === 1, p.blocks)
  const f = { eventName: 'Sam & Alex', eventType: 'Wedding (Peak)', eventDate: '2027-09-18', accessBefore: 'Midday to 4.30pm',
    accessDay: '10am to Midnight', accessAfter: '10am to 11.30am', maxGuests: '200', venueFee: '5670', nonStandard: '',
    amlyFee: '1050', amlyFrom: '2027-09-17', amlyTo: '2027-09-19', glampingFeePd: '1750', glampingFrom: '2027-09-18',
    glampingTo: '2027-09-19', glamping2Fee: '2675', glamping2From: '2027-09-17', glamping2To: '2027-09-19' }
  const acc = D.contractAccommodation(f)
  check('T4 only properties with a fee are offered', acc.map((r) => r.key).join() === 'amly,glamping', acc)
  check('T5 glamping shows both prices', acc[1].options.length === 2 && acc[1].options[1].fee === '2675')
  const r = D.resolveContractNodes(p.nodes, { fields: f, event: { id: 9 }, hasAccommodation: true, today: '2026-11-04' })
  const txt = JSON.stringify(r.blocks)
  check('T6 fields are filled in', /£5,670/.test(txt) && /18 September 2027/.test(txt) && !/\{\{/.test(txt))
  check('T7 an empty non-standard terms says N/A', /"Non standard terms","N\/A"/.test(txt))
  check('T8 the accommodation page and Part C are there with accommodation', /Accommodation booking/.test(txt) && /Part C — Accommodation/.test(txt))
  const r2 = D.resolveContractNodes(p.nodes, { fields: Object.assign({}, f, { amlyFee: '', glampingFeePd: '', glamping2Fee: '' }), event: { id: 9 }, hasAccommodation: false })
  const txt2 = JSON.stringify(r2.blocks)
  check('T9 …and both are left out without', !/"Accommodation booking"/.test(txt2) && !/Part C — Accommodation/.test(txt2) && !r2.blocks.some((b) => b.t === 'accommodation'))
  const brk = (bl) => bl.every((b, i) => b.t !== 'break' || (i > 0 && i < bl.length - 1 && bl[i - 1].t !== 'break'))
  check('T10 never a page break first, last or twice', brk(r.blocks) && brk(r2.blocks))
  check('T11 the event page comes before the accommodation page, then the declaration, then the terms',
    txt.indexOf('Event booking') < txt.indexOf('Accommodation booking') && txt.indexOf('Accommodation booking') < txt.indexOf('"Declaration"') && txt.indexOf('"Declaration"') < txt.indexOf('Part A — General Terms'))

  const own = D.parseContractTemplate('# Wake\n\nCeremony at {{Ceremony location}} for {{Event name}}.\n[[Nonsense]]\n[[If accommodation]]\nOnly with rooms\n')
  check('T12 an unknown {{label}} is the template\'s own field', own.custom.join() === 'Ceremony location', own.custom)
  check('T13 an unknown [[block]] and an unclosed [[If]] are warned about', own.warnings.length === 2, own.warnings)
  const own2 = D.resolveContractNodes(own.nodes, { fields: { eventName: 'Cyril' }, custom: { 'Ceremony location': 'the woodland' }, hasAccommodation: false })
  check('T14 own fields fill in, and a missing [[Signatures]] is added at the end',
    /the woodland/.test(JSON.stringify(own2.blocks)) && own2.blocks[own2.blocks.length - 1].t === 'signatures')
  const tbl = D.parseContractTemplate('| A | B |\n|---|---|\n| 1 | 2 |\n- one\n- two\nText')
  check('T15 tables (with a header row), bullets and text', tbl.nodes.map((n) => n.t).join() === 'table,ul,p' && tbl.nodes[0].head && tbl.nodes[0].rows.length === 2, tbl.nodes)

  const body = { accommodation: acc, data: f }
  const full = { client1Name: 'Sam', client1Mobile: '1', client2Name: 'Alex', client2Mobile: '2', address: 'x', amly: 'no', glamping: 'hold', glampingNights: 2 }
  check('M1 nothing missing when complete', D.contractMissing(body, false, full).length === 0)
  check('M2 glamping held needs a number of nights', D.contractMissing(body, false, Object.assign({}, full, { glampingNights: null })).join() === 'glampingNights')
  check('M3 glamping No needs no nights', D.contractMissing(body, false, Object.assign({}, full, { glamping: 'no', glampingNights: null })).length === 0)
  check('M4 one signer needs no second name', D.contractMissing(body, true, Object.assign({}, full, { client2Name: '', client2Mobile: '' })).length === 0)
  const v = D.contractValuesForReview(body, full)
  check('R1 answers come back in SignWell\'s shape for the review',
    v['Glamping 2 night'] === 'Hold' && v.Glamping === 'No' && v.Amly === 'No' && v['Amly From'] === '17/09/2027' && v['Glamping 2 fee'] === '2675', v)
  check('K1 kinds of event', D.contractKindOf('Wedding (Off Peak)') === 'wedding' && D.contractKindOf('Wake') === 'wake' && D.contractKindOf('Party') === 'party' && D.contractKindOf('Other') === 'other')

  // ── 2. The PDF ────────────────────────────────────────────────────────────
  const { renderContractPdf, safe } = require(path.join(ROOT, 'netlify/functions/contract-lib/pdf.js'))
  check('P1 characters the PDF fonts cannot draw are replaced, never thrown', safe('Zoë → café 😀 “quoted” £5 · ok') === 'Zoë -> café  “quoted” £5 · ok', safe('Zoë → café 😀 “quoted” £5 · ok'))
  const cbody = { format: 1, title: 'Booking Form', event: { id: 9, name: 'Sam & Alex', date: '2027-09-18' }, blocks: r.blocks, accommodation: acc, data: f,
    venue: { company: 'Hawthbush Farm Ltd', name: 'Rosanna Greenwood', signed_at: '2026-11-04T10:00:00Z' } }
  const contract = { id: '11111111-2222-4333-8444-555555555555', event_id: 9, version: 1, status: 'signed', body: cbody, body_sha256: 'a'.repeat(64),
    final_sha256: 'b'.repeat(64), one_signer: false, sent_at: '2026-11-04T10:00:00Z', signed_at: '2026-11-05T19:00:00Z', answers: full,
    signers: [{ role: 'client1', name: 'Sam', email: 'sam@example.com', signed_name: 'Sam Smith', signed_at: '2026-11-05T18:00:00Z', ip: '1.2.3.4' },
              { role: 'client2', name: 'Alex', email: 'alex@example.com', signed_name: 'Alex Jones 🎉', signed_at: '2026-11-05T19:00:00Z', ip: '1.2.3.4' }],
    log: [{ at: '2026-11-04T10:00:00Z', what: 'Sent for signing (version 1)', who: 'Rosanna' }] }
  const t0 = Date.now()
  const pdf = await renderContractPdf(contract)
  check('P2 a signed form renders as a PDF', pdf.slice(0, 5).toString() === '%PDF-' && pdf.length > 50000, pdf.length)
  check('P3 quickly (Netlify allows 10 seconds)', Date.now() - t0 < 4000, Date.now() - t0)

  // ── 3. contract-sign ──────────────────────────────────────────────────────
  const sign = require(path.join(ROOT, 'netlify/functions/contract-sign.js'))
  const call = (fnMod, jwt, b, headers) => fnMod.handler({ httpMethod: 'POST', headers: Object.assign({ authorization: 'Bearer ' + jwt, 'x-nf-client-connection-ip': '81.2.3.4', 'user-agent': 'Test UA' }, headers || {}), body: JSON.stringify(b) })

  let res = await call(sign, 'nobody', { action: 'sign', name: 'Sam', agree: true })
  check('S1 no session, no signature', res.statusCode === 401)
  res = await call(sign, 'couple-jwt', { action: 'sign', name: 'Sam Smith' })
  check('S2 the tick is required', res.statusCode === 400)

  world.rpc.ct_sign_service = (a) => ({ ok: false, error: 'incomplete', missing: ['address'] })
  res = await call(sign, 'couple-jwt', { action: 'sign', name: 'Sam Smith', agree: true })
  check('S3 incomplete is refused with what is missing', res.statusCode === 409 && JSON.parse(res.body).missing[0] === 'address', res.body)

  let signArgs = null
  world.rpc.ct_sign_service = (a) => { signArgs = a; return { ok: true, contract_id: contract.id, event_id: 9, role: 'client2', complete: true } }
  let setPdfCount = 0
  world.rpc.ct_service_contract = () => Object.assign({ ok: true }, contract, { pdf_path: null })
  world.rpc.ct_service_set_pdf = () => (++setPdfCount === 1 ? { ok: true } : { ok: false, error: 'already_or_not_signed' })
  world.rpc.ct_service_note = () => ({ ok: true })
  world.emails = []; world.uploads = []
  res = await call(sign, 'couple-jwt', { action: 'sign', name: '  Sam   Smith ', agree: true })
  const out = JSON.parse(res.body)
  check('S4 the last signature completes and seals', res.statusCode === 200 && out.complete && out.sealed, res.body)
  check('S5 the signer is who Supabase says, not who the browser says', signArgs && signArgs.p_user === 'u-sam' && signArgs.p_email === 'sam@example.com')
  check('S6 the typed name is tidied, the IP and browser recorded', signArgs.p_name === 'Sam Smith' && signArgs.p_ip === '81.2.3.4' && signArgs.p_ua === 'Test UA', signArgs)
  check('S7 the PDF is stored under the event', world.uploads.length === 1 && /^bookings\/9\/\d+_booking-form-v1-signed-Sam-Alex\.pdf$/.test(world.uploads[0].path), world.uploads.map((u) => u.path))
  const toClients = world.emails.filter((e) => e.to[0] !== 'hello@hawthbushfarm.co.uk')
  const toOffice = world.emails.filter((e) => e.to[0] === 'hello@hawthbushfarm.co.uk')
  check('S8 each client is emailed the signed copy', toClients.length === 2 && toClients.every((e) => e.attachments && Buffer.from(e.attachments[0].content, 'base64').slice(0, 5).toString() === '%PDF-'),
    world.emails.map((e) => e.to))
  check('S9 and the office', toOffice.length === 1 && toOffice[0].attachments.length === 1)
  check('S10 the clients\' email uses the editable wording', /Hello Sam,/.test(toClients[0].html) && /Your signed booking form/.test(toClients[0].subject))

  // Sealing again (the retry run after this one) does nothing.
  const L = require(path.join(ROOT, 'netlify/functions/contract-lib/common.js'))
  world.emails = []; world.uploads = []; world.deletes = []
  const again = await L.sealContract(contract.id)
  check('S11 a second sealing files nothing and emails nobody', !again.sealed && world.emails.length === 0 && world.deletes.length === 1, again)
  world.rpc.ct_service_contract = () => Object.assign({ ok: true }, contract, { pdf_path: 'bookings/9/x.pdf' })
  world.uploads = []
  const third = await L.sealContract(contract.id)
  check('S12 a contract that already has its PDF is not drawn again', !third.sealed && world.uploads.length === 0)

  // Not the last signature: a short note to the signer only.
  world.rpc.ct_sign_service = () => ({ ok: true, contract_id: contract.id, event_id: 9, role: 'client1', complete: false })
  world.rpc.ct_service_contract = () => Object.assign({ ok: true }, contract, { status: 'out', signers: [
    { role: 'client1', name: 'Sam', email: 'sam@example.com', signed_at: '2026-11-05T18:00:00Z' }, { role: 'client2', name: 'Alex', email: 'alex@example.com', signed_at: null }] })
  world.emails = []
  res = await call(sign, 'couple-jwt', { action: 'sign', name: 'Sam Smith', agree: true })
  check('S13 a first signature sends the signer a thank-you naming who is left', res.statusCode === 200 && world.emails.length === 1 &&
    world.emails[0].to[0] === 'sam@example.com' && /waiting for Alex/.test(world.emails[0].html), world.emails.map((e) => e.to))

  world.rpc.ct_my_pdf_path = (a, as) => (as === 'couple-jwt' ? 'bookings/9/x.pdf' : null)
  res = await call(sign, 'couple-jwt', { action: 'download' })
  check('S14 the couple get a short-lived link to their own signed copy', res.statusCode === 200 && /\/storage\/v1\/object\/sign\//.test(JSON.parse(res.body).url), res.body)
  check('S15 asked as the user, so it can only be theirs', world.rpcCalls.filter((c) => c.fn === 'ct_my_pdf_path').every((c) => c.as === 'couple-jwt'))

  // ── 4. contract-admin ─────────────────────────────────────────────────────
  const admin = require(path.join(ROOT, 'netlify/functions/contract-admin.js'))
  res = await call(admin, 'couple-jwt', { action: 'invite', contractId: contract.id })
  check('A1 only an admin', res.statusCode === 403)
  world.emails = []
  world.appData.hbf_email_log_v1 = []
  res = await call(admin, 'admin-jwt', { action: 'invite', contractId: contract.id })
  const inv = JSON.parse(res.body)
  check('A2 the invite goes only to who has not signed', res.statusCode === 200 && inv.results.length === 1 && inv.results[0].email === 'alex@example.com', res.body)
  const em = world.emails[0] || {}
  check('A3 with a sign-in link (to our own page) and a code', /\/portal#t=tok-alex%40example.com/.test(em.html || '') && /12345678/.test(em.html || ''), (em.html || '').slice(0, 200))
  check('A4 saying the other has already signed', /Sam has already signed/.test(em.html || ''))
  const logged = JSON.stringify(world.appData.hbf_email_log_v1)
  check('A5 the link is never written to the email log', !/tok-alex/.test(logged) && /contract-invite/.test(logged), logged.slice(0, 300))
  res = await call(admin, 'admin-jwt', { action: 'preview', body: cbody })
  check('A6 a preview PDF of a draft', res.statusCode === 200 && Buffer.from(JSON.parse(res.body).pdf, 'base64').slice(0, 5).toString() === '%PDF-')
  world.rpc.ct_service_contract = () => Object.assign({ ok: true }, contract, { status: 'signed', pdf_path: null })
  res = await call(admin, 'admin-jwt', { action: 'invite', contractId: contract.id })
  check('A7 a signed contract is not sent out again', res.statusCode === 409)

  // ── 5. contract-reminders ─────────────────────────────────────────────────
  const rem = require(path.join(ROOT, 'netlify/functions/contract-reminders.js'))
  const LAST = '2026-10-28T09:00:00.123456+00:00'
  let dueArg = null, marks = 0
  world.rpc.ct_service_due_reminders = (a) => { dueArg = a; return [{ id: contract.id, event_id: 9, event_name: 'Sam & Alex', event_date: '2027-09-18', last: LAST, unsigned: [{ name: 'Alex Jones', email: 'alex@example.com' }] }] }
  world.rpc.ct_service_mark_reminded = (a) => (++marks === 1 && a.p_last === LAST ? { ok: true } : { ok: false, error: 'taken' })
  world.rpc.ct_service_unsealed = () => []
  world.appData.hbf_portal_email_templates_v1 = []
  world.emails = []
  res = await rem.handler({ httpMethod: 'POST', headers: { 'x-admin-token': 'admin-token-123' }, body: '{}' })
  check('N1 off until switched on: nothing sent', res.statusCode === 200 && world.emails.length === 0 && marks === 0, res.body)
  res = await rem.handler({ httpMethod: 'POST', headers: { 'x-admin-token': 'wrong-token-xyz' }, body: '{}' })
  check('N2 a wrong token is refused', res.statusCode === 403)
  world.appData.hbf_portal_email_templates_v1 = [{ id: 'contract_reminder', on: true, everyDays: 14, subject: '', body: '' }]
  res = await rem.handler({ httpMethod: 'POST', headers: { 'x-admin-token': 'admin-token-123' }, body: '{}' })
  check('N3 on: the chosen frequency is asked for', dueArg && dueArg.p_every_days === 14, dueArg)
  check('N4 each unsigned client is reminded, marked first', world.emails.length === 1 && marks === 1 && world.emails[0].to[0] === 'alex@example.com')
  check('N5 the reminder links to the sign-in page, never a sign-in link', /href="https:\/\/hawthbushfarm\.netlify\.app\/portal"/.test(world.emails[0].html) && !/#t=/.test(world.emails[0].html))
  world.emails = []
  res = await rem.handler({ httpMethod: 'POST', headers: { 'x-admin-token': 'admin-token-123' }, body: '{}' })
  check('N6 a contract another run has just reminded is not reminded again', world.emails.length === 0 && JSON.parse(res.body).skipped === 1, res.body)
  res = await call(rem, 'admin-jwt', { dryRun: true })
  check('N7 the office can see whose is due, without sending', res.statusCode === 200 && JSON.parse(res.body).due.length === 1 && world.emails.length === 0)
  res = await call(rem, 'couple-jwt', { dryRun: true })
  check('N8 nobody else can', res.statusCode === 403)
  let sealedIds = []
  world.rpc.ct_service_unsealed = () => [contract.id]
  world.rpc.ct_service_contract = () => Object.assign({ ok: true }, contract, { pdf_path: null })
  setPdfCount = 0
  world.appData.hbf_portal_email_templates_v1 = []
  res = await rem.handler({ httpMethod: 'POST', headers: { 'x-admin-token': 'admin-token-123' }, body: '{}' })
  check('N9 a signed contract left without its PDF is sealed by the daily run', JSON.parse(res.body).sealed.length === 1, res.body)

  console.log(passes + ' passed' + (fails.length ? ', ' + fails.length + ' FAILED:\n  ' + fails.join('\n  ') : ''))
  process.exit(fails.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
