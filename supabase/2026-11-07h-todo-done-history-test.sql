-- supabase/2026-11-07h-todo-done-history-test.sql — after the to-do sequence (06b … 07g):
--   psql -d tdtest -f supabase/2026-11-07h-todo-done-history.sql   (twice)
--   psql -d tdtest -f supabase/2026-11-07h-todo-done-history-test.sql
-- All passing prints "todo done history: all assertions passed". Rolled back,
-- so it can be run again.
\set ON_ERROR_STOP 1
begin;
create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as
  $$ begin if not coalesce(ok, false) then raise exception 'FAILED: %', what; end if; end $$;
create or replace function pg_temp.ids(r jsonb) returns text language sql as
  $$ select coalesce(string_agg(x ->> 'id', ',' order by n), '') from jsonb_array_elements(r -> 'items') with ordinality e(x, n) $$;
do $t$
declare r jsonb; toby text := '00000000-0000-0000-0000-0000000000a1'; ros text := '00000000-0000-0000-0000-0000000000a2';
begin
  delete from todo_items;
  perform set_config('t.uid', toby, true);
  -- Last winter's jobs, a recent one, an open one, and a private one of Rosanna's.
  perform public.todo_upsert('{"id":"td_hist0001","title":"Lag the Hamlet pipes","who":"person:00000000-0000-0000-0000-0000000000a1"}');
  perform public.todo_upsert('{"id":"td_hist0002","title":"Clear the gutters","who":"person:00000000-0000-0000-0000-0000000000a1"}');
  perform public.todo_upsert('{"id":"td_hist0003","title":"Service the boiler","who":"person:00000000-0000-0000-0000-0000000000a1"}');
  perform public.todo_upsert('{"id":"td_hist0004","title":"Still to do"}');
  perform public.todo_set_state('td_hist0001', 'done', null);
  perform public.todo_set_state('td_hist0002', 'note', 'Used the long ladder');
  perform public.todo_set_state('td_hist0003', 'na', null);
  update todo_items set done_at = now() - interval '300 days' where id = 'td_hist0001';
  update todo_items set done_at = now() - interval '200 days' where id = 'td_hist0002';
  update todo_items set done_at = now() - interval '2 days' where id = 'td_hist0003';
  perform set_config('t.uid', ros, true);
  perform public.todo_upsert(jsonb_build_object('id', 'td_hist0005', 'title', 'Rosanna private', 'private', true));
  perform public.todo_set_state('td_hist0005', 'done', null);
  update todo_items set done_at = now() - interval '100 days' where id = 'td_hist0005';

  -- todo_get still sends only the last 45 days of done ones …
  perform set_config('t.uid', toby, true);
  r := public.todo_get();
  perform pg_temp.check(not exists (select 1 from jsonb_array_elements(r -> 'items') x where x ->> 'id' in ('td_hist0001', 'td_hist0002')), 'todo_get: old done ones not sent');
  -- … and todo_done_list sends them all, newest first, never an open one.
  r := public.todo_done_list(null, null);
  perform pg_temp.check((r ->> 'ok')::boolean and pg_temp.ids(r) = 'td_hist0003,td_hist0002,td_hist0001', 'all done, newest first: ' || pg_temp.ids(r));
  perform pg_temp.check(not (r ->> 'more')::boolean, 'no more');
  perform pg_temp.check((select x ->> 'comment' from jsonb_array_elements(r -> 'items') x where x ->> 'id' = 'td_hist0002') = 'Used the long ladder', 'the note comes back');
  -- Rosanna's private one is hers alone.
  perform pg_temp.check(position('td_hist0005' in pg_temp.ids(r)) = 0, 'someone else''s private one never sent');
  perform set_config('t.uid', ros, true);
  perform pg_temp.check(position('td_hist0005' in pg_temp.ids(public.todo_done_list(null, null))) > 0, 'Rosanna sees her own');

  -- Pages.
  perform set_config('t.uid', toby, true);
  r := public.todo_done_list(null, 2);
  perform pg_temp.check(pg_temp.ids(r) = 'td_hist0003,td_hist0002' and (r ->> 'more')::boolean, 'first page of two, more to come');
  r := public.todo_done_list((select done_at from todo_items where id = 'td_hist0002'), 2);
  perform pg_temp.check(pg_temp.ids(r) = 'td_hist0001' and not (r ->> 'more')::boolean, 'older page');

  -- The bar login sees only what it may.
  perform set_config('t.uid', '00000000-0000-0000-0000-0000000000b1', true);
  perform pg_temp.check(pg_temp.ids(public.todo_done_list(null, null)) = '', 'bar sees none of the office''s');
  perform set_config('t.uid', '00000000-0000-0000-0000-0000000000ff', true);
  perform pg_temp.check(public.todo_done_list(null, null) ->> 'error' = 'not_staff', 'not staff');

  perform pg_temp.check(not has_function_privilege('anon', 'public.todo_done_list(timestamptz, integer)', 'execute'), 'anon cannot');
  perform pg_temp.check(has_function_privilege('authenticated', 'public.todo_done_list(timestamptz, integer)', 'execute'), 'staff can call it');
  raise notice 'todo done history: all assertions passed';
end $t$;
rollback;
