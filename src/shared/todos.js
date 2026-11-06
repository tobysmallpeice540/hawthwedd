// The to-do list's rules, kept apart from the screens so they can be tested
// on their own (tests/todos-test.cjs). Nothing here touches the network.
//
// A to-do (app_data hbf_todos_v1, one array, saved by id):
//   { id, title, detail, who, whoLabel, area, project, priority, setOn,
//     deadline, photos: [{ path, name }], state, comment,
//     doneAt, doneBy, doneById, createdAt, createdBy, createdById, updatedAt }
// · who: "anyone" (Everyone), "person:<profile id>", "role:admin" (Office),
//   "role:bar", "role:cleaner" (Housekeeping) — the same values checklists use.
// · priority: "day" | "week" | "month" | "eventually". It is a scope, counted
//   from the day it was set (setOn): "1 month" put on the 20th means within
//   four weeks of the 20th. Changing the priority starts the count again.
// · deadline: an optional fixed date; whichever of the two comes first is the
//   date it is due by.
// · state: "open", "done", "note" (done, with a comment) or "na".
// · private: true = seen only by whoever wrote it (createdById) and, when it
//   is for a named person, that person.
//
// A project (hbf_todo_projects_v1): { id, name, hidden, private, ownerId }.
// A private project, and every to-do in it, is seen only by its owner.
// Areas are places, and always shared.
//
// "Seen only by" is what the app SHOWS. The lists are app_data rows every
// staff login can read, so this keeps things out of the way, not secret.

export const TODO_PRIORITY_DAYS = { day: 1, week: 7, month: 28, eventually: null };
export const TODO_PRIORITY_ORDER = ["day", "week", "month", "eventually"];
export const TODO_PRIORITY_LABEL = { day: "1 day", week: "7 days", month: "1 month", eventually: "Eventually" };

export const TODO_DEFAULT_AREAS = [
  { id: "admin", name: "Admin" },
  { id: "amly-barn", name: "Amly Barn" },
  { id: "grain-store", name: "Grain Store" },
  { id: "glamping", name: "Glamping" },
  { id: "hamlet", name: "The Hamlet" },
  { id: "cinema-barn", name: "Cinema Barn" },
  { id: "wood-store", name: "Wood Store" },
  { id: "old-brewery", name: "Old Brewery" },
  { id: "barn-in-the-woods", name: "Barn in the Woods" },
];

export function todoAddDays(iso, n) {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const p = iso.split("-");
  const d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The date a to-do is due by, or null for "Eventually" with no deadline.
export function todoDueOn(t) {
  if (!t) return null;
  const days = TODO_PRIORITY_DAYS[t.priority];
  const fromPriority = days != null && t.setOn ? todoAddDays(t.setOn, days) : null;
  const deadline = typeof t.deadline === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.deadline) ? t.deadline : null;
  if (fromPriority && deadline) return fromPriority < deadline ? fromPriority : deadline;
  return fromPriority || deadline;
}

// "overdue" (the due day has passed), "today", "soon" (within two days),
// "later", or "none" (nothing to be due by). Open to-dos only.
export function todoTiming(t, today) {
  const due = todoDueOn(t);
  if (!due) return "none";
  if (due < today) return "overdue";
  if (due === today) return "today";
  if (due <= todoAddDays(today, 2)) return "soon";
  return "later";
}

export function todoIsOpen(t) { return !!t && (!t.state || t.state === "open"); }

// Is this to-do for this person? Their own name, their group, or Everyone.
export function todoIsFor(t, me) {
  if (!t || !me) return false;
  if (t.who === "anyone" || !t.who) return true;
  if (me.id && t.who === "person:" + me.id) return true;
  if (me.role && t.who === "role:" + me.role) return true;
  return false;
}

// May this login see this project? Public ones, and their own private ones.
export function todoListVisibleTo(list, me) {
  if (!list) return false;
  if (!list.private) return true;
  return !!me && !!me.id && list.ownerId === me.id;
}

// What a login may see. Private to-dos and to-dos in someone else's private
// project are left out for everyone else, the office included. Otherwise the
// office sees everything; the bar and housekeeping logins see what is for them
// (group or Everyone) and what they wrote.
export function todoVisibleTo(t, me, projects) {
  if (!t) return false;
  const mine = !!me && !!me.id && t.createdById === me.id;
  if (t.private && !mine && !(me && me.id && t.who === "person:" + me.id)) return false;
  if (t.project) {
    const p = (projects || []).filter(function (x) { return x.id === t.project; })[0];
    if (p && !todoListVisibleTo(p, me)) return false;
  }
  if (!me || me.role === "admin") return true;
  return todoIsFor(t, me) || mine;
}

// Nearest due first, nothing-due last, then oldest first.
export function todoCompare(a, b) {
  const da = todoDueOn(a) || "9999-99-99", db = todoDueOn(b) || "9999-99-99";
  if (da !== db) return da < db ? -1 : 1;
  const pa = TODO_PRIORITY_ORDER.indexOf(a.priority), pb = TODO_PRIORITY_ORDER.indexOf(b.priority);
  if (pa !== pb) return pa - pb;
  return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
}

// The open to-dos in groups, for one of the four ways of looking at them.
//   by: "priority" | "person" | "area" | "project"
//   ctx: { today, me, people: [{who, label}], areas: [{id, name, hidden}],
//          projects: [{id, name, hidden}] }
// Returns [{ key, label, items, preset }] — `preset` is what a new to-do
// added from that group's own button starts with. Empty groups are left out,
// except projects and areas still in use elsewhere are not invented.
export function todoGroups(todos, by, ctx) {
  const today = ctx.today;
  const open = (todos || []).filter(todoIsOpen).slice().sort(todoCompare);
  const groups = [];
  const byKey = {};
  function put(key, label, item, preset) {
    if (!byKey[key]) { byKey[key] = { key: key, label: label, items: [], preset: preset || {} }; groups.push(byKey[key]); }
    if (item) byKey[key].items.push(item);
  }
  if (by === "priority") {
    // Overdue first, whatever priority it was given, so it is not missed.
    const order = ["overdue"].concat(TODO_PRIORITY_ORDER);
    order.forEach(function (k) {
      put(k, k === "overdue" ? "Overdue" : TODO_PRIORITY_LABEL[k], null, k === "overdue" ? {} : { priority: k });
    });
    open.forEach(function (t) {
      const k = todoTiming(t, today) === "overdue" ? "overdue" : (TODO_PRIORITY_DAYS[t.priority] !== undefined ? t.priority : "eventually");
      byKey[k].items.push(t);
    });
  } else if (by === "person") {
    const me = ctx.me || {};
    const known = {};
    (ctx.people || []).forEach(function (p) { known[p.who] = p.label; });
    // Me first, then people, then the groups, then Everyone.
    const order = [];
    if (me.id && known["person:" + me.id]) order.push("person:" + me.id);
    (ctx.people || []).forEach(function (p) {
      if (order.indexOf(p.who) === -1 && p.who !== "anyone") order.push(p.who);
    });
    order.push("anyone");
    order.forEach(function (w) {
      const label = w === "anyone" ? "Everyone" : (me.id && w === "person:" + me.id ? (known[w] || "Me") + " (me)" : known[w] || w);
      put(w, label, null, { who: w });
    });
    open.forEach(function (t) {
      const w = t.who || "anyone";
      if (!byKey[w]) put(w, t.whoLabel || "Someone no longer listed", null, { who: w });
      byKey[w].items.push(t);
    });
  } else {
    const field = by === "area" ? "area" : "project";
    const list = (by === "area" ? ctx.areas : ctx.projects) || [];
    list.forEach(function (x) { const p = {}; p[field] = x.id; put(x.id, x.name, null, p); });
    put("__none", by === "area" ? "No area" : "No project", null, {});
    open.forEach(function (t) {
      const k = t[field] && byKey[t[field]] ? t[field] : "__none";
      byKey[k].items.push(t);
    });
  }
  return groups.filter(function (g) { return g.items.length > 0; });
}

// Finished to-dos, newest first, from the last `days` days.
export function todoRecentlyDone(todos, days, nowMs) {
  const since = (nowMs || Date.now()) - days * 86400000;
  return (todos || []).filter(function (t) { return !todoIsOpen(t) && t.doneAt && Date.parse(t.doneAt) >= since; })
    .sort(function (a, b) { return String(b.doneAt).localeCompare(String(a.doneAt)); });
}

// An id for a new area or project from its name, not clashing with any taken.
export function todoSlug(name, taken) {
  const base = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";
  let id = base, n = 2;
  const have = {};
  (taken || []).forEach(function (x) { have[x.id] = true; });
  while (have[id]) { id = base + "-" + n; n++; }
  return id;
}

// How many to-dos use an area or project — one in use is hidden, not deleted.
export function todoUses(todos, field, id) {
  return (todos || []).filter(function (t) { return t[field] === id; }).length;
}
