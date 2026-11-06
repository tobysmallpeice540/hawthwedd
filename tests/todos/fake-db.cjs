// tests/todos/fake-db.cjs — the todo_ database functions, in memory, for the
// screen tests (tests/todos-e2e.cjs). The REAL rules are tested against a
// real Postgres in supabase/2026-11-06b-todos-test.sql; this stand-in uses the
// same rules from src/shared/todos.js so the screens see what the database
// would send: only what that login may see, `canEdit`, `dueOn`, `uses`, `mine`.
const path = require('path')

async function makeTodoDb(opts) {
  const R = await import(path.join(__dirname, '..', '..', 'src/shared/todos.js'))
  const me = opts.me                                  // { id, role, name }
  const labels = opts.labels || {}                    // who -> label
  const items = new Map((opts.items || []).map((t) => [t.id, Object.assign({ photos: [], state: 'open', detail: '' }, t)]))
  const lists = { area: (opts.areas || R.TODO_DEFAULT_AREAS).map((a) => Object.assign({}, a)),
                  project: (opts.projects || []).map((p) => Object.assign({}, p)) }
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
  const visible = (t) => R.todoVisibleTo(t, me, lists.project)
  const canEdit = (t) => visible(t) && (me.role === 'admin' || t.createdById === me.id)
  const out = (t) => Object.assign({}, t, { dueOn: R.todoDueOn(t), canEdit: canEdit(t) })
  const listOut = (kind, l) => ({ id: l.id, name: l.name, hidden: !!l.hidden, private: !!l.private, mine: l.ownerId === me.id,
    uses: [...items.values()].filter((t) => t[kind] === l.id).length })
  const label = (who) => who === 'anyone' ? 'Everyone' : labels[who] || who
  const fail = (error) => ({ ok: false, error })

  const rpc = {
    todo_get: () => ({ ok: true, me,
      items: [...items.values()].filter(visible).map(out),
      areas: lists.area.map((l) => listOut('area', l)),
      projects: lists.project.filter((l) => R.todoListVisibleTo(l, me)).map((l) => listOut('project', l)) }),
    todo_upsert: ({ p }) => {
      const old = items.get(p.id)
      if (old && !visible(old)) return fail('not_found')
      if (old && !canEdit(old)) return fail('not_yours')
      if (!String(p.title || '').trim()) return fail('no_title')
      const rec = Object.assign({}, old || { state: 'open', createdAt: new Date().toISOString(), createdBy: me.name, createdById: me.id },
        { id: p.id, title: p.title.trim(), detail: p.detail || '', who: p.who, whoLabel: label(p.who), area: p.area, project: p.project,
          priority: p.priority, deadline: p.deadline, private: !!p.private, photos: p.photos || [],
          setOn: old && old.priority === p.priority ? old.setOn : today(), updatedAt: new Date().toISOString() })
      items.set(p.id, rec)
      return { ok: true, item: out(rec) }
    },
    todo_set_state: ({ p_id, p_state, p_comment }) => {
      const t = items.get(p_id)
      if (!t || !visible(t)) return fail('not_found')
      if (p_state === 'note' && !p_comment) return fail('comment_needed')
      if (p_state === 'open') {
        if (me.role !== 'admin' && t.doneById !== me.id) return fail('not_your_tick')
        Object.assign(t, { state: 'open', comment: null, doneAt: null, doneBy: null, doneById: null })
      } else {
        Object.assign(t, { state: p_state, comment: p_state === 'done' ? null : p_comment, doneAt: new Date().toISOString(), doneBy: me.name, doneById: me.id })
      }
      return { ok: true, item: out(t) }
    },
    todo_delete: ({ p_id }) => {
      const t = items.get(p_id)
      if (!t || !visible(t)) return fail('not_found')
      if (!canEdit(t)) return fail('not_yours')
      items.delete(p_id)
      return { ok: true, photos: t.photos }
    },
    todo_save_list: ({ p_kind, p }) => {
      if (me.role !== 'admin') return fail('office_only')
      const list = lists[p_kind]
      let l = p.id ? list.find((x) => x.id === p.id) : null
      if (p.id && !l) return fail('not_found')
      if (!l) {
        l = { id: R.todoSlug(p.name, list), name: p.name, ownerId: me.id, private: p_kind === 'project' && !!p.private }
        list.push(l)
      } else {
        if ('private' in p && !!p.private !== !!l.private && l.ownerId !== me.id) return fail('not_your_project')
        ;['name', 'hidden', 'private'].forEach((k) => { if (k in p) l[k] = p[k] })
      }
      return { ok: true, list: listOut(p_kind, l) }
    },
    todo_delete_list: ({ p_kind, p_id }) => {
      if (me.role !== 'admin') return fail('office_only')
      if ([...items.values()].some((t) => t[p_kind] === p_id)) return fail('in_use')
      lists[p_kind] = lists[p_kind].filter((x) => x.id !== p_id)
      return { ok: true }
    },
  }
  return { rpc, items, lists }
}

module.exports = { makeTodoDb }
