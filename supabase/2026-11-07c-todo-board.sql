-- supabase/2026-11-07c-todo-board.sql
--
-- The to-do list after Toby's Todoist (7 Nov 2026):
--   · CATEGORIES — a third list beside areas and projects (Todoist's projects
--     become categories, its sections become projects). Shared, like areas.
--     A to-do may have no category, project or area.
--   · PRIORITY — "1 day" becomes 3 days ('three'), and a new "Before next
--     event" ('event'): before the next check-in at The Hamlet, Amly Barn or
--     Glamping when that is its area, otherwise before the next event at the
--     venue. The bookings live in app_data JSON and box_events, so the app
--     works that date out; due_on (and the overdue WhatsApp) leave it out.
--   · REPEAT — daily, weekdays, weekly, monthly or yearly. Ticking one (or
--     marking it not applicable) leaves the next one behind, due on the next
--     day the rule gives after today (todo_next_on); unticking takes that back
--     if nobody has touched it.
--   · A "Farm" area.
--
-- Builds on 2026-11-06b-todos.sql, whose function bodies were checked
-- identical to production (md5 of the whitespace-squashed prosrc, all 16)
-- before this was written. Safe to run twice.

begin;

-- ── Lists: a third kind ─────────────────────────────────────────────────────
alter table public.todo_lists drop constraint if exists todo_lists_kind_check;
alter table public.todo_lists add constraint todo_lists_kind_check check (kind in ('area', 'project', 'category'));

insert into public.todo_lists (kind, id, name, position)
select 'area', 'farm', 'Farm', coalesce((select max(position) + 1 from public.todo_lists where kind = 'area'), 0)
on conflict (kind, id) do nothing;

-- ── To-dos: category, repeat, the priorities ────────────────────────────────
alter table public.todo_items add column if not exists category text;
alter table public.todo_items add column if not exists repeat text;
alter table public.todo_items add column if not exists next_id text;
alter table public.todo_items drop constraint if exists todo_items_repeat_check;
alter table public.todo_items add constraint todo_items_repeat_check
  check (repeat is null or repeat in ('daily', 'weekdays', 'weekly', 'monthly', 'yearly'));

-- due_on is generated from the priority, so it is made again around the change.
drop index if exists public.todo_items_open_idx;
alter table public.todo_items drop column if exists due_on;
alter table public.todo_items drop constraint if exists todo_items_priority_check;
update public.todo_items set priority = 'three' where priority = 'day';
alter table public.todo_items add constraint todo_items_priority_check
  check (priority in ('three', 'week', 'month', 'event', 'eventually'));
alter table public.todo_items add column due_on date generated always as (
  least(case priority when 'three' then set_on + 3 when 'week' then set_on + 7 when 'month' then set_on + 28 end, deadline)
) stored;
create index if not exists todo_items_open_idx on public.todo_items (due_on) where state = 'open';
create index if not exists todo_items_category_idx on public.todo_items (category);

-- ── The next day a repeat falls on, after p_today (at least one step on) ────
create or replace function public.todo_next_on(p_from date, p_rule text, p_today date)
returns date language plpgsql immutable security definer set search_path to 'public' as $$
declare d date := p_from; n integer := 0;
begin
  if p_from is null or p_rule is null then return null; end if;
  loop
    n := n + 1;
    if p_rule = 'daily' then d := p_from + n;
    elsif p_rule = 'weekdays' then
      d := d + 1;
      while extract(isodow from d) > 5 loop d := d + 1; end loop;
    elsif p_rule = 'weekly' then d := p_from + 7 * n;
    elsif p_rule = 'monthly' then d := (p_from + make_interval(months => n))::date;   -- from the first day, so the 31st does not drift
    elsif p_rule = 'yearly' then d := (p_from + make_interval(years => n))::date;
    else return null;
    end if;
    exit when d > p_today or n > 4000;
  end loop;
  return d;
end $$;

create or replace function public.todo_item_json(i public.todo_items, p_uid uuid, p_role text)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'id', i.id, 'title', i.title, 'detail', i.detail, 'who', i.who, 'whoLabel', i.who_label,
    'area', i.area, 'project', i.project, 'category', i.category, 'repeat', i.repeat, 'priority', i.priority, 'setOn', i.set_on,
    'deadline', i.deadline, 'dueOn', i.due_on, 'photos', i.photos, 'state', i.state,
    'comment', i.comment, 'doneAt', i.done_at, 'doneBy', i.done_by, 'doneById', i.done_by_id,
    'private', i.private, 'createdAt', i.created_at, 'createdBy', i.created_by,
    'createdById', i.created_by_id, 'updatedAt', i.updated_at,
    'canEdit', public.todo_can_edit(i, p_uid, p_role));
$$;

create or replace function public.todo_list_json(l public.todo_lists, p_uid uuid)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'id', l.id, 'name', l.name, 'hidden', l.hidden, 'private', l.private,
    'mine', l.owner_id is not distinct from p_uid and p_uid is not null,
    'uses', (select count(*) from todo_items i
              where (l.kind = 'area' and i.area = l.id) or (l.kind = 'project' and i.project = l.id)
                 or (l.kind = 'category' and i.category = l.id)));
$$;

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
                            from todo_lists l where l.kind = 'project' and todo_list_visible(l, v_me)), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(todo_list_json(l, v_me) order by l.position, l.name)
                              from todo_lists l where l.kind = 'category'), '[]'::jsonb));
end $$;

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
  v_category text := nullif(p ->> 'category', '');
  v_repeat text := nullif(p ->> 'repeat', '');
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
  -- 'day' (1 day) became 3 days on 7 Nov 2026; a tab of an older build may still send it.
  if v_priority = 'day' then v_priority := 'three'; end if;
  if v_priority not in ('three', 'week', 'month', 'event', 'eventually') then return jsonb_build_object('ok', false, 'error', 'bad_priority'); end if;
  if v_repeat is not null and v_repeat not in ('daily', 'weekdays', 'weekly', 'monthly', 'yearly') then
    return jsonb_build_object('ok', false, 'error', 'bad_repeat');
  end if;
  if v_who !~ '^(anyone|role:(admin|bar|cleaner)|person:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' then
    return jsonb_build_object('ok', false, 'error', 'bad_who');
  end if;
  begin v_deadline := nullif(p ->> 'deadline', '')::date;
  exception when others then return jsonb_build_object('ok', false, 'error', 'bad_deadline'); end;
  if v_area is not null and not exists (select 1 from todo_lists where kind = 'area' and id = v_area) then
    return jsonb_build_object('ok', false, 'error', 'bad_area');
  end if;
  if v_category is not null and not exists (select 1 from todo_lists where kind = 'category' and id = v_category) then
    return jsonb_build_object('ok', false, 'error', 'bad_category');
  end if;
  -- A repeating to-do is due on a day: with none given, today.
  if v_repeat is not null and v_deadline is null then v_deadline := v_today; end if;

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
    insert into todo_items (id, title, detail, who, who_label, area, project, category, priority, repeat, set_on, deadline, photos,
                            private, created_by, created_by_id)
    values (v_id, v_title, v_detail, v_who, todo_who_label(v_who), v_area, v_project, v_category, v_priority, v_repeat, v_today, v_deadline,
            v_photos, v_private, chk_person_label(v_me), v_me)
    returning * into v_row;
  else
    update todo_items set
      title = v_title, detail = v_detail, who = v_who,
      who_label = case when v_who = v_old.who then coalesce(v_old.who_label, todo_who_label(v_who)) else todo_who_label(v_who) end,
      area = v_area, project = v_project,
      -- An app from before 7 Nov sends neither; what is there is kept.
      category = case when p ? 'category' then v_category else v_old.category end,
      repeat = case when p ? 'repeat' then v_repeat else v_old.repeat end,
      priority = v_priority,
      set_on = case when v_priority = v_old.priority then v_old.set_on else v_today end,
      deadline = v_deadline, photos = v_photos, private = v_private, updated_at = now()
     where id = v_id
    returning * into v_row;
  end if;
  return jsonb_build_object('ok', true, 'item', todo_item_json(v_row, v_me, v_role));
end $$;

create or replace function public.todo_set_state(p_id text, p_state text, p_comment text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_me uuid := auth.uid(); v_role text := chk_my_role();
  v_item todo_items%rowtype;
  v_next todo_items%rowtype;
  v_comment text := nullif(trim(coalesce(p_comment, '')), '');
  v_today date := (now() at time zone 'Europe/London')::date;
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
      -- Unticking a repeating to-do takes back the next one it made, if nobody
      -- has touched that yet (otherwise both stay; one can be deleted).
      if v_item.next_id is not null then
        delete from todo_items n where n.id = v_item.next_id and n.state = 'open' and n.updated_at = n.created_at;
      end if;
      update todo_items set state = 'open', comment = null, done_at = null, done_by = null, done_by_id = null,
                            next_id = null, updated_at = now()
       where id = p_id returning * into v_item;
    end if;
  else
    update todo_items set state = p_state, done_at = now(), done_by = chk_person_label(v_me), done_by_id = v_me,
                          comment = case when p_state = 'done' then null else v_comment end, updated_at = now()
     where id = p_id returning * into v_item;
    -- A repeating to-do, ticked (or marked not applicable) for the first time,
    -- leaves the next one behind: a copy, open, due on the next day the rule
    -- gives after today. Still the writer's, so the same people see and change it.
    if v_item.repeat is not null and v_item.next_id is null then
      insert into todo_items (id, title, detail, who, who_label, area, project, category, priority, repeat, set_on, deadline,
                              private, created_at, created_by, created_by_id, updated_at)
      values ('td_' || replace(gen_random_uuid()::text, '-', ''), v_item.title, v_item.detail, v_item.who, v_item.who_label,
              v_item.area, v_item.project, v_item.category, v_item.priority, v_item.repeat, v_today,
              todo_next_on(coalesce(v_item.deadline, v_today), v_item.repeat, v_today),
              v_item.private, now(), v_item.created_by, v_item.created_by_id, now())
      returning * into v_next;
      update todo_items set next_id = v_next.id where id = p_id returning * into v_item;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'item', todo_item_json(v_item, v_me, v_role),
    'next', case when v_next.id is null then null else todo_item_json(v_next, v_me, v_role) end);
end $$;

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
  if p_kind not in ('area', 'project', 'category') then return jsonb_build_object('ok', false, 'error', 'bad_kind'); end if;
  if p ? 'private' and p_kind <> 'project' and coalesce((p ->> 'private')::boolean, false) then
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
  if exists (select 1 from todo_items i where (p_kind = 'area' and i.area = p_id) or (p_kind = 'project' and i.project = p_id)
                                            or (p_kind = 'category' and i.category = p_id)) then
    return jsonb_build_object('ok', false, 'error', 'in_use');
  end if;
  delete from todo_lists where kind = p_kind and id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- ── Grants (todo_next_on is internal; the rest keep theirs) ──────────────────
revoke all on function public.todo_next_on(date, text, date) from public, anon, authenticated;

commit;
