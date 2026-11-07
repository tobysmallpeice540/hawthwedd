-- supabase/2026-11-07f-todo-repeat-day-test.sql — after the 07e sequence and its test:
--   psql -d tdtest -f supabase/2026-11-07f-todo-repeat-day.sql   (twice)
--   psql -d tdtest -f supabase/2026-11-07f-todo-repeat-day-test.sql
-- All passing prints "todo repeat day: all assertions passed".
\set ON_ERROR_STOP 1
create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as
  $$ begin if not coalesce(ok, false) then raise exception 'FAILED: %', what; end if; end $$;
do $t$
declare r jsonb; nid text; today date := (now() at time zone 'Europe/London')::date; wed date;
begin
  perform set_config('t.uid', '00000000-0000-0000-0000-0000000000a1', false);

  -- Monthly on the 31st: 28 Feb, then back to 31 Mar (it used to stay on the 28th).
  r := public.todo_upsert('{"id":"td_rpd00001","title":"Month end","repeat":"monthly","deadline":"2027-01-31"}');
  perform pg_temp.check(r -> 'item' ->> 'repeatFrom' = '2027-01-31', 'repeatFrom set when added: ' || r::text);
  r := public.todo_set_state('td_rpd00001', 'done', null);
  perform pg_temp.check(r -> 'next' ->> 'deadline' = '2027-02-28', 'the 31st → 28 Feb: ' || r::text);
  perform pg_temp.check(r -> 'next' ->> 'repeatFrom' = '2027-01-31', 'the next one keeps the 31st');
  nid := r -> 'next' ->> 'id';
  -- Editing only the title keeps the day; ticking the February one goes to 31 March.
  r := public.todo_upsert(jsonb_build_object('id', nid, 'title', 'Month end close', 'repeat', 'monthly', 'deadline', '2027-02-28'));
  perform pg_temp.check(r -> 'item' ->> 'repeatFrom' = '2027-01-31', 'a title edit keeps the 31st');
  r := public.todo_upsert(jsonb_build_object('id', nid, 'title', 'Month end close', 'deadline', '2027-02-28'));
  perform pg_temp.check(r -> 'item' ->> 'repeatFrom' = '2027-01-31', 'an older app (no repeat key) keeps it too');
  r := public.todo_set_state(nid, 'done', null);
  perform pg_temp.check(r -> 'next' ->> 'deadline' = '2027-03-31', '28 Feb → 31 Mar, no drift: ' || r::text);

  -- Monthly on the 30th: 28 Feb, then 30 Mar.
  r := public.todo_upsert('{"id":"td_rpd00002","title":"Payroll hours","repeat":"monthly","deadline":"2027-01-30"}');
  r := public.todo_set_state('td_rpd00002', 'done', null);
  perform pg_temp.check(r -> 'next' ->> 'deadline' = '2027-02-28', 'the 30th → 28 Feb');
  r := public.todo_set_state(r -> 'next' ->> 'id', 'done', null);
  perform pg_temp.check(r -> 'next' ->> 'deadline' = '2027-03-30', '28 Feb → 30 Mar');

  -- Changing the deadline moves the day it keeps.
  r := public.todo_upsert('{"id":"td_rpd00003","title":"Moved","repeat":"monthly","deadline":"2027-01-31"}');
  r := public.todo_upsert('{"id":"td_rpd00003","title":"Moved","repeat":"monthly","deadline":"2027-01-15"}');
  perform pg_temp.check(r -> 'item' ->> 'repeatFrom' = '2027-01-15', 'a new deadline is the new day');
  r := public.todo_set_state('td_rpd00003', 'done', null);
  perform pg_temp.check(r -> 'next' ->> 'deadline' = '2027-02-15', 'then the 15th');
  -- Switching repeat off clears it.
  r := public.todo_upsert('{"id":"td_rpd00004","title":"Off","repeat":"monthly","deadline":"2027-01-31"}');
  r := public.todo_upsert('{"id":"td_rpd00004","title":"Off","repeat":"","deadline":"2027-01-31"}');
  perform pg_temp.check(r -> 'item' ->> 'repeatFrom' is null, 'no repeat, no day');

  -- Weekly keeps the day of the week, done early or late.
  r := public.todo_upsert('{"id":"td_rpd00005","title":"Bins","repeat":"weekly","deadline":"2027-01-06"}');   -- a Wednesday
  r := public.todo_set_state('td_rpd00005', 'done', null);
  perform pg_temp.check(r -> 'next' ->> 'deadline' = '2027-01-13', 'weekly done early: the next Wednesday');
  r := public.todo_upsert('{"id":"td_rpd00006","title":"Bins late","repeat":"weekly","deadline":"2026-10-28"}');   -- a Wednesday, long gone
  r := public.todo_set_state('td_rpd00006', 'done', null);
  wed := today + ((3 - extract(isodow from today)::int + 7) % 7);
  if wed = today then wed := today + 7; end if;
  perform pg_temp.check(r -> 'next' ->> 'deadline' = wed::text, 'weekly done late: the first Wednesday after today: ' || r::text);
  perform pg_temp.check(extract(isodow from (r -> 'next' ->> 'deadline')::date) = 3, 'still a Wednesday');

  -- Unticking still takes the next one back.
  nid := r -> 'next' ->> 'id';
  perform pg_temp.check(exists (select 1 from todo_items where id = nid), 'the next one is there');
  r := public.todo_set_state('td_rpd00006', 'open', null);
  perform pg_temp.check(not exists (select 1 from todo_items where id = nid), 'untick takes it back');

  raise notice 'todo repeat day: all assertions passed';
end $t$;
