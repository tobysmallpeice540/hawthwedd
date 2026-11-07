// tests/todos-test.cjs — the to-do list's rules (src/shared/todos.js).
//   node tests/todos-test.cjs
const assert = require('assert')
const path = require('path')

;(async () => {
  const T = await import(path.join(__dirname, '..', 'src/shared/todos.js'))
  let n = 0
  const ok = (name, fn) => { fn(); n++; console.log('  ok  ' + name) }

  ok('priority is a scope counted from the day it was set', () => {
    assert.strictEqual(T.todoDueOn({ priority: 'three', setOn: '2026-11-06' }), '2026-11-09')
    assert.strictEqual(T.todoDueOn({ priority: 'week', setOn: '2026-11-06' }), '2026-11-13')
    // "1 month" put on the 20th means within four weeks of the 20th
    assert.strictEqual(T.todoDueOn({ priority: 'month', setOn: '2026-11-20' }), '2026-12-18')
    assert.strictEqual(T.todoDueOn({ priority: 'eventually', setOn: '2026-11-20' }), null)
  })

  ok('a deadline wins when it comes first, and stands alone for Eventually', () => {
    assert.strictEqual(T.todoDueOn({ priority: 'month', setOn: '2026-11-06', deadline: '2026-11-10' }), '2026-11-10')
    assert.strictEqual(T.todoDueOn({ priority: 'three', setOn: '2026-11-06', deadline: '2026-11-30' }), '2026-11-09')
    assert.strictEqual(T.todoDueOn({ priority: 'eventually', deadline: '2026-12-01' }), '2026-12-01')
    assert.strictEqual(T.todoDueOn({ priority: 'eventually', deadline: 'soon' }), null)
  })

  ok('timing: overdue only once the due day has passed', () => {
    const t = { priority: 'three', setOn: '2026-11-04' }   // due 7th
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
    { id: 'a', title: 'Late', priority: 'three', setOn: '2026-11-01', who: 'person:u1', area: 'hamlet', project: 'p1', createdAt: '1' },
    { id: 'b', title: 'Week', priority: 'week', setOn: '2026-11-06', who: 'role:bar', area: 'grain-store', createdAt: '2' },
    { id: 'c', title: 'Someday', priority: 'eventually', who: 'anyone', project: 'p1', createdAt: '3' },
    { id: 'd', title: 'Done', priority: 'three', setOn: '2026-11-01', state: 'done', doneAt: new Date().toISOString(), createdAt: '4' },
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

  // ── 7 Nov 2026: Before next event, repeats, categories, the board's filters ──
  const cal = {
    accom: [
      { status: 'confirmed', stays: [{ propertyId: 'hamlet', checkIn: '2026-11-13', checkOut: '2026-11-16' }, { propertyId: 'amly', checkIn: '2026-11-20', checkOut: '2026-11-22' }] },
      { status: 'cancelled', stays: [{ propertyId: 'hamlet', checkIn: '2026-11-09', checkOut: '2026-11-10' }] },
      { status: 'confirmed', bookingType: 'Blocked', propertyId: 'hamlet', checkIn: '2026-11-08', checkOut: '2026-11-09' },
      { status: 'confirmed', propertyId: 'hamlet', checkIn: '2026-11-01', checkOut: '2026-11-03' },
    ],
    events: [
      { date: '2026-11-21', status: 'Confirmed' }, { date: '2026-11-10', status: 'Holding' }, { date: '2026-11-11', status: 'Cancelled' },
      { date: '2026-11-12', status: 'Confirmed', fromSnapshot: true },
    ],
    boxEvents: [{ starts_at: '2026-11-14T19:00:00Z', status: 'published' }, { starts_at: '2026-11-08T19:00:00Z', status: 'draft' }],
  }
  ok('before next event: the next check-in at its property, else the next event at the venue', () => {
    const t = (area) => ({ priority: 'event', setOn: '2026-11-06', area })
    assert.deepStrictEqual(T.todoEventDue(t('hamlet'), cal, today), { on: '2026-11-13', what: 'checkin', propertyId: 'hamlet' })
    assert.strictEqual(T.todoEventDue(t('amly-barn'), cal, today).on, '2026-11-20')
    assert.strictEqual(T.todoEventDue(t('glamping'), cal, today), null)              // nothing booked
    assert.deepStrictEqual(T.todoEventDue(t('grain-store'), cal, today), { on: '2026-11-14', what: 'event' })   // the ticketed night
    assert.strictEqual(T.todoEventDue(t('farm'), cal, today).on, '2026-11-14')
    assert.strictEqual(T.todoEventDue(t(null), cal, today).on, '2026-11-14')
    assert.strictEqual(T.todoEventDue(Object.assign(t('hamlet'), { setOn: '2026-11-14' }), cal, today), null)   // counted from the day it was set
    assert.strictEqual(T.todoEventDue({ priority: 'week', area: 'hamlet' }, cal, today), null)
    // Several areas: whichever comes first.
    const many = (areas) => ({ priority: 'event', setOn: '2026-11-06', areas })
    assert.deepStrictEqual(T.todoEventDue(many(['amly-barn', 'hamlet']), cal, today), { on: '2026-11-13', what: 'checkin', propertyId: 'hamlet' })
    assert.deepStrictEqual(T.todoEventDue(many(['amly-barn', 'grain-store']), cal, today), { on: '2026-11-14', what: 'event' })
    assert.deepStrictEqual(T.todoEventDue(many(['hamlet', 'grain-store']), cal, today), { on: '2026-11-13', what: 'checkin', propertyId: 'hamlet' })
    assert.strictEqual(T.todoEventDue(many(['glamping']), cal, today), null)
    assert.strictEqual(T.todoEventKind(['hamlet', 'glamping']), 'checkin')
    assert.strictEqual(T.todoEventKind(['hamlet', 'farm']), 'either')
    assert.strictEqual(T.todoEventKind([]), 'event')
    assert.strictEqual(T.todoDueOn({ priority: 'event', setOn: today, eventOn: '2026-11-13' }), '2026-11-13')
    assert.strictEqual(T.todoDueOn({ priority: 'event', setOn: today, eventOn: '2026-11-13', deadline: '2026-11-10' }), '2026-11-10')
    assert.strictEqual(T.todoDueOn({ priority: 'event', setOn: today }), null)
  })

  ok('repeats: the next day after today, as the database works it out', () => {
    assert.strictEqual(T.todoNextOn('2026-11-04', 'weekly', '2026-11-03'), '2026-11-11')
    assert.strictEqual(T.todoNextOn('2026-11-04', 'weekly', '2026-11-20'), '2026-11-25')
    assert.strictEqual(T.todoNextOn('2026-11-06', 'weekdays', '2026-11-06'), '2026-11-09')
    assert.strictEqual(T.todoNextOn('2026-01-31', 'monthly', '2026-01-31'), '2026-02-28')
    assert.strictEqual(T.todoNextOn('2026-01-31', 'monthly', '2026-03-01'), '2026-03-31')
    assert.strictEqual(T.todoNextOn('2020-01-01', 'daily', '2026-11-07'), '2026-11-08')
    assert.strictEqual(T.todoNextOn('2026-11-07', 'yearly', '2026-11-07'), '2027-11-07')
    assert.strictEqual(T.todoNextOn('2026-11-07', 'fortnightly', '2026-11-07'), null)
  })

  ok('tags: several to a to-do, a column each; the board filters by tags, person and area', () => {
    const list = [
      { id: 'x1', title: 'A', priority: 'week', setOn: today, tags: ['maint', 'buy'], area: 'farm', who: 'anyone', createdAt: '1' },
      { id: 'x2', title: 'B', priority: 'week', setOn: today, category: 'admin', area: 'hamlet', who: 'person:u1', createdAt: '2' },   // saved before tags
      { id: 'x3', title: 'C', priority: 'week', setOn: today, tags: [], who: 'role:bar', createdAt: '3' },
    ]
    const c = Object.assign({}, ctx, { categories: [{ id: 'admin', name: 'Admin' }, { id: 'maint', name: 'Maintenance' }, { id: 'buy', name: 'To buy' }] })
    assert.deepStrictEqual(T.todoTags(list[1]), ['admin'])
    assert.deepStrictEqual(T.todoTags(list[2]), [])
    const g = T.todoGroups(list, 'tag', c)
    assert.deepStrictEqual(g.map((x) => x.label + ':' + x.items.map((t) => t.id).join('')), ['Admin:x2', 'Maintenance:x1', 'To buy:x1', 'No tag:x3'])
    assert.deepStrictEqual(g[1].preset, { tags: ['maint'] })
    assert.deepStrictEqual(T.todoGroups(list, 'category', c).length, 4, 'a saved "category" column choice still works')
    assert.deepStrictEqual(T.todoFilter(list, { tags: ['buy'] }, me).map((t) => t.id), ['x1'])
    assert.deepStrictEqual(T.todoFilter(list, { tags: ['buy', 'admin'] }, me).map((t) => t.id), ['x1', 'x2'], 'any highlighted tag')
    assert.deepStrictEqual(T.todoFilter(list, { tags: ['__none'] }, me).map((t) => t.id), ['x3'])
    assert.deepStrictEqual(T.todoFilter(list, { tags: ['__none', 'admin'] }, me).map((t) => t.id), ['x2', 'x3'])
    assert.deepStrictEqual(T.todoFilter(list, { area: '__none' }, me).map((t) => t.id), ['x3'])
    // Several areas: in each one's column, and found by any of them.
    const two = [{ id: 'y1', title: 'Y', priority: 'week', setOn: today, areas: ['farm', 'hamlet'], createdAt: '1' }]
    assert.deepStrictEqual(T.todoFilter(two, { area: 'hamlet' }, me).length, 1)
    assert.deepStrictEqual(T.todoGroups(two, 'area', Object.assign({}, ctx, { areas: [{ id: 'farm', name: 'Farm' }, { id: 'hamlet', name: 'The Hamlet' }] }))
      .map((x) => x.label), ['Farm', 'The Hamlet'])
    assert.deepStrictEqual(T.todoAreas({ area: 'farm' }), ['farm'])
    assert.deepStrictEqual(T.todoFilter(list, { who: 'mine' }, me).map((t) => t.id), ['x1', 'x2'])
    assert.deepStrictEqual(T.todoFilter(list, { who: 'role:bar' }, me).map((t) => t.id), ['x3'])
    assert.deepStrictEqual(T.todoFilter(list, { tags: ['admin'], area: 'hamlet', who: 'person:u1' }, me).map((t) => t.id), ['x2'])
    assert.deepStrictEqual(T.todoFilter(list, { tags: [] }, me).length, 3)
    // Urgent (7 Nov): first in every group, and a filter of its own.
    const u = [{ id: 'u1', title: 'Soon', priority: 'three', setOn: today, createdAt: '1' },
      { id: 'u2', title: 'Starred, later', priority: 'eventually', setOn: today, urgent: true, createdAt: '2' }]
    assert.deepStrictEqual(u.slice().sort(T.todoCompare).map((t) => t.id), ['u2', 'u1'])
    assert.deepStrictEqual(T.todoFilter(u, { urgent: true }, me).map((t) => t.id), ['u2'])
    assert.ok(T.TODO_DEFAULT_AREAS.some((a) => a.id === 'farm' && a.name === 'Farm'))
    assert.ok(!T.TODO_DEFAULT_AREAS.some((a) => a.id === 'admin'), 'Admin is a tag now, not an area')
    assert.deepStrictEqual(T.TODO_PRIORITY_ORDER, ['three', 'week', 'month', 'event', 'eventually'])
  })

  // ── Todoist → to-do proposal ───────────────────────────────────────────────
  const areas = T.TODO_DEFAULT_AREAS
  const tdData = {
    projects: [
      { id: 'in', name: 'Inbox', inbox: true, shared: false },
      { id: 'hm', name: 'Hamlet', shared: false },
      { id: 'wb', name: 'Website', shared: true },
      { id: 'mk', name: 'Marketing', shared: false },
    ],
    sections: [{ id: 's1', name: 'Grain Store jobs', projectId: 'mk' }],
    people: [{ id: 'u-toby', name: 'Toby Smallpeice' }, { id: 'u-ros', name: 'Rosanna Smith' }, { id: 'u-x', name: 'Builder Bob' }],
    tasks: [
      { id: '1', content: 'Fix Hamlet gutter', projectId: 'in', labels: [], priority: 1, dueDate: '2026-11-07', order: 1 },
      { id: '2', content: 'Repaint door', projectId: 'hm', labels: [], priority: 4, order: 2 },
      { id: '3', content: 'Buy screws', projectId: 'hm', parentId: '2', labels: [], priority: 1, order: 3 },
      { id: '4', content: 'New homepage', projectId: 'wb', labels: ['web'], priority: 3, assigneeId: 'u-ros', order: 4 },
      { id: '5', content: 'Check bell tents', projectId: 'in', labels: [], priority: 1, dueDate: '2026-11-10', recurring: true, dueString: 'every week', order: 5 },
      { id: '6', content: 'Posters', projectId: 'mk', sectionId: 's1', labels: [], priority: 1, dueDate: '2026-11-25', order: 6 },
      { id: '7', content: 'Call the bank', projectId: 'wb', labels: [], priority: 1, assigneeId: 'u-x', dueDate: '2027-03-01', order: 7 },
      { id: '8', content: '=SUM(A1)', projectId: 'in', labels: [], priority: 2, order: 8 },
    ],
  }
  const tdOpts = {
    areas, projects: [{ id: 'p-web', name: 'website' }], today: '2026-11-06', me: { id: 'me1' },
    people: [{ who: 'anyone', label: 'Everyone' }, { who: 'person:me1', label: 'Toby' }, { who: 'person:r1', label: 'Rosanna' }],
  }
  const prop = T.todoistProposal(tdData, tdOpts)
  const row = (id) => prop.find((r) => r.todoistId === id)

  ok('todoist: area from title, project, section and nicknames; Inbox is never a project', () => {
    assert.strictEqual(row('1').area, 'The Hamlet'); assert.strictEqual(row('1').areaFrom, 'title'); assert.strictEqual(row('1').project, '')
    assert.strictEqual(row('2').area, 'The Hamlet'); assert.strictEqual(row('2').areaFrom, 'project'); assert.strictEqual(row('2').project, '')
    assert.strictEqual(row('6').area, 'Grain Store'); assert.strictEqual(row('6').areaFrom, 'section'); assert.strictEqual(row('6').project, 'Marketing (new)')
    assert.strictEqual(row('5').area, 'Glamping')
    assert.strictEqual(row('4').area, ''); assert.ok(/No area/.test(row('4').flags))
    assert.strictEqual(row('4').project, 'website')   // matches the app's existing project, any case
  })

  ok('todoist: priority from the due date, else from P1/P2', () => {
    assert.strictEqual(row('1').priority, '3 days')       // due tomorrow
    assert.strictEqual(row('6').priority, '1 month')      // 19 days
    assert.strictEqual(row('7').priority, 'Eventually')   // months away, kept as the deadline
    assert.strictEqual(row('7').deadline, '2027-03-01')
    assert.strictEqual(row('2').priority, '7 days')       // P1, no date
    assert.strictEqual(row('4').priority, '1 month')      // P2, no date
    assert.strictEqual(row('2').todoistPriority, 'P1')
    assert.strictEqual(T.todoistPriority({ dueDate: '2026-10-01', priority: 1 }, '2026-11-06'), 'three')   // overdue
  })

  ok('todoist: who, sub-tasks folded in, repeats proposed as checklists', () => {
    assert.strictEqual(row('4').who, 'Rosanna')            // first-name match to an app login
    assert.strictEqual(row('7').who, 'Everyone'); assert.ok(/Builder Bob/.test(row('7').flags))
    assert.strictEqual(row('2').who, 'Toby')               // unassigned in a project only Toby sees
    assert.strictEqual(row('3').action, 'Fold into parent'); assert.strictEqual(row('3').detail, '')
    assert.ok(/Steps:\n- Buy screws/.test(row('2').detail))
    assert.strictEqual(row('5').action, 'Checklist candidate'); assert.strictEqual(row('5').deadline, '')
    assert.deepStrictEqual(prop.map((r) => r.action).slice(-2), ['Checklist candidate', 'Fold into parent'])
  })

  ok('todoist: CSV is quoted, BOM-led and never starts a formula', () => {
    const csv = T.todoCsv(prop)
    assert.ok(csv.charCodeAt(0) === 0xfeff)
    assert.ok(csv.indexOf('"\'=SUM(A1)"') > 0)
    assert.ok(T.todoCsv([{ title: 'a "b"' }], [['title', 'Heading']]).indexOf('"a ""b"""') > 0)
    assert.ok(T.todoCsv([{ title: '- fine' }], [['title', 'Heading']]).indexOf('"- fine"') > 0)
  })

  console.log(n + ' passed')
})().catch((e) => { console.error(e); process.exit(1) })
