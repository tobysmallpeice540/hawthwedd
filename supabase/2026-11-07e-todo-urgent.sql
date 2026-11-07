-- supabase/2026-11-07e-todo-urgent.sql
--
-- An URGENT star on any to-do (Toby, 7 Nov 2026): starred ones go to the top of
-- every column, are on the person's home card whatever their day, and the
-- overdue WhatsApp can be told to send only starred ones (a tick on its card,
-- app_data hbf_whatsapp_settings_v1 templates.todo_overdue.urgentOnly — the
-- worker now says which are urgent).
-- todo_set_urgent(id, on): the star alone, from the card, by anyone who may
-- change the to-do. A repeat's next one keeps the star.
--
-- Builds on 2026-11-07d (production checked identical). Safe to run twice.

begin;

alter table public.todo_items add column if not exists urgent boolean not null default false;

create or replace function public.todo_item_json(i public.todo_items, p_uid uuid, p_role text)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'id', i.id, 'title', i.title, 'detail', i.detail, 'who', i.who, 'whoLabel', i.who_label,
    'area', i.area, 'areas', to_jsonb(i.areas), 'project', i.project, 'category', i.category, 'tags', to_jsonb(i.tags), 'repeat', i.repeat, 'urgent', i.urgent, 'priority', i.priority, 'setOn', i.set_on,
    'deadline', i.deadline, 'eventOn', i.event_on, 'dueOn', i.due_on, 'photos', i.photos, 'state', i.state,
    'comment', i.comment, 'doneAt', i.done_at, 'doneBy', i.done_by, 'doneById', i.done_by_id,
    'private', i.private, 'createdAt', i.created_at, 'createdBy', i.created_by,
    'createdById', i.created_by_id, 'updatedAt', i.updated_at,
    'canEdit', public.todo_can_edit(i, p_uid, p_role));
$$;

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
  v_tags text[];
  v_tag text;
  v_areas text[];
  v_repeat text := nullif(p ->> 'repeat', '');
  v_priority text := coalesce(nullif(p ->> 'priority', ''), 'week');
  v_deadline date;
  v_event_on date;
  v_private boolean := coalesce((p ->> 'private')::boolean, false);
  v_urgent boolean := coalesce((p ->> 'urgent')::boolean, false);
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
  begin v_event_on := nullif(p ->> 'eventOn', '')::date;
  exception when others then return jsonb_build_object('ok', false, 'error', 'bad_deadline'); end;
  -- Areas (7 Nov 2026): several per to-do. An app that sends only `area`
  -- (the 07c build) means one.
  if p ? 'areas' then
    if jsonb_typeof(p -> 'areas') not in ('array', 'null') then return jsonb_build_object('ok', false, 'error', 'bad_area'); end if;
    v_areas := '{}';
    for v_tag in select distinct e from jsonb_array_elements_text(coalesce(p -> 'areas', '[]'::jsonb)) e where e <> '' loop
      if not exists (select 1 from todo_lists where kind = 'area' and id = v_tag) then
        return jsonb_build_object('ok', false, 'error', 'bad_area');
      end if;
      v_areas := v_areas || v_tag;
    end loop;
    if cardinality(v_areas) > 12 then return jsonb_build_object('ok', false, 'error', 'bad_area'); end if;
  elsif p ? 'area' then
    if v_area is not null and not exists (select 1 from todo_lists where kind = 'area' and id = v_area) then
      return jsonb_build_object('ok', false, 'error', 'bad_area');
    end if;
    v_areas := case when v_area is null then '{}'::text[] else array[v_area] end;
  end if;
  -- Tags (7 Nov 2026): several per to-do, each one of the 'category' lists.
  -- An app that sends only `category` (the 07c build) means one tag.
  if p ? 'tags' then
    if jsonb_typeof(p -> 'tags') not in ('array', 'null') then return jsonb_build_object('ok', false, 'error', 'bad_category'); end if;
    v_tags := '{}';
    for v_tag in select distinct e from jsonb_array_elements_text(coalesce(p -> 'tags', '[]'::jsonb)) e where e <> '' loop
      if not exists (select 1 from todo_lists where kind = 'category' and id = v_tag) then
        return jsonb_build_object('ok', false, 'error', 'bad_category');
      end if;
      v_tags := v_tags || v_tag;
    end loop;
    if cardinality(v_tags) > 12 then return jsonb_build_object('ok', false, 'error', 'bad_category'); end if;
  elsif p ? 'category' then
    if v_category is not null and not exists (select 1 from todo_lists where kind = 'category' and id = v_category) then
      return jsonb_build_object('ok', false, 'error', 'bad_category');
    end if;
    v_tags := case when v_category is null then '{}'::text[] else array[v_category] end;
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
    insert into todo_items (id, title, detail, who, who_label, area, areas, project, category, tags, priority, repeat, set_on, deadline, event_on, photos,
                            private, urgent, created_by, created_by_id)
    values (v_id, v_title, v_detail, v_who, todo_who_label(v_who), (coalesce(v_areas, '{}'::text[]))[1], coalesce(v_areas, '{}'::text[]), v_project, (coalesce(v_tags, '{}'::text[]))[1], coalesce(v_tags, '{}'::text[]),
            v_priority, v_repeat, v_today, v_deadline,
            case when v_priority = 'event' then v_event_on end, v_photos, v_private, v_urgent, chk_person_label(v_me), v_me)
    returning * into v_row;
  else
    update todo_items set
      title = v_title, detail = v_detail, who = v_who,
      who_label = case when v_who = v_old.who then coalesce(v_old.who_label, todo_who_label(v_who)) else todo_who_label(v_who) end,
      areas = coalesce(v_areas, v_old.areas), area = (coalesce(v_areas, v_old.areas))[1], project = v_project,
      -- An app from before 7 Nov sends neither; what is there is kept.
      -- `category` is kept as the first tag, for a tab of the 07c build.
      tags = coalesce(v_tags, v_old.tags),
      category = (coalesce(v_tags, v_old.tags))[1],
      repeat = case when p ? 'repeat' then v_repeat else v_old.repeat end,
      priority = v_priority,
      set_on = case when v_priority = v_old.priority then v_old.set_on else v_today end,
      -- "Before next event" becomes a day when it is set: kept until the
      -- priority or the area changes (or it had none), then the app's new one.
      event_on = case when v_priority <> 'event' then null
                      when v_old.priority = 'event' and v_old.areas = coalesce(v_areas, v_old.areas) and v_old.event_on is not null then v_old.event_on
                      else v_event_on end,
      deadline = v_deadline, photos = v_photos, private = v_private,
      urgent = case when p ? 'urgent' then v_urgent else v_old.urgent end,   -- an older app sends none
      updated_at = now()
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
      insert into todo_items (id, title, detail, who, who_label, area, areas, project, category, tags, priority, repeat, set_on, deadline,
                              private, urgent, created_at, created_by, created_by_id, updated_at)
      values ('td_' || replace(gen_random_uuid()::text, '-', ''), v_item.title, v_item.detail, v_item.who, v_item.who_label,
              v_item.area, v_item.areas, v_item.project, v_item.category, v_item.tags, v_item.priority, v_item.repeat, v_today,
              todo_next_on(coalesce(v_item.deadline, v_today), v_item.repeat, v_today),
              v_item.private, v_item.urgent, now(), v_item.created_by, v_item.created_by_id, now())
      returning * into v_next;
      update todo_items set next_id = v_next.id where id = p_id returning * into v_item;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'item', todo_item_json(v_item, v_me, v_role),
    'next', case when v_next.id is null then null else todo_item_json(v_next, v_me, v_role) end);
end $$;

create or replace function public.todo_worker_overdue(p_from date, p_before date)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'title', i.title, 'person', pr.id, 'dueOn', i.due_on, 'urgent', i.urgent)
                            order by pr.id, i.due_on, i.created_at), '[]'::jsonb)
    from todo_items i
    join profiles pr on i.who = 'person:' || pr.id::text
   where i.state = 'open' and i.due_on >= p_from and i.due_on < p_before
     and pr.active and pr.role in ('admin', 'bar', 'cleaner')
     and todo_visible(i, pr.id, pr.role);
$$;

create or replace function public.todo_set_urgent(p_id text, p_on boolean)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_me uuid := auth.uid(); v_role text := chk_my_role(); v_item todo_items%rowtype;
begin
  if v_role is null then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  select * into v_item from todo_items where id = p_id for update;
  if v_item.id is null or not todo_visible(v_item, v_me, v_role) then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if not todo_can_edit(v_item, v_me, v_role) then return jsonb_build_object('ok', false, 'error', 'not_yours'); end if;
  update todo_items set urgent = coalesce(p_on, false), updated_at = now() where id = p_id returning * into v_item;
  return jsonb_build_object('ok', true, 'item', todo_item_json(v_item, v_me, v_role));
end $$;

-- New function: closed by default (Supabase opens every new one to anon AND
-- authenticated), then back to signed-in staff only.
revoke all on function public.todo_set_urgent(text, boolean) from public, anon, authenticated;
grant execute on function public.todo_set_urgent(text, boolean) to authenticated;

commit;
