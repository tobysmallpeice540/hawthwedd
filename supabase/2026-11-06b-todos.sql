-- supabase/2026-11-06b-todos.sql
--
-- The to-do list moves out of app_data into its own tables, so that PRIVATE
-- means private (Toby, 6 Nov 2026): a private to-do, or anything in someone
-- else's private project, never leaves the database for anyone who may not
-- see it — not to the app, not through the API.
--
--   todo_lists   areas and projects, one table, keyed (kind, id)
--   todo_items   the to-dos; due_on is worked out by the database
--   todo-photos  a private storage bucket; a photo is readable only by those
--                who may see its to-do (path = <to-do id>/<file>)
--
-- RLS is on with no policies on both tables, and they are revoked from anon
-- and authenticated: every read and write goes through a todo_ function
-- (SECURITY DEFINER), which decides who sees what. Storage needs policies
-- (it has no other way in); they call todo_photo_can_see / _can_change.
--
-- Who may see a to-do (todo_visible), the same rules as src/shared/todos.js:
--   · private: only its writer, and the person it is for if it names one
--   · in a private project: only the project's owner
--   · otherwise the office sees everything; the bar and housekeeping logins
--     see what is for their group or Everyone, and what they wrote.
-- Who may change one (todo_can_edit): the office, or whoever wrote it — and
-- only one they can see. Anyone who can see it may tick it; only whoever
-- ticked it, or the office, may untick it.
-- Areas and projects are the office's to add and change; a private project
-- is its owner's alone, and only the owner may make it public or private.
--
-- Copies whatever the app had saved in app_data (hbf_todo_*_v1); the app_data
-- rows are left where they are. Safe to run twice.

begin;

-- ── Tables ──────────────────────────────────────────────────────────────────
create table if not exists public.todo_lists (
  kind text not null check (kind in ('area', 'project')),
  id text not null check (id ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
  name text not null check (length(trim(name)) between 1 and 60),
  hidden boolean not null default false,
  private boolean not null default false,
  owner_id uuid,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (kind, id),
  constraint todo_lists_private_project check (not private or (kind = 'project' and owner_id is not null))
);

create table if not exists public.todo_items (
  id text primary key check (id ~ '^td_[A-Za-z0-9-]{6,64}$'),
  title text not null check (length(trim(title)) between 1 and 140),
  detail text not null default '' check (length(detail) <= 4000),
  who text not null default 'anyone'
    check (who ~ '^(anyone|role:(admin|bar|cleaner)|person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  who_label text,
  area text,
  project text,
  priority text not null default 'week' check (priority in ('day', 'week', 'month', 'eventually')),
  set_on date not null default ((now() at time zone 'Europe/London')::date),
  deadline date,
  -- A scope counted from the day it was set (1 / 7 / 28 days, or none), or
  -- the deadline if that comes first. LEAST ignores nulls.
  due_on date generated always as (
    least(case priority when 'day' then set_on + 1 when 'week' then set_on + 7 when 'month' then set_on + 28 end, deadline)
  ) stored,
  photos jsonb not null default '[]'::jsonb
    check (jsonb_typeof(photos) = 'array' and jsonb_array_length(photos) <= 6),
  state text not null default 'open' check (state in ('open', 'done', 'note', 'na')),
  comment text check (comment is null or length(comment) <= 1000),
  done_at timestamptz,
  done_by text,
  done_by_id uuid,
  private boolean not null default false,
  created_at timestamptz not null default now(),
  created_by text,
  created_by_id uuid,
  updated_at timestamptz not null default now()
);
create index if not exists todo_items_open_idx on public.todo_items (due_on) where state = 'open';
create index if not exists todo_items_done_idx on public.todo_items (done_at) where state <> 'open';
create index if not exists todo_items_project_idx on public.todo_items (project);
create index if not exists todo_items_area_idx on public.todo_items (area);

alter table public.todo_lists enable row level security;
alter table public.todo_items enable row level security;
revoke all on public.todo_lists, public.todo_items from public, anon, authenticated;

-- ── Rules ───────────────────────────────────────────────────────────────────
create or replace function public.todo_visible(i public.todo_items, p_uid uuid, p_role text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select p_role is not null and p_uid is not null
    and (not i.private or i.created_by_id = p_uid or i.who = 'person:' || p_uid::text)
    and (i.project is null or not exists (
          select 1 from todo_lists l
           where l.kind = 'project' and l.id = i.project and l.private and l.owner_id is distinct from p_uid))
    and (p_role = 'admin' or i.who = 'anyone' or i.who = 'person:' || p_uid::text
         or i.who = 'role:' || p_role or i.created_by_id = p_uid);
$$;

create or replace function public.todo_can_edit(i public.todo_items, p_uid uuid, p_role text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select public.todo_visible(i, p_uid, p_role) and (p_role = 'admin' or i.created_by_id = p_uid);
$$;

create or replace function public.todo_list_visible(l public.todo_lists, p_uid uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select not l.private or l.owner_id = p_uid;
$$;

create or replace function public.todo_who_label(p_who text)
returns text language sql stable security definer set search_path to 'public' as $$
  select case
    when p_who = 'anyone' then 'Everyone'
    when p_who = 'role:admin' then 'Office'
    when p_who = 'role:bar' then 'Bar'
    when p_who = 'role:cleaner' then 'Housekeeping'
    when p_who like 'person:%' then public.chk_person_label(substr(p_who, 8)::uuid)
    else 'Someone' end;
$$;

create or replace function public.todo_item_json(i public.todo_items, p_uid uuid, p_role text)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'id', i.id, 'title', i.title, 'detail', i.detail, 'who', i.who, 'whoLabel', i.who_label,
    'area', i.area, 'project', i.project, 'priority', i.priority, 'setOn', i.set_on,
    'deadline', i.deadline, 'dueOn', i.due_on, 'photos', i.photos, 'state', i.state,
    'comment', i.comment, 'doneAt', i.done_at, 'doneBy', i.done_by, 'doneById', i.done_by_id,
    'private', i.private, 'createdAt', i.created_at, 'createdBy', i.created_by,
    'createdById', i.created_by_id, 'updatedAt', i.updated_at,
    'canEdit', public.todo_can_edit(i, p_uid, p_role));
$$;

-- `uses` counts every to-do on it, seen or not: it is only ever used to
-- refuse a delete, and says nothing about what those to-dos are.
create or replace function public.todo_list_json(l public.todo_lists, p_uid uuid)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'id', l.id, 'name', l.name, 'hidden', l.hidden, 'private', l.private,
    'mine', l.owner_id is not distinct from p_uid and p_uid is not null,
    'uses', (select count(*) from todo_items i
              where (l.kind = 'area' and i.area = l.id) or (l.kind = 'project' and i.project = l.id)));
$$;

create or replace function public.todo_slug(p_kind text, p_name text)
returns text language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_base text := left(trim(both '-' from regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g')), 40);
  v_id text; n integer := 2;
begin
  if v_base = '' or v_base !~ '^[a-z0-9]' then v_base := 'item'; end if;
  v_id := v_base;
  while exists (select 1 from todo_lists where kind = p_kind and id = v_id) loop
    v_id := v_base || '-' || n; n := n + 1;
  end loop;
  return v_id;
end $$;

-- ── What a login reads ──────────────────────────────────────────────────────
-- Open to-dos, and finished ones from the last 45 days, that this login may
-- see; the areas; the projects it may see; and who it is.
create or replace function public.todo_get()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v_me uuid := auth.uid(); v_role text := chk_my_role();
begin
  if v_role is null then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true,
    'me', jsonb_build_object('id', v_me, 'role', v_role, 'name', chk_person_label(v_me)),
    'items', coalesce((select jsonb_agg(todo_item_json(i, v_me, v_role) order by i.created_at)
                         from todo_items i
                        where (i.state = 'open' or i.done_at > now() - interval '45 days')
                          and todo_visible(i, v_me, v_role)), '[]'::jsonb),
    'areas', coalesce((select jsonb_agg(todo_list_json(l, v_me) order by l.position, l.name)
                         from todo_lists l where l.kind = 'area'), '[]'::jsonb),
    'projects', coalesce((select jsonb_agg(todo_list_json(l, v_me) order by l.position, l.name)
                            from todo_lists l where l.kind = 'project' and todo_list_visible(l, v_me)), '[]'::jsonb));
end $$;

-- ── Add or change a to-do ───────────────────────────────────────────────────
-- p: { id, title, detail, who, area, project, priority, deadline, private,
--      photos: [{path, name}] }. The id is the app's (td_…), so photos can be
-- put up before the first save. Who wrote it, when, and the labels are the
-- database's to set. Ticking is todo_set_state, never this.
create or replace function public.todo_upsert(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_me uuid := auth.uid(); v_role text := chk_my_role();
  v_id text := p ->> 'id';
  v_title text := trim(coalesce(p ->> 'title', ''));
  v_detail text := trim(coalesce(p ->> 'detail', ''));
  v_who text := coalesce(nullif(p ->> 'who', ''), 'anyone');
  v_area text := nullif(p ->> 'area', '');
  v_project text := nullif(p ->> 'project', '');
  v_priority text := coalesce(nullif(p ->> 'priority', ''), 'week');
  v_deadline date;
  v_private boolean := coalesce((p ->> 'private')::boolean, false);
  v_photos jsonb := '[]'::jsonb;
  v_ph jsonb;
  v_old todo_items%rowtype;
  v_row todo_items%rowtype;
  v_today date := (now() at time zone 'Europe/London')::date;
begin
  if v_role is null then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if v_id is null or v_id !~ '^td_[A-Za-z0-9-]{6,64}$' then return jsonb_build_object('ok', false, 'error', 'bad_id'); end if;
  if v_title = '' then return jsonb_build_object('ok', false, 'error', 'no_title'); end if;
  if length(v_title) > 140 then return jsonb_build_object('ok', false, 'error', 'title_too_long'); end if;
  if length(v_detail) > 4000 then return jsonb_build_object('ok', false, 'error', 'detail_too_long'); end if;
  if v_priority not in ('day', 'week', 'month', 'eventually') then return jsonb_build_object('ok', false, 'error', 'bad_priority'); end if;
  if v_who !~ '^(anyone|role:(admin|bar|cleaner)|person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' then
    return jsonb_build_object('ok', false, 'error', 'bad_who');
  end if;
  begin v_deadline := nullif(p ->> 'deadline', '')::date;
  exception when others then return jsonb_build_object('ok', false, 'error', 'bad_deadline'); end;
  if v_area is not null and not exists (select 1 from todo_lists where kind = 'area' and id = v_area) then
    return jsonb_build_object('ok', false, 'error', 'bad_area');
  end if;

  select * into v_old from todo_items where id = v_id for update;
  if v_old.id is not null then
    if not todo_visible(v_old, v_me, v_role) then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    if not todo_can_edit(v_old, v_me, v_role) then return jsonb_build_object('ok', false, 'error', 'not_yours'); end if;
  end if;

  -- A person must be a working login. One already on the to-do may have
  -- left since; changing something else keeps them.
  if v_who like 'person:%' and v_who is distinct from v_old.who and not exists (
       select 1 from profiles where id = substr(v_who, 8)::uuid and active and role in ('admin', 'bar', 'cleaner')) then
    return jsonb_build_object('ok', false, 'error', 'bad_who');
  end if;
  -- A project this login cannot see cannot be chosen; one it already sits in
  -- (the office editing someone's to-do) stays.
  if v_project is not null and v_project is distinct from v_old.project and not exists (
       select 1 from todo_lists l where l.kind = 'project' and l.id = v_project and todo_list_visible(l, v_me)) then
    return jsonb_build_object('ok', false, 'error', 'bad_project');
  end if;

  -- Photos live under this to-do's own folder (or the old booking-files one).
  if jsonb_typeof(coalesce(p -> 'photos', '[]'::jsonb)) <> 'array' then return jsonb_build_object('ok', false, 'error', 'bad_photos'); end if;
  for v_ph in select * from jsonb_array_elements(coalesce(p -> 'photos', '[]'::jsonb)) loop
    if jsonb_typeof(v_ph) <> 'object'
       or coalesce(v_ph ->> 'path', '') !~ ('^(todos/)?' || v_id || '/[A-Za-z0-9._-]{1,80}$') then
      return jsonb_build_object('ok', false, 'error', 'bad_photos');
    end if;
    v_photos := v_photos || jsonb_build_array(jsonb_build_object('path', v_ph ->> 'path', 'name', left(coalesce(v_ph ->> 'name', 'photo'), 120)));
  end loop;
  if jsonb_array_length(v_photos) > 6 then return jsonb_build_object('ok', false, 'error', 'too_many_photos'); end if;

  if v_old.id is null then
    insert into todo_items (id, title, detail, who, who_label, area, project, priority, set_on, deadline, photos,
                            private, created_by, created_by_id)
    values (v_id, v_title, v_detail, v_who, todo_who_label(v_who), v_area, v_project, v_priority, v_today, v_deadline,
            v_photos, v_private, chk_person_label(v_me), v_me)
    returning * into v_row;
  else
    update todo_items set
      title = v_title, detail = v_detail, who = v_who,
      who_label = case when v_who = v_old.who then coalesce(v_old.who_label, todo_who_label(v_who)) else todo_who_label(v_who) end,
      area = v_area, project = v_project, priority = v_priority,
      set_on = case when v_priority = v_old.priority then v_old.set_on else v_today end,
      deadline = v_deadline, photos = v_photos, private = v_private, updated_at = now()
     where id = v_id
    returning * into v_row;
  end if;
  return jsonb_build_object('ok', true, 'item', todo_item_json(v_row, v_me, v_role));
end $$;

-- ── Tick, comment, not applicable, untick ───────────────────────────────────
create or replace function public.todo_set_state(p_id text, p_state text, p_comment text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_me uuid := auth.uid(); v_role text := chk_my_role();
  v_item todo_items%rowtype;
  v_comment text := nullif(trim(coalesce(p_comment, '')), '');
begin
  if v_role is null then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if p_state not in ('done', 'note', 'na', 'open') then return jsonb_build_object('ok', false, 'error', 'bad_state'); end if;
  select * into v_item from todo_items where id = p_id for update;
  if v_item.id is null or not todo_visible(v_item, v_me, v_role) then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if p_state = 'note' and v_comment is null then return jsonb_build_object('ok', false, 'error', 'comment_needed'); end if;
  if length(coalesce(v_comment, '')) > 1000 then return jsonb_build_object('ok', false, 'error', 'comment_too_long'); end if;
  if p_state = 'open' then
    if v_item.state <> 'open' then
      if v_role <> 'admin' and v_item.done_by_id is distinct from v_me then
        return jsonb_build_object('ok', false, 'error', 'not_your_tick');
      end if;
      update todo_items set state = 'open', comment = null, done_at = null, done_by = null, done_by_id = null, updated_at = now()
       where id = p_id returning * into v_item;
    end if;
  else
    update todo_items set state = p_state, done_at = now(), done_by = chk_person_label(v_me), done_by_id = v_me,
                          comment = case when p_state = 'done' then null else v_comment end, updated_at = now()
     where id = p_id returning * into v_item;
  end if;
  return jsonb_build_object('ok', true, 'item', todo_item_json(v_item, v_me, v_role));
end $$;

-- ── Delete ──────────────────────────────────────────────────────────────────
-- Returns the photos, for the app to take down from storage.
create or replace function public.todo_delete(p_id text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_me uuid := auth.uid(); v_role text := chk_my_role(); v_item todo_items%rowtype;
begin
  if v_role is null then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  select * into v_item from todo_items where id = p_id for update;
  if v_item.id is null or not todo_visible(v_item, v_me, v_role) then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if not todo_can_edit(v_item, v_me, v_role) then return jsonb_build_object('ok', false, 'error', 'not_yours'); end if;
  delete from todo_items where id = p_id;
  return jsonb_build_object('ok', true, 'photos', v_item.photos);
end $$;

-- ── Areas and projects ──────────────────────────────────────────────────────
-- p: { id (absent = new), name, hidden, private }. The office only. A new
-- one gets its id from its name. A private project is its owner's: nobody
-- else can see it, rename it or open it up.
create or replace function public.todo_save_list(p_kind text, p jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_me uuid := auth.uid(); v_role text := chk_my_role();
  v_id text := nullif(p ->> 'id', '');
  v_name text := trim(coalesce(p ->> 'name', ''));
  v_old todo_lists%rowtype; v_row todo_lists%rowtype;
begin
  if v_role is null then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if v_role <> 'admin' then return jsonb_build_object('ok', false, 'error', 'office_only'); end if;
  if p_kind not in ('area', 'project') then return jsonb_build_object('ok', false, 'error', 'bad_kind'); end if;
  if p ? 'private' and p_kind = 'area' and coalesce((p ->> 'private')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', 'areas_are_shared');
  end if;
  if v_id is not null then
    select * into v_old from todo_lists where kind = p_kind and id = v_id for update;
  end if;
  if v_old.id is null then
    -- An id that names nothing is a change to something since deleted.
    if v_id is not null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    if v_name = '' then return jsonb_build_object('ok', false, 'error', 'no_name'); end if;
    if length(v_name) > 60 then return jsonb_build_object('ok', false, 'error', 'name_too_long'); end if;
    insert into todo_lists (kind, id, name, hidden, private, owner_id, position)
    values (p_kind, todo_slug(p_kind, v_name), v_name, coalesce((p ->> 'hidden')::boolean, false),
            p_kind = 'project' and coalesce((p ->> 'private')::boolean, false), v_me,
            coalesce((select max(position) + 1 from todo_lists where kind = p_kind), 0))
    returning * into v_row;
  else
    if not todo_list_visible(v_old, v_me) then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    if p ? 'private' and coalesce((p ->> 'private')::boolean, false) is distinct from v_old.private
       and v_old.owner_id is distinct from v_me then
      return jsonb_build_object('ok', false, 'error', 'not_your_project');
    end if;
    if p ? 'name' and (v_name = '' or length(v_name) > 60) then return jsonb_build_object('ok', false, 'error', 'no_name'); end if;
    update todo_lists set
      name = case when p ? 'name' then v_name else name end,
      hidden = case when p ? 'hidden' then coalesce((p ->> 'hidden')::boolean, false) else hidden end,
      private = case when p ? 'private' then coalesce((p ->> 'private')::boolean, false) else private end,
      updated_at = now()
     where kind = p_kind and id = v_id
    returning * into v_row;
  end if;
  return jsonb_build_object('ok', true, 'list', todo_list_json(v_row, v_me));
end $$;

create or replace function public.todo_delete_list(p_kind text, p_id text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_me uuid := auth.uid(); v_role text := chk_my_role(); v_old todo_lists%rowtype;
begin
  if v_role is null then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if v_role <> 'admin' then return jsonb_build_object('ok', false, 'error', 'office_only'); end if;
  select * into v_old from todo_lists where kind = p_kind and id = p_id for update;
  if v_old.id is null or not todo_list_visible(v_old, v_me) then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if exists (select 1 from todo_items i where (p_kind = 'area' and i.area = p_id) or (p_kind = 'project' and i.project = p_id)) then
    return jsonb_build_object('ok', false, 'error', 'in_use');
  end if;
  delete from todo_lists where kind = p_kind and id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- ── For the WhatsApp sender (service role only) ─────────────────────────────
-- Open to-dos for a NAMED person whose due day is in [p_from, p_before) —
-- the sender asks for yesterday, so each goes once, the morning it falls
-- overdue — and only those that person may see.
create or replace function public.todo_worker_overdue(p_from date, p_before date)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'title', i.title, 'person', pr.id, 'dueOn', i.due_on)
                            order by pr.id, i.due_on, i.created_at), '[]'::jsonb)
    from todo_items i
    join profiles pr on i.who = 'person:' || pr.id::text
   where i.state = 'open' and i.due_on >= p_from and i.due_on < p_before
     and pr.active and pr.role in ('admin', 'bar', 'cleaner')
     and todo_visible(i, pr.id, pr.role);
$$;

-- ── Photos ──────────────────────────────────────────────────────────────────
-- Path <to-do id>/<file>. Seen by whoever may see the to-do (and whoever put
-- it up, before the to-do's first save); put up or taken down by whoever may
-- change the to-do, or by anyone on staff while the to-do does not exist yet.
create or replace function public.todo_photo_can_see(p_name text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from todo_items i
                  where i.id = split_part(p_name, '/', 1) and todo_visible(i, auth.uid(), chk_my_role()));
$$;
create or replace function public.todo_photo_can_change(p_name text)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select chk_my_role() is not null and (
    not exists (select 1 from todo_items i where i.id = split_part(p_name, '/', 1))
    or exists (select 1 from todo_items i where i.id = split_part(p_name, '/', 1) and todo_can_edit(i, auth.uid(), chk_my_role())));
$$;

-- ── Grants: nothing open by default (Supabase grants every new function to
-- anon AND authenticated), then back only where wanted.
do $g$
declare f text;
begin
  foreach f in array array[
    'todo_visible(public.todo_items, uuid, text)', 'todo_can_edit(public.todo_items, uuid, text)',
    'todo_list_visible(public.todo_lists, uuid)', 'todo_who_label(text)',
    'todo_item_json(public.todo_items, uuid, text)', 'todo_list_json(public.todo_lists, uuid)',
    'todo_slug(text, text)', 'todo_get()', 'todo_upsert(jsonb)', 'todo_set_state(text, text, text)',
    'todo_delete(text)', 'todo_save_list(text, jsonb)', 'todo_delete_list(text, text)',
    'todo_worker_overdue(date, date)', 'todo_photo_can_see(text)', 'todo_photo_can_change(text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['todo_get()', 'todo_upsert(jsonb)', 'todo_set_state(text, text, text)', 'todo_delete(text)',
                           'todo_save_list(text, jsonb)', 'todo_delete_list(text, text)',
                           'todo_photo_can_see(text)', 'todo_photo_can_change(text)'] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  execute 'grant execute on function public.todo_worker_overdue(date, date) to service_role';
end $g$;

-- ── The private bucket and its policies (skipped where there is no storage
-- schema, i.e. the scratch Postgres the tests run on) ─────────────────────────
do $s$
begin
  if to_regclass('storage.buckets') is null then return; end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('todo-photos', 'todo-photos', false, 15728640,
          array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif'])
  on conflict (id) do nothing;
  execute 'drop policy if exists todo_photos_read on storage.objects';
  execute 'drop policy if exists todo_photos_insert on storage.objects';
  execute 'drop policy if exists todo_photos_update on storage.objects';
  execute 'drop policy if exists todo_photos_delete on storage.objects';
  execute $p$create policy todo_photos_read on storage.objects for select to authenticated
    using (bucket_id = 'todo-photos' and (owner_id = auth.uid()::text or public.todo_photo_can_see(name)))$p$;
  execute $p$create policy todo_photos_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'todo-photos' and public.todo_photo_can_change(name))$p$;
  execute $p$create policy todo_photos_update on storage.objects for update to authenticated
    using (bucket_id = 'todo-photos' and public.todo_photo_can_change(name))
    with check (bucket_id = 'todo-photos' and public.todo_photo_can_change(name))$p$;
  execute $p$create policy todo_photos_delete on storage.objects for delete to authenticated
    using (bucket_id = 'todo-photos' and (owner_id = auth.uid()::text or public.todo_photo_can_change(name)))$p$;
end $s$;

-- ── Copy what the app saved in app_data (rows that fit; nothing overwritten) ─
insert into todo_lists (kind, id, name, hidden, position)
select 'area', e ->> 'id', trim(e ->> 'name'), coalesce((e ->> 'hidden')::boolean, false), (o - 1)::integer
  from app_data d, jsonb_array_elements(case when jsonb_typeof(d.value) = 'array' then d.value else '[]'::jsonb end) with ordinality as x(e, o)
 where d.key = 'hbf_todo_areas_v1'
   and coalesce(e ->> 'id', '') ~ '^[a-z0-9][a-z0-9-]{0,59}$' and length(trim(coalesce(e ->> 'name', ''))) between 1 and 60
on conflict (kind, id) do nothing;

-- The standard areas, if there were none to copy.
insert into todo_lists (kind, id, name, position)
select 'area', a.id, a.name, a.pos from (values
  ('admin', 'Admin', 0), ('amly-barn', 'Amly Barn', 1), ('grain-store', 'Grain Store', 2), ('glamping', 'Glamping', 3),
  ('hamlet', 'The Hamlet', 4), ('cinema-barn', 'Cinema Barn', 5), ('wood-store', 'Wood Store', 6),
  ('old-brewery', 'Old Brewery', 7), ('barn-in-the-woods', 'Barn in the Woods', 8)) as a(id, name, pos)
 where not exists (select 1 from todo_lists where kind = 'area')
on conflict (kind, id) do nothing;

insert into todo_lists (kind, id, name, hidden, private, owner_id, position)
select 'project', e ->> 'id', trim(e ->> 'name'), coalesce((e ->> 'hidden')::boolean, false),
       coalesce((e ->> 'private')::boolean, false) and coalesce(e ->> 'ownerId', '') ~ '^[0-9a-f-]{36}$',
       case when coalesce(e ->> 'ownerId', '') ~ '^[0-9a-f-]{36}$' then (e ->> 'ownerId')::uuid end, (o - 1)::integer
  from app_data d, jsonb_array_elements(case when jsonb_typeof(d.value) = 'array' then d.value else '[]'::jsonb end) with ordinality as x(e, o)
 where d.key = 'hbf_todo_projects_v1'
   and coalesce(e ->> 'id', '') ~ '^[a-z0-9][a-z0-9-]{0,59}$' and length(trim(coalesce(e ->> 'name', ''))) between 1 and 60
on conflict (kind, id) do nothing;

insert into todo_items (id, title, detail, who, who_label, area, project, priority, set_on, deadline, photos, state, comment,
                        done_at, done_by, done_by_id, private, created_at, created_by, created_by_id, updated_at)
select e ->> 'id', trim(e ->> 'title'), left(coalesce(e ->> 'detail', ''), 4000),
       coalesce(nullif(e ->> 'who', ''), 'anyone'), e ->> 'whoLabel', nullif(e ->> 'area', ''), nullif(e ->> 'project', ''),
       e ->> 'priority',
       coalesce(case when coalesce(e ->> 'setOn', '') ~ '^\d{4}-\d{2}-\d{2}$' then (e ->> 'setOn')::date end, (now() at time zone 'Europe/London')::date),
       case when coalesce(e ->> 'deadline', '') ~ '^\d{4}-\d{2}-\d{2}$' then (e ->> 'deadline')::date end,
       case when jsonb_typeof(e -> 'photos') = 'array' and jsonb_array_length(e -> 'photos') <= 6 then e -> 'photos' else '[]'::jsonb end,
       coalesce(nullif(e ->> 'state', ''), 'open'), left(e ->> 'comment', 1000),
       nullif(e ->> 'doneAt', '')::timestamptz, e ->> 'doneBy',
       case when coalesce(e ->> 'doneById', '') ~ '^[0-9a-f-]{36}$' then (e ->> 'doneById')::uuid end,
       coalesce((e ->> 'private')::boolean, false),
       coalesce(nullif(e ->> 'createdAt', '')::timestamptz, now()), e ->> 'createdBy',
       case when coalesce(e ->> 'createdById', '') ~ '^[0-9a-f-]{36}$' then (e ->> 'createdById')::uuid end,
       coalesce(nullif(e ->> 'updatedAt', '')::timestamptz, now())
  from app_data d, jsonb_array_elements(case when jsonb_typeof(d.value) = 'array' then d.value else '[]'::jsonb end) e
 where d.key = 'hbf_todos_v1'
   and coalesce(e ->> 'id', '') ~ '^td_[A-Za-z0-9-]{6,64}$'
   and length(trim(coalesce(e ->> 'title', ''))) between 1 and 140
   and coalesce(nullif(e ->> 'who', ''), 'anyone') ~ '^(anyone|role:(admin|bar|cleaner)|person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
   and coalesce(e ->> 'priority', '') in ('day', 'week', 'month', 'eventually')
   and coalesce(nullif(e ->> 'state', ''), 'open') in ('open', 'done', 'note', 'na')
on conflict (id) do nothing;

commit;
