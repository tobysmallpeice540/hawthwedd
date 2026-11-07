-- supabase/2026-11-07d-todo-event-day-test.sql
--
-- After the 2026-11-07c sequence and its test:
--   psql -d tdtest -f supabase/2026-11-07d-todo-event-day.sql   (twice)
--   psql -d tdtest -f supabase/2026-11-07d-todo-event-day-test.sql
-- All passing prints "todo event day: all assertions passed".

\set ON_ERROR_STOP 1

create or replace function pg_temp.as_(p text) returns void language sql as
  $$ select set_config('t.uid', case p when 'T' then '00000000-0000-0000-0000-0000000000a1' else '' end, false) $$;
create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as
  $$ begin if not coalesce(ok, false) then raise exception 'FAILED: %', what; end if; end $$;

do $t$
declare r jsonb; today date := (now() at time zone 'Europe/London')::date;
begin
  perform pg_temp.as_('T');
  -- Set with the day the app worked out: due that day, everywhere.
  r := public.todo_upsert(jsonb_build_object('id', 'td_evday001', 'title', 'Hamlet shower', 'area', 'hamlet', 'priority', 'event', 'eventOn', today + 5));
  perform pg_temp.check((r -> 'item' ->> 'eventOn')::date = today + 5 and (r -> 'item' ->> 'dueOn')::date = today + 5, 'event day stored and due: ' || r::text);
  perform pg_temp.check((select due_on from todo_items where id = 'td_evday001') = today + 5, 'due_on has it, for the WhatsApp');
  -- Saving again with a different day the app now sees keeps the first.
  r := public.todo_upsert(jsonb_build_object('id', 'td_evday001', 'title', 'Hamlet shower, both', 'area', 'hamlet', 'priority', 'event', 'eventOn', today + 2));
  perform pg_temp.check((r -> 'item' ->> 'eventOn')::date = today + 5, 'kept from when it was set');
  -- A deadline earlier still wins.
  r := public.todo_upsert(jsonb_build_object('id', 'td_evday001', 'title', 'Hamlet shower', 'area', 'hamlet', 'priority', 'event', 'eventOn', today + 2, 'deadline', today + 1));
  perform pg_temp.check((r -> 'item' ->> 'dueOn')::date = today + 1, 'deadline first');
  -- A new area: the new day.
  r := public.todo_upsert(jsonb_build_object('id', 'td_evday001', 'title', 'Shower', 'area', 'amly-barn', 'priority', 'event', 'eventOn', today + 9));
  perform pg_temp.check((r -> 'item' ->> 'eventOn')::date = today + 9, 'area changed: new day');
  -- Another priority clears it.
  r := public.todo_upsert(jsonb_build_object('id', 'td_evday001', 'title', 'Shower', 'area', 'amly-barn', 'priority', 'week', 'eventOn', today + 9));
  perform pg_temp.check(r -> 'item' -> 'eventOn' = 'null'::jsonb and (r -> 'item' ->> 'dueOn')::date = today + 7, 'other priority: no event day');
  -- Back to event: the day sent now.
  r := public.todo_upsert(jsonb_build_object('id', 'td_evday001', 'title', 'Shower', 'area', 'amly-barn', 'priority', 'event', 'eventOn', today + 4));
  perform pg_temp.check((r -> 'item' ->> 'eventOn')::date = today + 4, 'event again: the new day');
  -- Nothing booked: no day; one sent later is taken.
  r := public.todo_upsert('{"id":"td_evday002","title":"Venue job","priority":"event"}');
  perform pg_temp.check(r -> 'item' -> 'eventOn' = 'null'::jsonb and r -> 'item' -> 'dueOn' = 'null'::jsonb, 'nothing booked: no day');
  r := public.todo_upsert(jsonb_build_object('id', 'td_evday002', 'title', 'Venue job', 'priority', 'event', 'eventOn', today + 20));
  perform pg_temp.check((r -> 'item' ->> 'eventOn')::date = today + 20, 'a day found later is taken');
  perform pg_temp.check(public.todo_upsert('{"id":"td_evday003","title":"x","priority":"event","eventOn":"soon"}') ->> 'error' = 'bad_deadline', 'bad day refused');
  -- The overdue sender sees it like any other.
  update todo_items set set_on = today - 3, event_on = today - 1, who = 'person:00000000-0000-0000-0000-0000000000a1' where id = 'td_evday002';
  r := public.todo_worker_overdue(today - 1, today);
  perform pg_temp.check(exists (select 1 from jsonb_array_elements(r) e where e ->> 'id' = 'td_evday002'), 'event to-do reaches the overdue WhatsApp');
  raise notice 'todo event day: all assertions passed';
end $t$;

-- ── Tags ──
do $t$
declare r jsonb; nid text; today date := (now() at time zone 'Europe/London')::date;
begin
  perform set_config('t.uid', '00000000-0000-0000-0000-0000000000a1', false);
  perform public.todo_save_list('category', '{"name":"Admin"}');
  perform public.todo_save_list('category', '{"name":"To buy"}');
  -- What 07c left as a category became a one-tag list.
  perform pg_temp.check((select tags from todo_items where id = 'td_cat00001') = array['farm-maintenance'], 'category copied into tags');
  r := public.todo_upsert('{"id":"td_tag00001","title":"Buy and file","tags":["admin","to-buy","admin"]}');
  perform pg_temp.check((r ->> 'ok')::boolean and r -> 'item' -> 'tags' = '["admin","to-buy"]'::jsonb or r -> 'item' -> 'tags' = '["to-buy","admin"]'::jsonb, 'two tags, once each: ' || r::text);
  perform pg_temp.check(r -> 'item' ->> 'category' in ('admin', 'to-buy'), 'category is the first tag');
  perform pg_temp.check(public.todo_upsert('{"id":"td_tag00002","title":"x","tags":["admin","nope"]}') ->> 'error' = 'bad_category', 'unknown tag refused');
  perform pg_temp.check(public.todo_upsert('{"id":"td_tag00002","title":"x","tags":"admin"}') ->> 'error' = 'bad_category', 'tags must be a list');
  -- An app of the 07c build sends category alone: one tag.
  r := public.todo_upsert('{"id":"td_tag00001","title":"Buy and file","category":"admin"}');
  perform pg_temp.check(r -> 'item' -> 'tags' = '["admin"]'::jsonb, 'category alone means one tag');
  -- Neither: kept.
  r := public.todo_upsert('{"id":"td_tag00001","title":"Buy and file, renamed"}');
  perform pg_temp.check(r -> 'item' -> 'tags' = '["admin"]'::jsonb, 'no tags sent: kept');
  r := public.todo_upsert('{"id":"td_tag00001","title":"Buy and file","tags":[]}');
  perform pg_temp.check(r -> 'item' -> 'tags' = '[]'::jsonb and r -> 'item' -> 'category' = 'null'::jsonb, 'cleared');
  r := public.todo_upsert('{"id":"td_tag00001","title":"Buy and file","tags":["admin","to-buy"]}');
  perform pg_temp.check((select (e ->> 'uses')::int from jsonb_array_elements(public.todo_get() -> 'categories') e where e ->> 'id' = 'to-buy') = 1, 'a tag''s uses counted');
  perform pg_temp.check(public.todo_delete_list('category', 'to-buy') ->> 'error' = 'in_use', 'a tag in use is not deleted');
  -- A repeat keeps its tags.
  r := public.todo_upsert('{"id":"td_tag00003","title":"Order oil","repeat":"monthly","priority":"eventually","tags":["admin","to-buy"]}');
  r := public.todo_set_state('td_tag00003', 'done', null);
  perform pg_temp.check(r -> 'next' -> 'tags' = r -> 'item' -> 'tags', 'the next one keeps its tags');
  raise notice 'todo tags: all assertions passed';
end $t$;

-- ── Areas ──
do $t$
declare r jsonb; today date := (now() at time zone 'Europe/London')::date;
begin
  perform set_config('t.uid', '00000000-0000-0000-0000-0000000000a1', false);
  perform pg_temp.check((select areas from todo_items where id = 'td_cat00001') = array['farm'], 'area copied into areas');
  r := public.todo_upsert('{"id":"td_area0001","title":"Fix both gates","areas":["hamlet","glamping","hamlet"]}');
  perform pg_temp.check(jsonb_array_length(r -> 'item' -> 'areas') = 2 and r -> 'item' ->> 'area' in ('hamlet', 'glamping'), 'two areas, once each: ' || r::text);
  perform pg_temp.check(public.todo_upsert('{"id":"td_area0002","title":"x","areas":["nope"]}') ->> 'error' = 'bad_area', 'unknown area refused');
  r := public.todo_upsert('{"id":"td_area0001","title":"Fix both gates","area":"farm"}');
  perform pg_temp.check(r -> 'item' -> 'areas' = '["farm"]'::jsonb, 'area alone (07c app) means one');
  r := public.todo_upsert('{"id":"td_area0001","title":"Fix the gates"}');
  perform pg_temp.check(r -> 'item' -> 'areas' = '["farm"]'::jsonb, 'neither sent: kept');
  r := public.todo_upsert('{"id":"td_area0001","title":"Fix the gates","areas":[]}');
  perform pg_temp.check(r -> 'item' -> 'areas' = '[]'::jsonb and r -> 'item' -> 'area' = 'null'::jsonb, 'cleared');
  -- The event day is kept while the areas stay the same, taken afresh when they change.
  r := public.todo_upsert(jsonb_build_object('id', 'td_area0003', 'title', 'Both', 'areas', '["hamlet","grain-store"]'::jsonb, 'priority', 'event', 'eventOn', today + 3));
  r := public.todo_upsert(jsonb_build_object('id', 'td_area0003', 'title', 'Both', 'areas', '["hamlet","grain-store"]'::jsonb, 'priority', 'event', 'eventOn', today + 1));
  perform pg_temp.check((r -> 'item' ->> 'eventOn')::date = today + 3, 'same areas: day kept');
  r := public.todo_upsert(jsonb_build_object('id', 'td_area0003', 'title', 'Both', 'areas', '["hamlet"]'::jsonb, 'priority', 'event', 'eventOn', today + 6));
  perform pg_temp.check((r -> 'item' ->> 'eventOn')::date = today + 6, 'areas changed: new day');
  perform pg_temp.check((select (e ->> 'uses')::int from jsonb_array_elements(public.todo_get() -> 'areas') e where e ->> 'id' = 'hamlet') >= 1, 'area uses counted');
  perform pg_temp.check(public.todo_delete_list('area', 'hamlet') ->> 'error' = 'in_use', 'an area in use is not deleted');
  raise notice 'todo areas: all assertions passed';
end $t$;
