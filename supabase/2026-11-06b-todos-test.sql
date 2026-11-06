-- supabase/2026-11-06b-todos-test.sql
--
-- Assertions for 2026-11-06b-todos.sql. Run against a SCRATCH Postgres 16:
--
--   psql -d tdtest -f tests/contracts/standins.sql
--   psql -d tdtest -f tests/todos/standins.sql
--   psql -d tdtest -f tests/todos/seed-app-data.sql      (what the app had saved)
--   psql -d tdtest -f supabase/2026-11-06b-todos.sql
--   psql -d tdtest -f supabase/2026-11-06b-todos.sql     (a second run changes nothing)
--   psql -d tdtest -f supabase/2026-11-06b-todos-test.sql
--
-- auth.uid() reads t.uid. Each block raises on failure; all passing prints
-- "todos: all assertions passed".

\set ON_ERROR_STOP 1

delete from profiles;
insert into profiles (id, name, email, role, active) values
  ('00000000-0000-0000-0000-0000000000a1', 'Toby Smallpeice', 'toby@x', 'admin', true),
  ('00000000-0000-0000-0000-0000000000a2', 'Rosanna Greenwood', 'rosanna@x', 'admin', true),
  ('00000000-0000-0000-0000-0000000000b1', 'Bar', 'bar@x', 'bar', true),
  ('00000000-0000-0000-0000-0000000000c1', 'Karina', 'karina@x', 'cleaner', true),
  ('00000000-0000-0000-0000-0000000000d1', 'Gone', 'gone@x', 'admin', false);

create or replace function pg_temp.as_(p text) returns void language sql as
  $$ select set_config('t.uid', case p when 'T' then '00000000-0000-0000-0000-0000000000a1'
                                         when 'R' then '00000000-0000-0000-0000-0000000000a2'
                                         when 'B' then '00000000-0000-0000-0000-0000000000b1'
                                         when 'K' then '00000000-0000-0000-0000-0000000000c1'
                                         when 'X' then '00000000-0000-0000-0000-0000000000ff'
                                         else '' end, false) $$;
create or replace function pg_temp.sees(p_id text) returns boolean language sql as
  $$ select exists (select 1 from jsonb_array_elements(public.todo_get() -> 'items') e where e ->> 'id' = p_id) $$;
create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as
  $$ begin if not coalesce(ok, false) then raise exception 'FAILED: %', what; end if; end $$;

do $t$
declare
  r jsonb; today date := (now() at time zone 'Europe/London')::date;
  R_ text := 'person:00000000-0000-0000-0000-0000000000a2';
begin
  -- ── The copy from app_data, and running the migration twice ──
  perform pg_temp.check((select count(*) from todo_lists where kind = 'area') = 9, 'nine areas copied');
  perform pg_temp.check((select name from todo_lists where kind = 'area' and id = 'hamlet') = 'Hamlet', 'renamed area kept');
  perform pg_temp.check((select count(*) from todo_lists where kind = 'project') = 1, 'one project copied');
  perform pg_temp.check((select count(*) from todo_items) = 2, 'good to-dos copied, the broken ones skipped');
  perform pg_temp.check((select who from todo_items where id = 'td_nowho01') = 'anyone', 'a to-do saved with no who is for Everyone');
  perform pg_temp.check((select due_on from todo_items where id = 'td_copied1') = date '2026-11-13', 'copied due_on worked out');

  -- ── Not on staff ──
  perform pg_temp.as_('X');
  perform pg_temp.check(public.todo_get() ->> 'error' = 'not_staff', 'stranger refused');
  perform pg_temp.as_('');
  perform pg_temp.check(public.todo_get() ->> 'error' = 'not_staff', 'no session refused');

  -- ── Add, with what the database fills in ──
  perform pg_temp.as_('T');
  r := public.todo_upsert('{"id":"td_aaaaaa1","title":"  Fix the latch  ","who":"anyone","priority":"week","area":"wood-store"}');
  perform pg_temp.check((r ->> 'ok')::boolean, 'add: ' || r::text);
  perform pg_temp.check(r -> 'item' ->> 'title' = 'Fix the latch', 'title trimmed');
  perform pg_temp.check(r -> 'item' ->> 'createdBy' = 'Toby', 'writer labelled by the database');
  perform pg_temp.check(r -> 'item' ->> 'whoLabel' = 'Everyone', 'who labelled');
  perform pg_temp.check((r -> 'item' ->> 'dueOn')::date = today + 7, 'due in seven days');
  perform pg_temp.check((r -> 'item' ->> 'canEdit')::boolean, 'writer can edit');
  perform pg_temp.check(public.todo_upsert('{"id":"td_aaaaaa2","title":"x","area":"nowhere"}') ->> 'error' = 'bad_area', 'unknown area refused');
  perform pg_temp.check(public.todo_upsert('{"id":"bad id","title":"x"}') ->> 'error' = 'bad_id', 'bad id refused');
  perform pg_temp.check(public.todo_upsert('{"id":"td_aaaaaa2","title":"   "}') ->> 'error' = 'no_title', 'empty title refused');
  perform pg_temp.check(public.todo_upsert('{"id":"td_aaaaaa2","title":"x","priority":"soon"}') ->> 'error' = 'bad_priority', 'bad priority refused');
  perform pg_temp.check(public.todo_upsert('{"id":"td_aaaaaa2","title":"x","who":"person:00000000-0000-0000-0000-0000000000d1"}') ->> 'error' = 'bad_who', 'a login that left cannot be given one');
  perform pg_temp.check(public.todo_upsert('{"id":"td_aaaaaa2","title":"x","deadline":"Friday"}') ->> 'error' = 'bad_deadline', 'bad deadline refused');
  perform pg_temp.check(public.todo_upsert('{"id":"td_aaaaaa2","title":"x","photos":[{"path":"td_other1/a.jpg"}]}') ->> 'error' = 'bad_photos', 'another to-do''s photo refused');
  perform pg_temp.check(public.todo_upsert('{"id":"td_aaaaaa2","title":"x","photos":[{"path":"td_aaaaaa2/../a.jpg"}]}') ->> 'error' = 'bad_photos', 'path tricks refused');
  r := public.todo_upsert('{"id":"td_aaaaaa2","title":"With photo","photos":[{"path":"td_aaaaaa2/abc.jpg","name":"door.jpg","extra":"dropped"}]}');
  perform pg_temp.check(r -> 'item' -> 'photos' = '[{"path":"td_aaaaaa2/abc.jpg","name":"door.jpg"}]'::jsonb, 'photo kept, cleaned: ' || r::text);

  -- ── Priority restarts the count; the same priority keeps it; deadline wins when earlier ──
  update todo_items set set_on = today - 10 where id = 'td_aaaaaa1';
  r := public.todo_upsert('{"id":"td_aaaaaa1","title":"Fix the latch","priority":"week","area":"wood-store"}');
  perform pg_temp.check((r -> 'item' ->> 'setOn')::date = today - 10, 'same priority keeps its start');
  r := public.todo_upsert('{"id":"td_aaaaaa1","title":"Fix the latch","priority":"month","area":"wood-store"}');
  perform pg_temp.check((r -> 'item' ->> 'setOn')::date = today and (r -> 'item' ->> 'dueOn')::date = today + 28, 'new priority starts again');
  r := public.todo_upsert(jsonb_build_object('id', 'td_aaaaaa1', 'title', 'Fix the latch', 'priority', 'month', 'deadline', today + 3));
  perform pg_temp.check((r -> 'item' ->> 'dueOn')::date = today + 3, 'earlier deadline wins');
  r := public.todo_upsert(jsonb_build_object('id', 'td_aaaaaa1', 'title', 'Fix the latch', 'priority', 'eventually', 'deadline', null));
  perform pg_temp.check(r -> 'item' ->> 'dueOn' is null, 'eventually, no deadline: no due day');

  -- ── Private to-dos ──
  perform public.todo_upsert('{"id":"td_private1","title":"Toby only","who":"role:admin","private":true}');
  perform public.todo_upsert(jsonb_build_object('id', 'td_private2', 'title', 'For Rosanna, privately', 'who', R_, 'private', true));
  perform pg_temp.as_('R');
  perform pg_temp.check(not pg_temp.sees('td_private1'), 'another office login cannot see a private to-do');
  perform pg_temp.check(pg_temp.sees('td_private2'), 'the person it is for can');
  perform pg_temp.check(public.todo_upsert('{"id":"td_private1","title":"taken over"}') ->> 'error' = 'not_found', 'cannot overwrite a private one');
  perform pg_temp.check(public.todo_set_state('td_private1', 'done') ->> 'error' = 'not_found', 'cannot tick a private one');
  perform pg_temp.check(public.todo_delete('td_private1') ->> 'error' = 'not_found', 'cannot delete a private one');
  perform pg_temp.check(not public.todo_photo_can_see('td_private1/a.jpg'), 'cannot see its photos');
  perform pg_temp.check(not public.todo_photo_can_change('td_private1/a.jpg'), 'cannot put photos on it');
  perform pg_temp.as_('T');
  perform pg_temp.check(public.todo_photo_can_see('td_private1/a.jpg'), 'its writer can see its photos');

  -- ── Private projects ──
  r := public.todo_save_list('project', '{"name":"Personal admin","private":true}');
  perform pg_temp.check(r -> 'list' ->> 'id' = 'personal-admin' and (r -> 'list' ->> 'private')::boolean and (r -> 'list' ->> 'mine')::boolean, 'private project: ' || r::text);
  perform public.todo_upsert('{"id":"td_inproj1","title":"Pension forms","who":"anyone","project":"personal-admin"}');
  perform pg_temp.as_('R');
  perform pg_temp.check(not exists (select 1 from jsonb_array_elements(public.todo_get() -> 'projects') e where e ->> 'id' = 'personal-admin'), 'private project hidden');
  perform pg_temp.check(not pg_temp.sees('td_inproj1'), 'everything in it hidden, even for Everyone');
  perform pg_temp.check(public.todo_upsert('{"id":"td_rosa001","title":"Sneak in","project":"personal-admin"}') ->> 'error' = 'bad_project', 'cannot file into it');
  perform pg_temp.check(public.todo_save_list('project', '{"id":"personal-admin","name":"Mine now"}') ->> 'error' = 'not_found', 'cannot rename it');
  perform pg_temp.check(public.todo_delete_list('project', 'personal-admin') ->> 'error' = 'not_found', 'cannot delete it');
  perform pg_temp.as_('K');
  perform pg_temp.check(not pg_temp.sees('td_inproj1'), 'housekeeping cannot see it either');
  perform pg_temp.as_('T');
  r := public.todo_save_list('project', '{"name":"Cinema refit"}');
  perform pg_temp.check(r -> 'list' ->> 'id' = 'cinema-refit-2', 'slug does not clash with the copied project');
  perform pg_temp.as_('R');
  perform pg_temp.check(public.todo_save_list('project', '{"id":"cinema-refit-2","private":true}') ->> 'error' = 'not_your_project', 'only the owner makes it private');
  perform pg_temp.check((public.todo_save_list('project', '{"id":"cinema-refit-2","name":"Cinema refit 2"}') ->> 'ok')::boolean, 'office may rename a public one');
  perform pg_temp.as_('T');
  perform pg_temp.check((public.todo_save_list('project', '{"id":"personal-admin","private":false}') ->> 'ok')::boolean, 'owner opens it up');
  perform pg_temp.as_('R');
  perform pg_temp.check(pg_temp.sees('td_inproj1'), 'now everyone sees what is in it');
  perform pg_temp.as_('T');
  perform public.todo_save_list('project', '{"id":"personal-admin","private":true}');

  -- ── Areas and projects: the office's; in use = not deleted; areas never private ──
  perform pg_temp.check(public.todo_save_list('area', '{"name":"Workshop","private":true}') ->> 'error' = 'areas_are_shared', 'no private areas');
  perform public.todo_upsert('{"id":"td_area0001","title":"In the wood store","area":"wood-store"}');
  perform pg_temp.check(public.todo_delete_list('area', 'wood-store') ->> 'error' = 'in_use', 'area in use not deleted');
  perform pg_temp.check((public.todo_delete_list('area', 'old-brewery') ->> 'ok')::boolean, 'unused area deleted');
  perform pg_temp.check(public.todo_save_list('area', '{"id":"old-brewery","name":"Back"}') ->> 'error' = 'not_found', 'a deleted one is not brought back by a late rename');
  perform pg_temp.as_('K');
  perform pg_temp.check(public.todo_save_list('area', '{"name":"Laundry"}') ->> 'error' = 'office_only', 'housekeeping cannot add areas');

  -- ── The bar and housekeeping logins ──
  perform pg_temp.as_('T');
  perform public.todo_upsert('{"id":"td_bar00001","title":"Ice machine","who":"role:bar"}');
  perform public.todo_upsert('{"id":"td_off00001","title":"Office only","who":"role:admin"}');
  perform pg_temp.as_('B');
  perform pg_temp.check(pg_temp.sees('td_bar00001') and pg_temp.sees('td_aaaaaa1'), 'bar sees its own group and Everyone');
  perform pg_temp.check(not pg_temp.sees('td_off00001'), 'bar does not see the office''s');
  perform pg_temp.as_('K');
  r := public.todo_upsert('{"id":"td_kar00001","title":"Shower dripping","who":"role:admin"}');
  perform pg_temp.check((r ->> 'ok')::boolean and r -> 'item' ->> 'createdBy' = 'Housekeeping', 'housekeeping reports to the office');
  perform pg_temp.check(pg_temp.sees('td_kar00001'), 'and sees what it wrote');
  perform pg_temp.check(public.todo_upsert('{"id":"td_aaaaaa1","title":"Changed by K"}') ->> 'error' = 'not_yours', 'cannot change the office''s');
  perform pg_temp.check(public.todo_delete('td_aaaaaa1') ->> 'error' = 'not_yours', 'cannot delete the office''s');
  perform pg_temp.check(not public.todo_photo_can_change('td_aaaaaa1/a.jpg'), 'cannot put photos on the office''s');
  perform pg_temp.check(public.todo_photo_can_change('td_notyet01/a.jpg'), 'may put up photos for a to-do not yet saved');
  r := public.todo_set_state('td_aaaaaa1', 'done');
  perform pg_temp.check(r -> 'item' ->> 'state' = 'done' and r -> 'item' ->> 'doneBy' = 'Housekeeping', 'housekeeping ticks: ' || r::text);
  perform pg_temp.check(public.todo_set_state('td_aaaaaa1', 'note') ->> 'error' = 'comment_needed', 'comment needed');
  perform pg_temp.as_('R');
  perform pg_temp.check((public.todo_set_state('td_aaaaaa1', 'open') ->> 'ok')::boolean, 'the office may untick anyone''s');
  perform pg_temp.as_('T');
  perform public.todo_set_state('td_aaaaaa1', 'na', 'Not needed');
  perform pg_temp.as_('K');
  perform pg_temp.check(public.todo_set_state('td_aaaaaa1', 'open') ->> 'error' = 'not_your_tick', 'housekeeping cannot untick another''s tick');
  perform pg_temp.as_('T');
  r := public.todo_set_state('td_aaaaaa1', 'note', 'New latch fitted');
  perform pg_temp.check(r -> 'item' ->> 'comment' = 'New latch fitted', 'done with a comment');
  r := public.todo_set_state('td_aaaaaa1', 'open');
  perform pg_temp.check(r -> 'item' ->> 'comment' is null and r -> 'item' ->> 'doneBy' is null, 'untick clears it');

  -- ── The WhatsApp sender's list ──
  perform public.todo_upsert(jsonb_build_object('id', 'td_late0001', 'title', 'Due yesterday', 'who', R_, 'priority', 'day'));
  update todo_items set set_on = today - 2 where id = 'td_late0001';            -- due yesterday
  perform public.todo_upsert(jsonb_build_object('id', 'td_late0002', 'title', 'Long overdue', 'who', R_, 'priority', 'day'));
  update todo_items set set_on = today - 9 where id = 'td_late0002';            -- due a week ago
  perform public.todo_upsert(jsonb_build_object('id', 'td_late0003', 'title', 'Hidden from her', 'who', R_, 'priority', 'day', 'project', 'personal-admin'));
  update todo_items set set_on = today - 2 where id = 'td_late0003';
  perform public.todo_upsert(jsonb_build_object('id', 'td_late0004', 'title', 'Group one', 'who', 'role:admin', 'priority', 'day'));
  update todo_items set set_on = today - 2 where id = 'td_late0004';
  r := public.todo_worker_overdue(today - 1, today);
  perform pg_temp.check(jsonb_array_length(r) = 1 and r -> 0 ->> 'id' = 'td_late0001', 'only the named, visible, newly overdue one: ' || r::text);

  -- ── Deleting hands back the photos ──
  r := public.todo_delete('td_aaaaaa2');
  perform pg_temp.check(r -> 'photos' -> 0 ->> 'path' = 'td_aaaaaa2/abc.jpg', 'photos returned for taking down');

  -- ── Nothing open to the API ──
  perform pg_temp.check(not has_table_privilege('authenticated', 'public.todo_items', 'select'), 'table closed to signed-in clients');
  perform pg_temp.check(not has_table_privilege('anon', 'public.todo_lists', 'select'), 'table closed to anon');
  perform pg_temp.check(not has_function_privilege('anon', 'public.todo_get()', 'execute'), 'anon cannot read');
  perform pg_temp.check(has_function_privilege('authenticated', 'public.todo_get()', 'execute'), 'signed in can call');
  perform pg_temp.check(not has_function_privilege('authenticated', 'public.todo_worker_overdue(date, date)', 'execute'), 'worker list is service only');
  perform pg_temp.check(not has_function_privilege('authenticated', 'public.todo_visible(public.todo_items, uuid, text)', 'execute'), 'rules not callable directly');

  raise notice 'todos: all assertions passed';
end $t$;
