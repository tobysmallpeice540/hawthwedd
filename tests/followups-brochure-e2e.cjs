// Settings → Email templates → Follow-ups: the brochure link box (5 Nov 2026)
// — on the BUILT app, Supabase and functions faked.
// npx vite build --outDir "$HOME/dist-check" --emptyOutDir && node tests/followups-brochure-e2e.cjs
const assert = require('assert')
const path = require('path')
const { openStaff } = require('./portal-harness.cjs')
const DIST = process.env.DIST || path.join(process.env.HOME, 'dist-check')

;(async () => {
  // Saved before the brochure tick existed: the first follow-up shows it on
  // (the standard), the second off.
  const s = await openStaff({ distDir: DIST, appData: { hbf_automations_v1: {
    followup: { on: true, days: 7, subject: 'Following up', body: 'Hello {firstName},\n\nThanks.' },
    second: { on: true, days: 14, subject: 'Still thinking?', body: 'Hello {firstName},\n\nStill?' } } } })
  const { page } = s
  await page.route('**/.netlify/functions/automations', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, dryRun: true, today: '2026-11-05', gmail: { source: 'farm', account: 'hawthbushfarm@gmail.com', checked: 2 },
      due: [{ kind: 'followup', who: 'Phone Person', subject: 'Following up', brochure: true },
            { kind: 'followup', who: 'Web Person', subject: 'Following up', brochure: false }], waiting: [], freeze: [] }) }))

  await page.getByText('Settings', { exact: true }).first().click()
  await page.getByText('Email templates', { exact: true }).first().click()
  await page.getByText('Follow-ups', { exact: true }).first().click()
  const ticks = page.getByLabel('Add the brochure link for enquiries that have not had the brochure')
  await ticks.first().waitFor({ timeout: 10000 })
  assert.strictEqual(await ticks.count(), 3, 'one tick per follow-up')
  assert.deepStrictEqual([await ticks.nth(0).isChecked(), await ticks.nth(1).isChecked(), await ticks.nth(2).isChecked()], [true, false, false])
  const boxes = page.getByLabel('Brochure paragraph')
  assert.strictEqual(await boxes.nth(0).inputValue(), 'If you would like to see more of the farm, our brochure is here: {brochureUrl}')
  assert.ok(await boxes.nth(1).isDisabled(), 'the paragraph is greyed out while its tick is off')

  // The preview says who would get the link.
  await page.getByRole('button', { name: 'What would go today?' }).click()
  await page.getByText(/Phone Person/).waitFor({ timeout: 5000 })
  assert.ok(/with the brochure link/.test(await page.getByText(/Phone Person/).locator('..').innerText()))
  assert.ok(!/with the brochure link/.test(await page.getByText(/Web Person/).locator('..').innerText()))

  // Change the wording, tick the second on, save: both are written.
  await boxes.nth(0).fill('Our brochure: {brochureUrl}')
  await ticks.nth(1).check()
  await page.getByRole('button', { name: 'Save follow-ups' }).click()
  await page.waitForTimeout(600)
  const w = s.calls.filter((c) => c.fn === 'write:app_data' && /hbf_automations_v1/.test(c.args)).map((c) => c.args).pop() || ''
  const saved = JSON.parse(w).value
  assert.strictEqual(saved.followup.brochureText, 'Our brochure: {brochureUrl}')
  assert.deepStrictEqual([saved.followup.brochureOn, saved.second.brochureOn, saved.third.brochureOn], [true, true, false])
  assert.strictEqual(saved.followup.body, 'Hello {firstName},\n\nThanks.', 'the wording itself is untouched')

  assert.deepStrictEqual(s.errors, [], 'no page errors')
  await s.close()
  console.log('followups-brochure-e2e: all passed')
})().catch((e) => { console.error(e); process.exit(1) })
