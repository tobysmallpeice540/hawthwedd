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
