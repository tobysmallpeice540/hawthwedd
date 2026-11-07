-- supabase/2026-11-07d-todo-event-day.sql
--
-- Two changes after Toby tried the board (7 Nov 2026):
--   · "Before next event" is turned into a DAY when it is set (event_on):
--     events are booked months ahead and these are short jobs, so the next
--     check-in / event at the moment it is set is the day. The app works the
--     day out (it holds the bookings) and sends it as eventOn; the database
--     keeps it until the priority or the area changes. due_on now includes it,
--     so the overdue WhatsApp and every login see the same day.
--   · "Category" now means a tag on each to-do (Admin, Maintenance, To buy…).
--     The higher-level categories from the Todoist import are retired; the
--     data move is done separately (it is about this farm's lists, not code).
--     Nothing in the schema changes for that.
--
-- Builds on 2026-11-07c (production checked identical). Safe to run twice.

begin;

alter table public.todo_items add column if not exists event_on date;

drop index if exists public.todo_items_open_idx;
alter table public.todo_items drop column if exists due_on;
alter table public.todo_items add column due_on date generated always as (
  least(case priority when 'three' then set_on + 3 when 'week' then set_on + 7 when 'month' then set_on + 28
                      when 'event' then event_on end, deadline)
) stored;
create index if not exists todo_items_open_idx on public.todo_items (due_on) where state = 'open';

create or replace function public.todo_item_json(i public.todo_items, p_uid uuid, p_role text)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'id', i.id, 'title', i.title, 'detail', i.detail, 'who', i.who, 'whoLabel', i.who_label,
    'area', i.area, 'project', i.project, 'category', i.category, 'repeat', i.repeat, 'priority', i.priority, 'setOn', i.set_on,
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
  v_repeat text := nullif(p ->> 'repeat', '');
  v_priority text := coalesce(nullif(p ->> 'priority', ''), 'week');
  v_deadline date;
  v_event_on date;
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
  begin v_event_on := nullif(p ->> 'eventOn', '')::date;
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
    insert into todo_items (id, title, detail, who, who_label, area, project, category, priority, repeat, set_on, deadline, event_on, photos,
                            private, created_by, created_by_id)
    values (v_id, v_title, v_detail, v_who, todo_who_label(v_who), v_area, v_project, v_category, v_priority, v_repeat, v_today, v_deadline,
            case when v_priority = 'event' then v_event_on end, v_photos, v_private, chk_person_label(v_me), v_me)
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
      -- "Before next event" becomes a day when it is set: kept until the
      -- priority or the area changes (or it had none), then the app's new one.
      event_on = case when v_priority <> 'event' then null
                      when v_old.priority = 'event' and v_old.area is not distinct from v_area and v_old.event_on is not null then v_old.event_on
                      else v_event_on end,
      deadline = v_deadline, photos = v_photos, private = v_private, updated_at = now()
     where id = v_id
    returning * into v_row;
  end if;
  return jsonb_build_object('ok', true, 'item', todo_item_json(v_row, v_me, v_role));
end $$;

commit;
