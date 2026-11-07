-- supabase/2026-11-07e-todo-urgent-test.sql — after the 07d sequence and its test:
--   psql -d tdtest -f supabase/2026-11-07e-todo-urgent.sql   (twice)
--   psql -d tdtest -f supabase/2026-11-07e-todo-urgent-test.sql
-- All passing prints "todo urgent: all assertions passed".
\set ON_ERROR_STOP 1
create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as
  $$ begin if not coalesce(ok, false) then raise exception 'FAILED: %', what; end if; end $$;
do $t$
declare r jsonb; today date := (now() at time zone 'Europe/London')::date;
begin
  perform set_config('t.uid', '00000000-0000-0000-0000-0000000000a1', false);
  r := public.todo_upsert('{"id":"td_urg00001","title":"Gas safety certificate","urgent":true}');
  perform pg_temp.check((r -> 'item' ->> 'urgent')::boolean, 'starred when added: ' || r::text);
  r := public.todo_upsert('{"id":"td_urg00001","title":"Gas safety certificate, Hamlet"}');
  perform pg_temp.check((r -> 'item' ->> 'urgent')::boolean, 'an older app (no urgent sent) keeps the star');
  r := public.todo_upsert('{"id":"td_urg00001","title":"Gas safety certificate","urgent":false}');
  perform pg_temp.check(not (r -> 'item' ->> 'urgent')::boolean, 'unstarred by the sheet');
  r := public.todo_set_urgent('td_urg00001', true);
  perform pg_temp.check((r ->> 'ok')::boolean and (r -> 'item' ->> 'urgent')::boolean, 'starred from the card');
  perform pg_temp.check(public.todo_set_urgent('td_nope0000', true) ->> 'error' = 'not_found', 'unknown to-do');
  -- Someone who may see but not change it cannot star it.
  perform set_config('t.uid', '00000000-0000-0000-0000-0000000000b1', false);   -- the bar login
  perform public.todo_upsert('{"id":"td_urg00002","title":"Bar one","who":"role:bar"}');
  perform set_config('t.uid', '00000000-0000-0000-0000-0000000000a1', false);
  perform public.todo_upsert('{"id":"td_urg00003","title":"For the bar","who":"role:bar"}');
  perform set_config('t.uid', '00000000-0000-0000-0000-0000000000b1', false);
  perform pg_temp.check(public.todo_set_urgent('td_urg00003', true) ->> 'error' = 'not_yours', 'bar cannot star the office''s');
  perform pg_temp.check((public.todo_set_urgent('td_urg00002', true) ->> 'ok')::boolean, 'bar can star its own');
  -- A repeat's next one keeps the star.
  perform set_config('t.uid', '00000000-0000-0000-0000-0000000000a1', false);
  perform public.todo_upsert('{"id":"td_urg00004","title":"Fire alarm test","repeat":"weekly","priority":"eventually","urgent":true}');
  r := public.todo_set_state('td_urg00004', 'done', null);
  perform pg_temp.check((r -> 'next' ->> 'urgent')::boolean, 'next repeat keeps the star');
  -- The overdue worker says which are urgent.
  update todo_items set who = 'person:00000000-0000-0000-0000-0000000000a1', set_on = today - 8, priority = 'week' where id = 'td_urg00001';
  r := public.todo_worker_overdue(today - 1, today);
  perform pg_temp.check(exists (select 1 from jsonb_array_elements(r) e where e ->> 'id' = 'td_urg00001' and (e ->> 'urgent')::boolean), 'worker marks urgent: ' || r::text);
  perform pg_temp.check(not has_function_privilege('anon', 'public.todo_set_urgent(text, boolean)', 'execute'), 'not for anon');
  perform pg_temp.check(has_function_privilege('authenticated', 'public.todo_set_urgent(text, boolean)', 'execute'), 'for staff');
  raise notice 'todo urgent: all assertions passed';
end $t$;
