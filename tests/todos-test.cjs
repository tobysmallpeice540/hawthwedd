// tests/todos-test.cjs — the to-do list's rules (src/shared/todos.js).
//   node tests/todos-test.cjs
const assert = require('assert')
const path = require('path')

;(async () => {
  const T = await import(path.join(__dirname, '..', 'src/shared/todos.js'))
  let n = 0
  const ok = (name, fn) => { fn(); n++; console.log('  ok  ' + name) }

  ok('priority is a scope counted from the day it was set', () => {
    assert.strictEqual(T.todoDueOn({ priority: 'day', setOn: '2026-11-06' }), '2026-11-07')
    assert.strictEqual(T.todoDueOn({ priority: 'week', setOn: '2026-11-06' }), '2026-11-13')
    // "1 month" put on the 20th means within four weeks of the 20th
    assert.strictEqual(T.todoDueOn({ priority: 'month', setOn: '2026-11-20' }), '2026-12-18')
    assert.strictEqual(T.todoDueOn({ priority: 'eventually', setOn: '2026-11-20' }), null)
  })

  ok('a deadline wins when it comes first, and stands alone for Eventually', () => {
    assert.strictEqual(T.todoDueOn({ priority: 'month', setOn: '2026-11-06', deadline: '2026-11-10' }), '2026-11-10')
    assert.strictEqual(T.todoDueOn({ priority: 'day', setOn: '2026-11-06', deadline: '2026-11-30' }), '2026-11-07')
    assert.strictEqual(T.todoDueOn({ priority: 'eventually', deadline: '2026-12-01' }), '2026-12-01')
    assert.strictEqual(T.todoDueOn({ priority: 'eventually', deadline: 'soon' }), null)
  })

  ok('timing: overdue only once the due day has passed', () => {
    const t = { priority: 'day', setOn: '2026-11-06' }   // due 7th
    assert.strictEqual(T.todoTiming(t, '2026-11-06'), 'soon')
    assert.strictEqual(T.todoTiming(t, '2026-11-07'), 'today')
    assert.strictEqual(T.todoTiming(t, '2026-11-08'), 'overdue')
    assert.strictEqual(T.todoTiming({ priority: 'eventually' }, '2026-11-08'), 'none')
  })

  const me = { id: 'u1', role: 'admin' }
  ok('for me: my name, my group, or Everyone', () => {
    assert.ok(T.todoIsFor({ who: 'person:u1' }, me))
    assert.ok(T.todoIsFor({ who: 'role:admin' }, me))
    assert.ok(T.todoIsFor({ who: 'anyone' }, me))
    assert.ok(!T.todoIsFor({ who: 'person:u2' }, me))
    assert.ok(!T.todoIsFor({ who: 'role:bar' }, me))
  })

  ok('bar and housekeeping see theirs, Everyone\'s and what they wrote; the office sees all', () => {
    const hk = { id: 'c1', role: 'cleaner' }
    assert.ok(T.todoVisibleTo({ who: 'role:cleaner' }, hk))
    assert.ok(T.todoVisibleTo({ who: 'anyone' }, hk))
    assert.ok(T.todoVisibleTo({ who: 'role:admin', createdById: 'c1' }, hk))
    assert.ok(!T.todoVisibleTo({ who: 'person:u1' }, hk))
    assert.ok(T.todoVisibleTo({ who: 'person:u2' }, me))
  })

  ok('private to-dos: the writer and the named person only — not the rest of the office', () => {
    const t = { who: 'person:u2', private: true, createdById: 'u1' }
    assert.ok(T.todoVisibleTo(t, { id: 'u1', role: 'admin' }))
    assert.ok(T.todoVisibleTo(t, { id: 'u2', role: 'admin' }))
    assert.ok(!T.todoVisibleTo(t, { id: 'u3', role: 'admin' }))
    assert.ok(!T.todoVisibleTo({ who: 'role:admin', private: true, createdById: 'u1' }, { id: 'u3', role: 'admin' }))
  })

  ok('private projects: the project and everything in it are the owner\'s alone', () => {
    const projects = [{ id: 'p', name: 'Mine', private: true, ownerId: 'u1' }, { id: 'q', name: 'Ours' }]
    assert.ok(T.todoListVisibleTo(projects[0], { id: 'u1' }))
    assert.ok(!T.todoListVisibleTo(projects[0], { id: 'u2' }))
    assert.ok(T.todoListVisibleTo(projects[1], { id: 'u2' }))
    const t = { who: 'anyone', project: 'p', createdById: 'u3' }
    assert.ok(T.todoVisibleTo(t, { id: 'u1', role: 'admin' }, projects))
    assert.ok(!T.todoVisibleTo(t, { id: 'u2', role: 'admin' }, projects))
    assert.ok(!T.todoVisibleTo(t, { id: 'u3', role: 'cleaner' }, projects), 'not even its writer')
    assert.ok(T.todoVisibleTo({ who: 'anyone', project: 'q' }, { id: 'u2', role: 'bar' }, projects))
  })

  const today = '2026-11-06'
  const todos = [
    { id: 'a', title: 'Late', priority: 'day', setOn: '2026-11-01', who: 'person:u1', area: 'hamlet', project: 'p1', createdAt: '1' },
    { id: 'b', title: 'Week', priority: 'week', setOn: '2026-11-06', who: 'role:bar', area: 'grain-store', createdAt: '2' },
    { id: 'c', title: 'Someday', priority: 'eventually', who: 'anyone', project: 'p1', createdAt: '3' },
    { id: 'd', title: 'Done', priority: 'day', setOn: '2026-11-01', state: 'done', doneAt: new Date().toISOString(), createdAt: '4' },
    { id: 'e', title: 'Gone area', priority: 'month', setOn: '2026-11-06', area: 'deleted-area', who: 'person:zz', whoLabel: 'Old Name', createdAt: '5' },
  ]
  const ctx = { today, me, people: [{ who: 'person:u1', label: 'Toby' }, { who: 'role:admin', label: 'Office' }, { who: 'role:bar', label: 'Bar' }, { who: 'anyone', label: 'Everyone' }],
    areas: T.TODO_DEFAULT_AREAS, projects: [{ id: 'p1', name: 'Barn roof' }, { id: 'p2', name: 'Empty' }] }

  ok('by priority: overdue first whatever its priority, done left out, empty groups left out', () => {
    const g = T.todoGroups(todos, 'priority', ctx)
    assert.deepStrictEqual(g.map((x) => x.key), ['overdue', 'week', 'month', 'eventually'])
    assert.deepStrictEqual(g[0].items.map((x) => x.id), ['a'])
    assert.deepStrictEqual(g[1].preset, { priority: 'week' })
  })

  ok('by person: me first, a person no longer listed keeps the saved name', () => {
    const g = T.todoGroups(todos, 'person', ctx)
    assert.strictEqual(g[0].key, 'person:u1')
    assert.strictEqual(g[0].label, 'Toby (me)')
    const gone = g.find((x) => x.key === 'person:zz')
    assert.strictEqual(gone.label, 'Old Name')
    assert.deepStrictEqual(g.find((x) => x.key === 'anyone').items.map((x) => x.id), ['c'])
  })

  ok('by project and area: list order, then None; an unknown id counts as none', () => {
    const p = T.todoGroups(todos, 'project', ctx)
    assert.deepStrictEqual(p.map((x) => x.label), ['Barn roof', 'No project'])
    assert.deepStrictEqual(p[0].items.map((x) => x.id), ['a', 'c'])
    assert.deepStrictEqual(p[0].preset, { project: 'p1' })
    const a = T.todoGroups(todos, 'area', ctx)
    assert.deepStrictEqual(a.map((x) => x.key), ['grain-store', 'hamlet', '__none'])
    assert.ok(a.find((x) => x.key === '__none').items.some((x) => x.id === 'e'))
  })

  ok('within a group: nearest due first, nothing-due last', () => {
    const list = [
      { id: 'x', priority: 'eventually', createdAt: '1' },
      { id: 'y', priority: 'month', setOn: '2026-11-06', createdAt: '2' },
      { id: 'z', priority: 'week', setOn: '2026-11-06', createdAt: '3' },
    ]
    assert.deepStrictEqual(list.slice().sort(T.todoCompare).map((t) => t.id), ['z', 'y', 'x'])
  })

  ok('recently done, newest first; slugs never clash; uses counted', () => {
    assert.deepStrictEqual(T.todoRecentlyDone(todos, 30).map((t) => t.id), ['d'])
    assert.strictEqual(T.todoSlug('Barn roof', [{ id: 'barn-roof' }]), 'barn-roof-2')
    assert.strictEqual(T.todoSlug('!!!', []), 'item')
    assert.strictEqual(T.todoUses(todos, 'project', 'p1'), 2)
  })

  console.log(n + ' passed')
})().catch((e) => { console.error(e); process.exit(1) })
