// The to-do list's rules, kept apart from the screens so they can be tested
// on their own (tests/todos-test.cjs). Nothing here touches the network.
//
// A to-do (the todo_items table, migration 2026-11-06b, as todo_get sends it):
//   { id, title, detail, who, whoLabel, area, project, category, priority,
//     repeat, setOn, deadline, photos: [{ path, name }], state, comment,
//     doneAt, doneBy, doneById, createdAt, createdBy, createdById, updatedAt }
// · who: "anyone" (Everyone), "person:<profile id>", "role:admin" (Office),
//   "role:bar", "role:cleaner" (Housekeeping) — the same values checklists use.
// · priority: "three" | "week" | "month" | "event" | "eventually". The first
//   three are a scope counted from the day it was set (setOn): "1 month" put
//   on the 20th means within four weeks of the 20th. Changing the priority
//   starts the count again. ("1 day" became "3 days" on 7 Nov 2026.)
//   "event" — Before next event — is due on the next check-in at The Hamlet,
//   Amly Barn or Glamping when that is its area, otherwise the next event at
//   the venue (diary or box office), on or after the day it was set. The app
//   works that day out from the bookings when it is set (todoEventDue) and
//   sends it as `eventOn`; the database keeps it (migration 2026-11-07d)
//   until the priority or area changes, and counts it in dueOn.
// · repeat: null | "daily" | "weekdays" | "weekly" | "monthly" | "yearly".
//   Ticking one leaves the next one behind (the database does it).
// · area, project, tags: each optional. Tags (Admin, Maintenance, To buy… —
//   the 'category' lists in the database, several per to-do, `tags`;
//   7 Nov 2026, Toby). The Todoist-level grouping above projects is retired.
// · deadline: an optional fixed date; whichever of the two comes first is the
//   date it is due by.
// · state: "open", "done", "note" (done, with a comment) or "na".
// · private: true = seen only by whoever wrote it (createdById) and, when it
//   is for a named person, that person.
//
// A project (todo_lists): { id, name, hidden, private, mine, uses }.
// A private project, and every to-do in it, is seen only by its owner.
// Areas are places, and always shared.
//
// The DATABASE enforces who sees what (todo_visible in the migration) and
// sends each login only that. todoVisibleTo / todoListVisibleTo below are the
// same rules in JavaScript, kept so the two can be checked against each other
// (tests/todos-test.cjs); the app does not filter with them. Likewise the
// database works out due_on, and todoDueOn must agree with it.

export const TODO_PRIORITY_DAYS = { three: 3, week: 7, month: 28, event: null, eventually: null };
export const TODO_PRIORITY_ORDER = ["three", "week", "month", "event", "eventually"];
export const TODO_PRIORITY_LABEL = { three: "3 days", week: "7 days", month: "1 month", event: "Before next event", eventually: "Eventually" };
export const TODO_REPEATS = ["daily", "weekdays", "weekly", "monthly", "yearly"];
export const TODO_REPEAT_LABEL = { daily: "Every day", weekdays: "Every weekday", weekly: "Every week", monthly: "Every month", yearly: "Every year" };

// Admin moved from areas to categories on 7 Nov 2026.
export const TODO_DEFAULT_AREAS = [
  { id: "amly-barn", name: "Amly Barn" },
  { id: "grain-store", name: "Grain Store" },
  { id: "glamping", name: "Glamping" },
  { id: "hamlet", name: "The Hamlet" },
  { id: "cinema-barn", name: "Cinema Barn" },
  { id: "wood-store", name: "Wood Store" },
  { id: "old-brewery", name: "Old Brewery" },
  { id: "barn-in-the-woods", name: "Barn in the Woods" },
  { id: "farm", name: "Farm" },
];

// Which letting property an area is, for "Before next event".
export const TODO_AREA_PROPERTY = { hamlet: "hamlet", "amly-barn": "amly", glamping: "glamping" };
// A to-do's areas (several; migration 2026-11-07d). One saved before then
// has at most an `area`.
export function todoAreas(t) {
  if (t && Array.isArray(t.areas)) return t.areas;
  return t && t.area ? [t.area] : [];
}
// What "Before next event" waits for, given the areas: "checkin" when every
// one is a letting, "event" when none is, "either" when they are mixed.
export function todoEventKind(areas) {
  const list = Array.isArray(areas) ? areas : areas ? [areas] : [];
  const lets = list.filter(function (a) { return TODO_AREA_PROPERTY[a]; }).length;
  if (list.length && lets === list.length) return "checkin";
  return lets ? "either" : "event";
}

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
  let fromPriority = days != null && t.setOn ? todoAddDays(t.setOn, days) : null;
  if (t.priority === "event" && typeof t.eventOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.eventOn)) fromPriority = t.eventOn;
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
  // Urgent (starred) first (7 Nov 2026, Toby), then nearest due.
  if (!!a.urgent !== !!b.urgent) return a.urgent ? -1 : 1;
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
export function todoGroups(todos, by, ctx, opts) {
  const today = ctx.today;
  const open = (todos || []).filter(todoIsOpen).slice().sort(todoCompare);
  // Finished ones to show under each column (7 Nov, Toby: kept to look back on
  // and do again), newest first. A column with only finished ones still shows.
  const done = ((opts && opts.done) || []).filter(function (t) { return !todoIsOpen(t); }).slice()
    .sort(function (a, b) { return String(b.doneAt || "").localeCompare(String(a.doneAt || "")); });
  const groups = [];
  const byKey = {};
  function put(key, label, item, preset) {
    if (!byKey[key]) { byKey[key] = { key: key, label: label, items: [], done: [], preset: preset || {} }; groups.push(byKey[key]); }
    if (item) byKey[key].items.push(item);
  }
  // Where a to-do goes: the keys of its columns (one or more).
  let keysOf;
  if (by === "priority") {
    // Overdue first, whatever priority it was given, so it is not missed.
    const order = ["overdue"].concat(TODO_PRIORITY_ORDER);
    order.forEach(function (k) {
      put(k, k === "overdue" ? "Overdue" : TODO_PRIORITY_LABEL[k], null, k === "overdue" ? {} : { priority: k });
    });
    keysOf = function (t, isDone) {
      if (!isDone && todoTiming(t, today) === "overdue") return ["overdue"];
      return [TODO_PRIORITY_DAYS[t.priority] !== undefined ? t.priority : "eventually"];
    };
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
    keysOf = function (t) {
      const w = t.who || "anyone";
      if (!byKey[w]) put(w, t.whoLabel || "Someone no longer listed", null, { who: w });
      return [w];
    };
  } else if (by === "tag" || by === "category") {
    // A to-do with two tags is in both columns.
    (ctx.categories || []).forEach(function (x) { put(x.id, x.name, null, { tags: [x.id] }); });
    put("__none", "No tag", null, {});
    keysOf = function (t) {
      const tags = todoTags(t).filter(function (g) { return byKey[g] && g !== "__none"; });
      return tags.length ? tags : ["__none"];
    };
  } else if (by === "area") {
    // A to-do in two areas is in both columns.
    (ctx.areas || []).forEach(function (x) { put(x.id, x.name, null, { areas: [x.id] }); });
    put("__none", "No area", null, {});
    keysOf = function (t) {
      const as = todoAreas(t).filter(function (a) { return byKey[a] && a !== "__none"; });
      return as.length ? as : ["__none"];
    };
  } else {
    (ctx.projects || []).forEach(function (x) { put(x.id, x.name, null, { project: x.id }); });
    put("__none", "No project", null, {});
    keysOf = function (t) { return [t.project && byKey[t.project] ? t.project : "__none"]; };
  }
  open.forEach(function (t) { keysOf(t, false).forEach(function (k) { byKey[k].items.push(t); }); });
  done.forEach(function (t) { keysOf(t, true).forEach(function (k) { byKey[k].done.push(t); }); });
  return groups.filter(function (g) { return g.items.length > 0 || g.done.length > 0; });
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

// ── Before next event ───────────────────────────────────────────────────────
// cal: { accom: lettings records, events: diary events (box office rota
// records, booking-shaped, may be among them), boxEvents: box_events rows }.
// Returns { on, what: "checkin" | "event", propertyId } or null when nothing
// is booked. The changeover summary's counting rules: lettings not cancelled
// or Blocked; diary events not Cancelled or Holding; box office not draft.
function todoValidDay(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function todoLondonDay(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}
export function todoEventDue(t, cal, today) {
  if (!t || t.priority !== "event") return null;
  const from = todoValidDay(t.setOn) ? t.setOn : today;
  if (!from) return null;
  const c = cal || {};
  // Several areas: whichever of their next check-ins / events comes first.
  // A letting area waits for its check-in; any other area (or none) for the
  // next event at the venue.
  const areas = todoAreas(t);
  const props = areas.map(function (a) { return TODO_AREA_PROPERTY[a]; }).filter(Boolean);
  const wantEvent = !areas.length || areas.some(function (a) { return !TODO_AREA_PROPERTY[a]; });
  let best = null;
  const take = function (day, what, propertyId) {
    if (todoValidDay(day) && day >= from && (!best || day < best.on)) best = { on: day, what: what, propertyId: propertyId };
  };
  if (props.length) {
    (c.accom || []).forEach(function (b) {
      if (!b || b.status === "cancelled" || b.bookingType === "Blocked") return;
      (b.stays && b.stays.length ? b.stays : [b]).forEach(function (st) {
        if (st && props.indexOf(st.propertyId) !== -1) take(st.checkIn, "checkin", st.propertyId);
      });
    });
  }
  if (wantEvent) {
    (c.events || []).forEach(function (ev) {
      if (!ev || ev.fromSnapshot || ev.status === "Cancelled" || ev.status === "Holding") return;
      take(ev.date, "event");
    });
    (c.boxEvents || []).forEach(function (bx) {
      if (!bx || bx.status === "draft" || !bx.starts_at) return;
      take(todoLondonDay(bx.starts_at), "event");
    });
  }
  if (!best) return null;
  if (best.what === "event") delete best.propertyId;
  return best;
}

// The next day a repeat falls on after `today` — the database's
// todo_next_on, for showing on screen before it is ticked.
export function todoNextOn(from, rule, today) {
  if (!todoValidDay(from) || TODO_REPEATS.indexOf(rule) === -1) return null;
  const p = from.split("-").map(Number);
  let d = from;
  for (let n = 1; n < 4000; n++) {
    if (rule === "daily") d = todoAddDays(from, n);
    else if (rule === "weekly") d = todoAddDays(from, 7 * n);
    else if (rule === "weekdays") {
      d = todoAddDays(d, 1);
      while ([0, 6].indexOf(new Date(d + "T00:00:00Z").getUTCDay()) !== -1) d = todoAddDays(d, 1);
    } else {
      const y = p[0] + (rule === "yearly" ? n : 0), m0 = p[1] - 1 + (rule === "monthly" ? n : 0);
      const first = new Date(Date.UTC(y, m0, 1));
      const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
      first.setUTCDate(Math.min(p[2], last));
      d = first.toISOString().slice(0, 10);
    }
    if (d > today) return d;
  }
  return null;
}

// The day the next one of a repeating to-do falls on when it is ticked today
// (todo_set_state, migration 2026-11-07f): counted from the day the repeat
// keeps (`repeatFrom` — the deadline as typed), never from the last one, so
// the 31st goes to 28 Feb and back to 31 Mar; and after both today and the
// one being ticked, so ticking early moves on one step.
export function todoRepeatNext(t, today) {
  if (!t || !t.repeat) return null;
  const due = t.deadline || today;
  return todoNextOn(t.repeatFrom || due, t.repeat, due > today ? due : today);
}

// "Every Wednesday", "Monthly on the 30th (the last day in a shorter month)".
const TODO_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const TODO_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function todoOrdinal(n) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th";
  return n + s;
}
export function todoRepeatWhen(rule, day) {
  if (!todoValidDay(day)) return "";
  const p = day.split("-").map(Number);
  if (rule === "weekly") return "Every " + TODO_WEEKDAYS[new Date(day + "T00:00:00Z").getUTCDay()];
  if (rule === "monthly") return "Monthly on the " + todoOrdinal(p[2]) + (p[2] > 28 ? " (the last day in a shorter month)" : "");
  if (rule === "yearly") return "Every year on " + p[2] + " " + TODO_MONTHS[p[1] - 1] + (p[1] === 2 && p[2] === 29 ? " (28 Feb in other years)" : "");
  if (rule === "weekdays") return "Every weekday";
  if (rule === "daily") return "Every day";
  return "";
}

// A to-do's tags (several; migration 2026-11-07d). One saved before then has
// at most a `category`.
export function todoTags(t) {
  if (t && Array.isArray(t.tags)) return t.tags;
  return t && t.category ? [t.category] : [];
}

// The board's filters: tags (any of those highlighted; "__none" = untagged),
// who (a `who` value, "mine" for what is for me, or "" for all) and area
// ("__none" = no area).
export function todoFilter(todos, f, me) {
  const o = f || {};
  const want = Array.isArray(o.tags) ? o.tags : [];
  return (todos || []).filter(function (t) {
    if (want.length) {
      const has = todoTags(t);
      const ok = want.some(function (g) { return g === "__none" ? !has.length : has.indexOf(g) !== -1; });
      if (!ok) return false;
    }
    if (o.urgent && !t.urgent) return false;
    if (o.area) { const as = todoAreas(t); if (o.area === "__none" ? as.length > 0 : as.indexOf(o.area) === -1) return false; }
    if (o.who === "mine") { if (!todoIsFor(t, me)) return false; }
    else if (o.who) { if ((t.who || "anyone") !== o.who) return false; }
    return true;
  });
}

// ── Todoist → to-do list: the proposed mapping (7 Nov 2026) ─────────────────
// The To-do page's "Todoist CSV" button fetches Toby's Todoist through
// netlify/functions/todoist-export.js and turns it into a spreadsheet: one row
// per open Todoist task, what it was in Todoist, and what it would become here.
// Nothing is imported. The proposal is only a starting point for him to edit.
//
// The rules:
// · Area: the first area named in the task's labels, section, project, parent
//   project or title (word match; a few nicknames such as "Amly" or "bell
//   tent"). None found → blank, flagged to pick one.
// · Project: the Todoist project, unless it is the Inbox or was itself read as
//   an area. Marked "(new)" when the app has no project of that name yet.
// · Priority: from the due date — overdue or within a day → 1 day, within 7 →
//   7 days, within 28 → 1 month, later → Eventually. With no date, Todoist's
//   P1 → 7 days, P2 → 1 month, otherwise Eventually.
// · Deadline: Todoist's deadline, else a one-off due date.
// · For: the Todoist assignee if an app login has that name; unassigned tasks
//   in a project only Toby sees go to whoever downloaded the sheet; anything
//   else is Everyone.
// · Sub-tasks fold into their top task's description (the app does not nest);
//   repeating tasks are proposed as checklist items instead, since checklists
//   are what repeat.

const TODOIST_AREA_NICKNAMES = {
  "amly-barn": ["amly"],
  "grain-store": ["grainstore"],
  "glamping": ["bell tent", "bell tents", "bell-tent"],
  "hamlet": ["hamlet"],
  "cinema-barn": ["cinema"],
  "wood-store": ["woodstore"],
  "barn-in-the-woods": ["bitw"],
};

function todoistEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function todoistAreaTerms(areas) {
  return (areas || []).filter(function(a) { return a && !a.hidden && a.name; }).map(function(a) {
    const base = String(a.name).toLowerCase().trim();
    const terms = [base];
    if (base.indexOf("the ") === 0) terms.push(base.slice(4));
    (TODOIST_AREA_NICKNAMES[a.id] || []).forEach(function(n) { terms.push(n); });
    const res = terms.map(function(t) { return new RegExp("(^|[^a-z0-9])" + todoistEsc(t) + "($|[^a-z0-9])", "i"); });
    return { area: a, res: res };
  });
}

function todoistAreaIn(text, terms) {
  const s = String(text || "");
  if (!s) return [];
  return terms.filter(function(t) { return t.res.some(function(r) { return r.test(s); }); }).map(function(t) { return t.area; });
}

function todoistDays(from, to) {
  const a = Date.parse(from + "T00:00:00Z"), b = Date.parse(to + "T00:00:00Z");
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

export function todoistPriority(task, today) {
  if (task.dueDate && !task.recurring) {
    const d = todoistDays(today, task.dueDate);
    if (d != null) {
      if (d <= 3) return "three";
      if (d <= 7) return "week";
      if (d <= 28) return "month";
      return "eventually";
    }
  }
  if (task.priority === 4) return "week";
  if (task.priority === 3) return "month";
  return "eventually";
}

// data: the function's reply { projects, sections, people, tasks }.
// opts: { areas, projects, people, me, today } from the to-do store.
// Returns one row object per task, sorted for reading.
export function todoistProposal(data, opts) {
  const o = opts || {};
  const today = o.today;
  const projById = {}, secById = {}, tPeople = {};
  (data.projects || []).forEach(function(p) { projById[p.id] = p; });
  (data.sections || []).forEach(function(s) { secById[s.id] = s; });
  (data.people || []).forEach(function(p) { tPeople[p.id] = p.name; });
  const tasks = (data.tasks || []).slice();
  const byId = {};
  tasks.forEach(function(t) { byId[t.id] = t; });
  const terms = todoistAreaTerms(o.areas);
  const appProjects = {};
  (o.projects || []).forEach(function(p) { if (p && p.name) appProjects[String(p.name).toLowerCase().trim()] = p; });
  const appPeople = (o.people || []).filter(function(p) { return p && p.who && p.who.indexOf("person:") === 0; });
  const meRow = o.me && o.me.id ? appPeople.filter(function(p) { return p.who === "person:" + o.me.id; })[0] : null;

  function personFor(name) {
    const n = String(name || "").toLowerCase().trim();
    if (!n) return null;
    const exact = appPeople.filter(function(p) { return String(p.label).toLowerCase().trim() === n; })[0];
    if (exact) return exact;
    const firstName = n.split(/\s+/)[0];
    const hits = appPeople.filter(function(p) { return String(p.label).toLowerCase().trim().split(/\s+/)[0] === firstName; });
    return hits.length === 1 ? hits[0] : null;
  }

  // The top task each sub-task folds into (following parents up the chain).
  function topOf(t) {
    let cur = t, guard = 0;
    while (cur.parentId && byId[cur.parentId] && guard++ < 20) cur = byId[cur.parentId];
    return cur;
  }
  const children = {};
  tasks.forEach(function(t) {
    if (!t.parentId || !byId[t.parentId]) return;
    const top = topOf(t);
    (children[top.id] = children[top.id] || []).push(t);
  });

  const rows = tasks.map(function(t) {
    const proj = projById[t.projectId] || { name: "", inbox: false, shared: false };
    const parentProj = proj.parentId ? projById[proj.parentId] : null;
    const sec = t.sectionId ? secById[t.sectionId] : null;
    const flags = [];

    // Area, looking in the most deliberate places first.
    const places = [
      ["label", t.labels.join(" , ")],
      ["section", sec ? sec.name : ""],
      ["project", proj.inbox ? "" : proj.name],
      ["parent project", parentProj ? parentProj.name : ""],
      ["title", t.content],
    ];
    let area = null, areaFrom = "";
    for (let i = 0; i < places.length && !area; i++) {
      const hits = todoistAreaIn(places[i][1], terms);
      if (hits.length) {
        area = hits[0]; areaFrom = places[i][0];
        if (hits.length > 1) flags.push("Mentions " + hits.map(function(a) { return a.name; }).join(" and ") + " - check the area");
      }
    }
    if (!area) flags.push("No area - pick one");

    // Project: the Todoist project, unless it was the Inbox or was the area.
    let project = "";
    if (!proj.inbox && proj.name && !(areaFrom === "project")) {
      const hit = appProjects[proj.name.toLowerCase().trim()];
      project = hit ? hit.name : proj.name + " (new)";
    }

    // Who.
    let who = "Everyone";
    if (t.assigneeId) {
      const tName = tPeople[t.assigneeId] || "";
      const p = personFor(tName);
      if (p) who = p.label;
      else flags.push("Todoist has it for " + (tName || "someone") + ", who has no app login");
    } else if (!proj.shared && meRow) {
      who = meRow.label;
    }

    const isSub = !!(t.parentId && byId[t.parentId]);
    const action = isSub ? "Fold into parent" : (t.recurring ? "Checklist candidate" : "Import");
    if (t.recurring) flags.push("Repeats (" + (t.dueString || "recurring") + ")");

    // What the imported to-do's description would say.
    const extra = [];
    if (t.description) extra.push(t.description);
    const kids = children[t.id] || [];
    if (kids.length) extra.push("Steps:\n" + kids.map(function(k) { return "- " + k.content; }).join("\n"));
    const meta = [];
    if (sec) meta.push("Section: " + sec.name);
    if (t.labels.length) meta.push("Labels: " + t.labels.join(", "));
    meta.push("From Todoist" + (proj.name ? " (" + proj.name + ")" : ""));
    extra.push(meta.join(" · "));

    const priority = todoistPriority(t, today);
    return {
      todoistId: t.id,
      todoistProject: (parentProj ? parentProj.name + " / " : "") + (proj.name || ""),
      todoistSection: sec ? sec.name : "",
      todoistTask: t.content,
      todoistDescription: t.description,
      todoistLabels: t.labels.join(", "),
      todoistPriority: "P" + (5 - (t.priority || 1)),
      todoistDue: t.dueDate || "",
      todoistRepeats: t.recurring ? (t.dueString || "Yes") : "",
      todoistAssignee: t.assigneeId ? (tPeople[t.assigneeId] || "") : "",
      todoistParent: isSub ? (byId[t.parentId].content || "") : "",
      todoistAdded: t.addedAt || "",
      action: action,
      title: t.content,
      area: area ? area.name : "",
      areaFrom: areaFrom,
      project: project,
      priority: TODO_PRIORITY_LABEL[priority],
      deadline: t.deadline || (!t.recurring && t.dueDate) || "",
      who: who,
      private: "No",
      detail: isSub ? "" : extra.join("\n\n"),
      flags: flags.join("; "),
      _order: t.order,
    };
  });

  const actionRank = { "Import": 0, "Checklist candidate": 1, "Fold into parent": 2 };
  rows.sort(function(a, b) {
    if (actionRank[a.action] !== actionRank[b.action]) return actionRank[a.action] - actionRank[b.action];
    if (!a.area !== !b.area) return a.area ? -1 : 1;
    if (a.area !== b.area) return a.area < b.area ? -1 : 1;
    if (a.project !== b.project) return a.project < b.project ? -1 : 1;
    return (a._order || 0) - (b._order || 0);
  });
  rows.forEach(function(r) { delete r._order; });
  return rows;
}

export const TODOIST_CSV_COLUMNS = [
  ["action", "Proposed action"], ["title", "Heading"], ["area", "Area"], ["areaFrom", "Area found in"],
  ["project", "Project"], ["priority", "Priority"], ["deadline", "Deadline"], ["who", "For"], ["private", "Private"],
  ["flags", "Check"], ["detail", "Description to import"],
  ["todoistProject", "Todoist project"], ["todoistSection", "Todoist section"], ["todoistTask", "Todoist task"],
  ["todoistDescription", "Todoist description"], ["todoistLabels", "Todoist labels"], ["todoistPriority", "Todoist priority"],
  ["todoistDue", "Todoist due"], ["todoistRepeats", "Todoist repeats"], ["todoistAssignee", "Todoist assignee"],
  ["todoistParent", "Todoist parent task"], ["todoistAdded", "Todoist added"], ["todoistId", "Todoist ID"],
];

// A CSV Excel and Numbers open cleanly: BOM, CRLF, every cell quoted. A cell
// starting = + @ or a tab is prefixed with ' so a spreadsheet never runs it as
// a formula (a task title is text somebody typed).
export function todoCsv(rows, columns) {
  const cols = columns || TODOIST_CSV_COLUMNS;
  function cell(v) {
    let s = v == null ? "" : String(v);
    if (/^[=+@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  const lines = [cols.map(function(c) { return cell(c[1]); }).join(",")];
  (rows || []).forEach(function(r) { lines.push(cols.map(function(c) { return cell(r[c[0]]); }).join(",")); });
  return "﻿" + lines.join("\r\n") + "\r\n";
}
