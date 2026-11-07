// tests/todo-photo-purge-test.cjs — netlify/functions/todo-photo-purge.js with
// the database and Storage faked at fetch. The SQL is pinned separately by
// supabase/2026-11-07i-todo-photo-purge-test.sql.
//   node tests/todo-photo-purge-test.cjs
const assert = require('assert')
const path = require('path')

process.env.SUPABASE_SERVICE_KEY = 'svc'
process.env.HBF_ADMIN_TOKEN = 'tok'
const fn = require(path.join(__dirname, '..', 'netlify/functions/todo-photo-purge.js'))

let passed = 0
async function ok(name, f) { await f(); passed++; console.log('  ok  ' + name) }

// A fake world: to-dos with photos, two buckets, and switches to make a bucket fail.
function world(todos, opts) {
  const o = opts || {}
  const files = { 'todo-photos': new Set(), 'booking-files': new Set() }
  todos.forEach((t) => t.paths.forEach((p) => files[/^todos\//.test(p) ? 'booking-files' : 'todo-photos'].add(p)))
  const calls = []
  global.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {}
    calls.push({ url, method: init && init.method, body, headers: init && init.headers })
    const res = (status, data) => ({ ok: status < 300, status, text: async () => JSON.stringify(data) })
    if (url.endsWith('/rpc/todo_worker_old_photos')) {
      return res(200, todos.filter((t) => t.photosLeft).slice(0, body.p_limit).map((t) => ({ id: t.id, paths: t.paths })))
    }
    if (url.endsWith('/rpc/todo_worker_photos_cleared')) {
      let n = 0
      todos.forEach((t) => { if (body.p_ids.includes(t.id) && t.photosLeft) { t.photosLeft = false; n++ } })
      return res(200, n)
    }
    const m = /\/storage\/v1\/object\/([a-z-]+)$/.exec(url)
    if (m && init.method === 'DELETE') {
      if (o.fail === m[1]) return res(500, { error: 'boom' })
      const gone = body.prefixes.filter((p) => files[m[1]].delete(p))
      return res(200, gone.map((name) => ({ name })))
    }
    throw new Error('unexpected fetch ' + url)
  }
  return { files, calls, todos }
}

;(async () => {
  await ok('refuses without the token', async () => {
    const r = await fn.handler({ httpMethod: 'POST', headers: {} })
    assert.strictEqual(r.statusCode, 403)
  })

  await ok('deletes the files in both buckets, then clears the to-dos', async () => {
    const w = world([
      { id: 'td_aaaaaa', paths: ['td_aaaaaa/1.jpg', 'td_aaaaaa/2.jpg'], photosLeft: true },
      { id: 'td_bbbbbb', paths: ['todos/td_bbbbbb/x.jpg'], photosLeft: true },
    ])
    const r = await fn.handler({ httpMethod: 'POST', headers: { 'x-admin-token': 'tok' } })
    const out = JSON.parse(r.body)
    assert.strictEqual(r.statusCode, 200)
    assert.deepStrictEqual([out.todos, out.files, out.failed], [2, 3, 0])
    assert.strictEqual(w.files['todo-photos'].size + w.files['booking-files'].size, 0, 'every file gone')
    assert.ok(w.todos.every((t) => !t.photosLeft))
    // A month back, as an ISO time.
    const sent = w.calls.find((c) => c.url.endsWith('/rpc/todo_worker_old_photos')).body.p_before
    const days = (Date.now() - Date.parse(sent)) / 86400000
    assert.ok(days > 29.9 && days < 30.1, 'cut-off ' + days)
    // Deletes use the service key.
    assert.ok(w.calls.filter((c) => c.method === 'DELETE').every((c) => c.headers.Authorization === 'Bearer svc'))
  })

  await ok('a failed delete leaves those to-dos for tomorrow, and clears the rest', async () => {
    const w = world([
      { id: 'td_cccccc', paths: ['td_cccccc/1.jpg'], photosLeft: true },
      { id: 'td_dddddd', paths: ['todos/td_dddddd/1.jpg'], photosLeft: true },
    ], { fail: 'booking-files' })
    const out = JSON.parse((await fn.handler({ httpMethod: 'POST', headers: { 'x-admin-token': 'tok' } })).body)
    assert.deepStrictEqual([out.todos, out.failed], [1, 1])
    assert.strictEqual(w.todos.find((t) => t.id === 'td_dddddd').photosLeft, true, 'still has its photos to try again')
  })

  await ok('a path not shaped like this to-do\'s is never deleted', async () => {
    const w = world([
      { id: 'td_eeeeee', paths: ['td_ffffff/someone-elses.jpg'], photosLeft: true },
      { id: 'td_gggggg', paths: ['td_gggggg/../../x.jpg'], photosLeft: true },
    ])
    const out = JSON.parse((await fn.handler({ httpMethod: 'POST', headers: { 'x-admin-token': 'tok' } })).body)
    assert.strictEqual(out.skipped, 2)
    assert.strictEqual(w.calls.filter((c) => c.method === 'DELETE' && c.body.prefixes.length).length, 0, 'nothing deleted')
    assert.strictEqual(w.files['todo-photos'].size, 2)
  })

  await ok('nothing to do', async () => {
    const w = world([])
    const out = JSON.parse((await fn.handler({ httpMethod: 'POST', headers: { 'x-admin-token': 'tok' } })).body)
    assert.deepStrictEqual([out.todos, out.files], [0, 0])
    assert.strictEqual(w.calls.length, 1)
  })

  await ok('the cron shim calls the worker with the token, and netlify.toml schedules the shim', async () => {
    const fs = require('fs')
    const toml = fs.readFileSync(path.join(__dirname, '..', 'netlify.toml'), 'utf8')
    assert.ok(/\[functions\."todo-photo-purge-cron"\]\s*\n\s*schedule = "[^"]+"/.test(toml), 'scheduled')
    assert.ok(!/\[functions\."todo-photo-purge"\]/.test(toml), 'the worker itself is not scheduled')
    let seen = null
    global.fetch = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, text: async () => '{}' } }
    delete require.cache[require.resolve(path.join(__dirname, '..', 'netlify/functions/todo-photo-purge-cron.js'))]
    const cron = require(path.join(__dirname, '..', 'netlify/functions/todo-photo-purge-cron.js'))
    await cron.handler()
    assert.ok(seen.url.endsWith('/.netlify/functions/todo-photo-purge') && seen.init.headers['x-admin-token'] === 'tok')
  })

  console.log(passed + ' passed')
})().catch((e) => { console.error(e); process.exit(1) })
