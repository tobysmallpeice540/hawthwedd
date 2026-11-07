// netlify/functions/todoist-export.js
//
// Reads the whole of Toby's Todoist (open tasks, projects, sections, people on
// shared projects) for the To-do page's "Todoist CSV" button, which turns it
// into a spreadsheet proposing where each task would go in the app's to-do
// list. Read only: nothing here writes to Todoist or to the app.
//
// Uses the Todoist API with a personal token, held in Netlify as
// TODOIST_API_TOKEN (Todoist → Settings → Integrations → Developer → API
// token). The token reads and writes the whole Todoist account, so it lives
// only here and never reaches the browser. The older calendar feed
// (TODOIST_ICS_URL, todoist-feed.js) is not used: it carries only tasks with a
// due date, and no projects, sections, labels or sub-tasks.
//
// One call to /api/v1/sync with sync_token "*" returns everything at once, so
// there is no paging. Field names are read defensively (Todoist renamed several
// between API versions) and the reply is built field by field — an allowlist,
// never the raw Todoist objects.
//
// Admin logins only.

const SYNC_URL = "https://api.todoist.com/api/v1/sync";

function jsonResponse(statusCode, body) {
  return { statusCode: statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}

// ── Who is calling ────────────────────────────────────────────────────────────
// Same shape as resolveStaff in todoist-feed.js — copied, not shared, like
// every helper in this folder.
const AUTH_SB_URL = "https://rkqbyisfmvwulsyxzwjz.supabase.co";
async function resolveStaff(event, roles) {
  var key = process.env.SUPABASE_SERVICE_KEY;
  var h = (event && event.headers) || {};
  var jwt = String(h["authorization"] || h["Authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt || !key) return null;
  try {
    var res = await fetch(AUTH_SB_URL + "/auth/v1/user", {
      headers: { "apikey": key, "Authorization": "Bearer " + jwt }
    });
    if (!res.ok) return null;
    var user = await res.json();
    if (!user || !user.id) return null;
    var pr = await fetch(AUTH_SB_URL + "/rest/v1/profiles?id=eq." + encodeURIComponent(user.id) + "&select=role,active,name,email", {
      headers: { "apikey": key, "Authorization": "Bearer " + key }
    });
    if (!pr.ok) return null;
    var rows = await pr.json();
    var p = Array.isArray(rows) ? rows[0] : null;
    if (!p || p.active === false || roles.indexOf(p.role) === -1) return null;
    return { id: user.id, role: p.role, who: p.name || p.email || user.email || "" };
  } catch (e) {
    console.error("resolveStaff failed:", e.message);
    return null;
  }
}

function str(v) { return v == null ? "" : String(v); }
function first() {
  for (var i = 0; i < arguments.length; i++) if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i];
  return null;
}
function dateOnly(v) {
  var m = /^(\d{4}-\d{2}-\d{2})/.exec(str(v));
  return m ? m[1] : null;
}

exports.handler = async function(event) {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });

  const me = await resolveStaff(event, ["admin"]);
  if (!me) return jsonResponse(403, { error: "Only an office login can read Todoist." });

  const token = str(process.env.TODOIST_API_TOKEN).trim();
  if (!token) {
    return jsonResponse(400, {
      error: "Todoist isn't connected yet. In Todoist go to Settings → Integrations → Developer and copy the API token; " +
        "then in Netlify add it under Site configuration → Environment variables as TODOIST_API_TOKEN, and redeploy."
    });
  }

  let data;
  try {
    const body = "sync_token=*&resource_types=" + encodeURIComponent(JSON.stringify(["projects", "sections", "items", "collaborators", "user"]));
    const res = await fetch(SYNC_URL, {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/x-www-form-urlencoded" },
      body: body
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      return jsonResponse(502, { error: "Todoist refused the API token (" + res.status + "). It may have been reset — copy the current one into TODOIST_API_TOKEN." });
    }
    if (!res.ok) return jsonResponse(502, { error: "Todoist answered " + res.status + ". Try again in a minute." });
    try { data = JSON.parse(text); } catch (e) { return jsonResponse(502, { error: "Todoist sent something that isn't JSON." }); }
    if (!data || !Array.isArray(data.items) || !Array.isArray(data.projects)) {
      return jsonResponse(502, { error: "Todoist's reply didn't include tasks and projects." });
    }
  } catch (err) {
    console.error("todoist-export fetch failed:", err);
    return jsonResponse(502, { error: "Couldn't reach Todoist: " + String(err.message || err) });
  }

  const projects = data.projects
    .filter(function(p) { return p && !p.is_deleted && !p.is_archived; })
    .map(function(p) {
      return {
        id: str(p.id),
        name: str(p.name),
        parentId: p.parent_id ? str(p.parent_id) : null,
        inbox: !!first(p.inbox_project, p.is_inbox_project, false),
        shared: !!first(p.shared, p.is_shared, false)
      };
    });
  const live = {};
  projects.forEach(function(p) { live[p.id] = true; });

  const sections = (Array.isArray(data.sections) ? data.sections : [])
    .filter(function(s) { return s && !s.is_deleted && !s.is_archived && live[str(s.project_id)]; })
    .map(function(s) { return { id: str(s.id), name: str(s.name), projectId: str(s.project_id) }; });

  const people = (Array.isArray(data.collaborators) ? data.collaborators : [])
    .filter(function(c) { return c && c.id; })
    .map(function(c) { return { id: str(c.id), name: str(first(c.full_name, c.name, c.email, "")) }; });
  if (data.user && data.user.id && !people.some(function(c) { return c.id === str(data.user.id); })) {
    people.push({ id: str(data.user.id), name: str(first(data.user.full_name, data.user.email, "")) });
  }

  const tasks = data.items
    .filter(function(t) {
      if (!t || t.is_deleted) return false;
      if (first(t.checked, t.is_completed, false)) return false;
      return live[str(t.project_id)];
    })
    .map(function(t) {
      const due = t.due || null;
      const deadline = t.deadline || null;
      return {
        id: str(t.id),
        content: str(t.content),
        description: str(t.description),
        projectId: str(t.project_id),
        sectionId: t.section_id ? str(t.section_id) : null,
        parentId: t.parent_id ? str(t.parent_id) : null,
        order: Number(first(t.child_order, t.order, 0)) || 0,
        labels: Array.isArray(t.labels) ? t.labels.map(str) : [],
        priority: Number(t.priority) || 1,              // Todoist: 4 is P1 (urgent), 1 is P4 (normal)
        dueDate: due ? dateOnly(first(due.date, due.datetime)) : null,
        dueString: due ? str(due.string) : "",
        recurring: !!(due && due.is_recurring),
        deadline: deadline ? dateOnly(deadline.date) : null,
        assigneeId: first(t.responsible_uid, t.assignee_id, null) ? str(first(t.responsible_uid, t.assignee_id)) : null,
        addedAt: dateOnly(first(t.added_at, t.date_added, t.created_at, null))
      };
    });

  return jsonResponse(200, { ok: true, projects: projects, sections: sections, people: people, tasks: tasks });
};
