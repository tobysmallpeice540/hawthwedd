-- supabase/2026-11-07c-todo-board-test.sql
--
-- Assertions for 2026-11-07c-todo-board.sql. Run against a SCRATCH Postgres 16,
-- after the 6 Nov migration and its own test (which leaves to-dos behind,
-- among them one at the old "1 day" priority):
--
--   psql -d tdtest -f tests/contracts/standins.sql
--   psql -d tdtest -f tests/todos/standins.sql
--   psql -d tdtest -f tests/todos/seed-app-data.sql
--   psql -d tdtest -f supabase/2026-11-06b-todos.sql
--   psql -d tdtest -f supabase/2026-11-06b-todos-test.sql
--   psql -d tdtest -f supabase/2026-11-07c-todo-board.sql
--   psql -d tdtest -f supabase/2026-11-07c-todo-board.sql   (a second run changes nothing)
--   psql -d tdtest -f supabase/2026-11-07c-todo-board-test.sql
--
-- All passing prints "todo board: all assertions passed".

\set ON_ERROR_STOP 1

create or replace function pg_temp.as_(p text) returns void language sql as
  $$ select set_config('t.uid', case p when 'T' then '00000000-0000-0000-0000-0000000000a1'
                                         when 'R' then '00000000-0000-0000-0000-0000000000a2'
                                         when 'B' then '00000000-0000-0000-0000-0000000000b1'
                                         else '' end, false) $$;
create or replace function pg_temp.sees(p_id text) returns boolean language sql as
  $$ select exists (select 1 from jsonb_array_elements(public.todo_get() -> 'items') e where e ->> 'id' = p_id) $$;
create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as
  $$ begin if not coalesce(ok, false) then raise exception 'FAILED: %', what; end if; end $$;

do $t$
declare
  r jsonb; r2 jsonb; today date := (now() at time zone 'Europe/London')::date; nid text; n2 text;
begin
  -- ── What the migration did to what was there ──
  perform pg_temp.check((select count(*) from todo_lists where kind = 'area' and id = 'farm' and name = 'Farm') = 1, 'Farm area added');
  perform pg_temp.check((select count(*) from todo_lists where kind = 'area' and id = 'farm') = 1, 'Farm added once, however often it runs');
  perform pg_temp.check(not exists (select 1 from todo_items where priority = 'day'), 'no 1-day priorities left');
  perform pg_temp.check((select priority from todo_items where id = 'td_late0004') = 'three', '1 day became 3 days');
  perform pg_temp.check((select due_on = set_on + 3 from todo_items where id = 'td_late0004'), '3 days counted from the day it was set');
  perform pg_temp.check((select due_on from todo_items where id = 'td_copied1') = date '2026-11-13', 'other due days unchanged');

  -- ── todo_next_on ──
  perform pg_temp.check(public.todo_next_on(date '2026-11-04', 'weekly', date '2026-11-03') = date '2026-11-11', 'weekly done early: a week on');
  perform pg_temp.check(public.todo_next_on(date '2026-11-04', 'weekly', date '2026-11-20') = date '2026-11-25', 'weekly done late: the next one after today');
  perform pg_temp.check(public.todo_next_on(date '2026-11-06', 'weekdays', date '2026-11-06') = date '2026-11-09', 'weekdays: Friday to Monday');
  perform pg_temp.check(public.todo_next_on(date '2026-01-31', 'monthly', date '2026-01-31') = date '2026-02-28', 'monthly: the 31st to the end of February');
  perform pg_temp.check(public.todo_next_on(date '2026-01-31', 'monthly', date '2026-03-01') = date '2026-03-31', 'monthly: back to the 31st, no drift');
  perform pg_temp.check(public.todo_next_on(date '2020-01-01', 'daily', date '2026-11-07') = date '2026-11-08', 'daily, long overdue: tomorrow');
  perform pg_temp.check(public.todo_next_on(date '2026-11-07', 'yearly', date '2026-11-07') = date '2027-11-07', 'yearly');
  perform pg_temp.check(public.todo_next_on(date '2026-11-07', 'fortnightly', date '2026-11-07') is null, 'unknown rule: nothing');

  -- ── Categories: the office's, shared, never private ──
  perform pg_temp.as_('T');
  r := public.todo_save_list('category', '{"name":"Farm Maintenance"}');
  perform pg_temp.check((r ->> 'ok')::boolean and r -> 'list' ->> 'id' = 'farm-maintenance', 'category added: ' || r::text);
  perform pg_temp.check(public.todo_save_list('category', '{"name":"Secret","private":true}') ->> 'error' = 'areas_are_shared', 'a category cannot be private');
  perform pg_temp.check(public.todo_save_list('colour', '{"name":"Red"}') ->> 'error' = 'bad_kind', 'unknown kind refused');
  perform pg_temp.as_('B');
  perform pg_temp.check(public.todo_save_list('category', '{"name":"Bar jobs"}') ->> 'error' = 'office_only', 'bar cannot add categories');
  perform pg_temp.check(jsonb_array_length(public.todo_get() -> 'categories') = 1, 'everyone sees the categories');

  perform pg_temp.as_('T');
  r := public.todo_upsert('{"id":"td_cat00001","title":"Mend the gutter","category":"farm-maintenance","area":"farm","priority":"day"}');
  perform pg_temp.check((r ->> 'ok')::boolean, 'to-do with a category: ' || r::text);
  perform pg_temp.check(r -> 'item' ->> 'category' = 'farm-maintenance', 'category returned');
  perform pg_temp.check(r -> 'item' ->> 'priority' = 'three' and (r -> 'item' ->> 'dueOn')::date = today + 3, 'an old tab''s "day" is saved as 3 days');
  perform pg_temp.check(public.todo_upsert('{"id":"td_cat00002","title":"x","category":"nope"}') ->> 'error' = 'bad_category', 'unknown category refused');
  r := public.todo_upsert('{"id":"td_cat00002","title":"No lists at all"}');
  perform pg_temp.check((r ->> 'ok')::boolean and r -> 'item' -> 'category' = 'null'::jsonb and r -> 'item' -> 'area' = 'null'::jsonb
                        and r -> 'item' -> 'project' = 'null'::jsonb, 'a to-do needs no category, project or area');
  perform pg_temp.check((select (e ->> 'uses')::int from jsonb_array_elements(public.todo_get() -> 'categories') e where e ->> 'id' = 'farm-maintenance') = 1, 'category uses counted');
  perform pg_temp.check(public.todo_delete_list('category', 'farm-maintenance') ->> 'error' = 'in_use', 'a category in use is not deleted');
  r := public.todo_save_list('category', '{"id":"farm-maintenance","name":"Maintenance"}');
  perform pg_temp.check(r -> 'list' ->> 'name' = 'Maintenance', 'category renamed');
  perform public.todo_save_list('category', '{"name":"Spare"}');
  perform pg_temp.check((public.todo_delete_list('category', 'spare') ->> 'ok')::boolean, 'an unused category is deleted');

  -- An older app, which sends no category or repeat, keeps both.
  perform public.todo_upsert('{"id":"td_old00001","title":"Old app","category":"farm-maintenance","repeat":"weekly","priority":"eventually","deadline":"2026-12-01"}');
  r := public.todo_upsert('{"id":"td_old00001","title":"Old app, renamed","priority":"eventually","deadline":"2026-12-01"}');
  perform pg_temp.check(r -> 'item' ->> 'category' = 'farm-maintenance' and r -> 'item' ->> 'repeat' = 'weekly', 'an older app keeps category and repeat: ' || r::text);
  r := public.todo_upsert('{"id":"td_old00001","title":"Old app","category":null,"repeat":null,"priority":"eventually"}');
  perform pg_temp.check(r -> 'item' -> 'category' = 'null'::jsonb and r -> 'item' -> 'repeat' = 'null'::jsonb, 'a new app can clear them');
  perform public.todo_delete('td_old00001');

  -- ── Before next event: no due day from the database, unless a deadline ──
  r := public.todo_upsert('{"id":"td_evt00001","title":"Fix the Hamlet shower","area":"hamlet","priority":"event"}');
  perform pg_temp.check(r -> 'item' ->> 'priority' = 'event' and r -> 'item' -> 'dueOn' = 'null'::jsonb, 'event priority: the app works out the day');
  r := public.todo_upsert(jsonb_build_object('id', 'td_evt00001', 'title', 'Fix the Hamlet shower', 'area', 'hamlet', 'priority', 'event', 'deadline', today + 2));
  perform pg_temp.check((r -> 'item' ->> 'dueOn')::date = today + 2, 'event priority with a deadline: the deadline');

  -- ── Repeats ──
  perform pg_temp.check(public.todo_upsert('{"id":"td_rep00009","title":"x","repeat":"hourly"}') ->> 'error' = 'bad_repeat', 'unknown repeat refused');
  r := public.todo_upsert('{"id":"td_rep00002","title":"Read the meters","repeat":"monthly","priority":"eventually"}');
  perform pg_temp.check((r -> 'item' ->> 'deadline')::date = today and r -> 'item' ->> 'repeat' = 'monthly', 'a repeat with no day is due today');

  r := public.todo_upsert(jsonb_build_object('id', 'td_rep00001', 'title', 'Bins out', 'repeat', 'weekly', 'priority', 'eventually',
                                             'category', 'farm-maintenance', 'area', 'farm', 'who', 'person:00000000-0000-0000-0000-0000000000a2',
                                             'deadline', today - 1));
  perform pg_temp.check((r ->> 'ok')::boolean, 'weekly repeat added: ' || r::text);
  perform pg_temp.as_('R');
  r := public.todo_set_state('td_rep00001', 'done', null);
  perform pg_temp.check(r -> 'item' ->> 'state' = 'done', 'ticked');
  perform pg_temp.check(r -> 'next' is not null and r -> 'next' ->> 'state' = 'open', 'the next one came back with it: ' || r::text);
  nid := r -> 'next' ->> 'id';
  perform pg_temp.check(nid ~ '^td_[0-9a-f]{32}$', 'the next one has an id of its own');
  perform pg_temp.check((r -> 'next' ->> 'deadline')::date = today + 6, 'due a week on from the last due day');
  perform pg_temp.check(r -> 'next' ->> 'title' = 'Bins out' and r -> 'next' ->> 'category' = 'farm-maintenance' and r -> 'next' ->> 'area' = 'farm'
                        and r -> 'next' ->> 'who' = 'person:00000000-0000-0000-0000-0000000000a2' and r -> 'next' ->> 'repeat' = 'weekly', 'copied across');
  perform pg_temp.check((select created_by_id from todo_items where id = nid) = '00000000-0000-0000-0000-0000000000a1', 'still the writer''s');
  perform pg_temp.check(pg_temp.sees(nid), 'the person it is for sees the next one');
  -- Ticking it twice makes no second one.
  r := public.todo_set_state('td_rep00001', 'note', 'Both bins');
  perform pg_temp.check(r -> 'next' = 'null'::jsonb, 're-ticking makes no second copy');
  perform pg_temp.check((select count(*) from todo_items where title = 'Bins out') = 2, 'two in all');
  -- Unticking takes the untouched next one back.
  r := public.todo_set_state('td_rep00001', 'open', null);
  perform pg_temp.check(r -> 'item' ->> 'state' = 'open' and not exists (select 1 from todo_items where id = nid), 'untick took the next one back');
  -- Not applicable moves it on too; a changed next one is kept on untick.
  r := public.todo_set_state('td_rep00001', 'na', null);
  n2 := r -> 'next' ->> 'id';
  perform pg_temp.check(n2 is not null and n2 <> nid, 'not applicable also leaves the next one');
  perform pg_temp.as_('T');
  perform public.todo_upsert(jsonb_build_object('id', n2, 'title', 'Bins out (and recycling)', 'repeat', 'weekly', 'priority', 'eventually',
                                                'deadline', today + 6, 'who', 'person:00000000-0000-0000-0000-0000000000a2'));
  -- (One transaction here; in use, a change comes in a later one, with a later now().)
  update todo_items set updated_at = updated_at + interval '1 second' where id = n2;
  r := public.todo_set_state('td_rep00001', 'open', null);
  perform pg_temp.check(exists (select 1 from todo_items where id = n2), 'a next one somebody changed is kept');

  -- A private repeat stays private.
  r := public.todo_upsert(jsonb_build_object('id', 'td_rep00003', 'title', 'Pay the sheep man', 'repeat', 'monthly', 'priority', 'eventually',
                                             'private', true, 'deadline', today));
  r := public.todo_set_state('td_rep00003', 'done', null);
  nid := r -> 'next' ->> 'id';
  perform pg_temp.check((select private from todo_items where id = nid), 'the next one is private too');
  perform pg_temp.as_('R');
  perform pg_temp.check(not pg_temp.sees(nid), 'and nobody else sees it');

  -- A plain to-do leaves nothing behind.
  perform pg_temp.as_('T');
  r := public.todo_set_state('td_cat00002', 'done', null);
  perform pg_temp.check(r -> 'next' = 'null'::jsonb, 'no repeat, no next one');

  -- ── Grants ──
  perform pg_temp.check(not has_function_privilege('authenticated', 'public.todo_next_on(date, text, date)', 'execute'), 'todo_next_on is internal');
  perform pg_temp.check(not has_function_privilege('anon', 'public.todo_next_on(date, text, date)', 'execute'), 'and closed to anon');
  perform pg_temp.check(has_function_privilege('authenticated', 'public.todo_upsert(jsonb)', 'execute'), 'upsert still callable');
  perform pg_temp.check(not has_function_privilege('anon', 'public.todo_upsert(jsonb)', 'execute'), 'and still not by anon');

  raise notice 'todo board: all assertions passed';
end $t$;
