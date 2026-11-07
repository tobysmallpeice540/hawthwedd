-- supabase/2026-11-07g-todo-list-order-test.sql — after the to-do sequence (06b … 07f):
--   psql -d tdtest -f supabase/2026-11-07g-todo-list-order.sql   (twice)
--   psql -d tdtest -f supabase/2026-11-07g-todo-list-order-test.sql
-- All passing prints "todo list order: all assertions passed". Runs in a
-- transaction that is rolled back, so it can be run again.
\set ON_ERROR_STOP 1
begin;
create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as
  $$ begin if not coalesce(ok, false) then raise exception 'FAILED: %', what; end if; end $$;
create or replace function pg_temp.names(p_kind text, p_uid text) returns text language plpgsql as $$
declare r jsonb; f text := case p_kind when 'area' then 'areas' when 'category' then 'categories' else 'projects' end;
begin
  perform set_config('t.uid', p_uid, true);
  r := public.todo_get();
  return (select string_agg(x ->> 'id', ',' order by n) from jsonb_array_elements(r -> f) with ordinality e(x, n));
end $$;
do $t$
declare r jsonb; ids text[]; toby text := '00000000-0000-0000-0000-0000000000a1'; ros text := '00000000-0000-0000-0000-0000000000a2';
begin
  delete from todo_lists where kind = 'project';
  insert into todo_lists (kind, id, name, position, private, owner_id) values
    ('project', 'p-a', 'Alpha', 0, false, null), ('project', 'p-b', 'Bravo', 1, false, null),
    ('project', 'p-c', 'Charlie', 2, false, null), ('project', 'p-ros', 'Rosanna secret', 3, true, ros::uuid);
  perform pg_temp.check(pg_temp.names('project', toby) = 'p-a,p-b,p-c', 'start: ' || pg_temp.names('project', toby));

  -- Drag Charlie to the top.
  perform set_config('t.uid', toby, true);
  r := public.todo_order_list('project', array['p-c', 'p-a', 'p-b']);
  perform pg_temp.check((r ->> 'ok')::boolean, 'ordered: ' || r::text);
  perform pg_temp.check((select string_agg(x ->> 'id', ',' order by n) from jsonb_array_elements(r -> 'lists') with ordinality e(x, n)) = 'p-c,p-a,p-b', 'reply in the new order');
  perform pg_temp.check(pg_temp.names('project', toby) = 'p-c,p-a,p-b', 'todo_get in the new order');
  -- Rosanna's private project was not touched, and she sees hers among them.
  perform pg_temp.check((select position from todo_lists where id = 'p-ros') = 3, 'someone else''s private project left alone');
  perform pg_temp.check(pg_temp.names('project', ros) = 'p-c,p-a,p-b,p-ros', 'Rosanna: ' || pg_temp.names('project', ros));

  -- One added meanwhile (not in the screen's list) goes after, keeping its place.
  insert into todo_lists (kind, id, name, position) values ('project', 'p-d', 'Delta', 9);
  perform set_config('t.uid', toby, true);
  r := public.todo_order_list('project', array['p-b', 'p-c', 'p-a']);
  perform pg_temp.check(pg_temp.names('project', toby) = 'p-b,p-c,p-a,p-d', 'a new one follows: ' || pg_temp.names('project', toby));
  -- Duplicates: the first place wins.
  r := public.todo_order_list('project', array['p-a', 'p-b', 'p-a', 'p-c', 'p-d']);
  perform pg_temp.check(pg_temp.names('project', toby) = 'p-a,p-b,p-c,p-d', 'duplicates ignored');

  -- Refusals change nothing.
  perform set_config('t.uid', toby, true);
  perform pg_temp.check(public.todo_order_list('project', array['p-d', 'p-ros']) ->> 'error' = 'not_found', 'cannot place a project it cannot see');
  perform pg_temp.check(public.todo_order_list('project', array['p-d', 'p-gone']) ->> 'error' = 'not_found', 'unknown id');
  perform pg_temp.check(pg_temp.names('project', toby) = 'p-a,p-b,p-c,p-d', 'a refusal moves nothing');
  perform pg_temp.check(public.todo_order_list('project', '{}') ->> 'error' = 'nothing_to_order', 'empty');
  perform pg_temp.check(public.todo_order_list('person', array['p-a']) ->> 'error' = 'bad_kind', 'bad kind');
  perform set_config('t.uid', '00000000-0000-0000-0000-0000000000b1', true);   -- the bar login
  perform pg_temp.check(public.todo_order_list('project', array['p-d']) ->> 'error' = 'office_only', 'office only');
  perform set_config('t.uid', '00000000-0000-0000-0000-0000000000c1', true);   -- housekeeping
  perform pg_temp.check(public.todo_order_list('area', array['farm']) ->> 'error' = 'office_only', 'housekeeping cannot');

  -- Tags and areas too.
  perform set_config('t.uid', toby, true);
  select array_agg(id order by position desc, name desc) into ids from todo_lists where kind = 'area';
  r := public.todo_order_list('area', ids);
  perform pg_temp.check((r ->> 'ok')::boolean and pg_temp.names('area', toby) = array_to_string(ids, ','), 'areas reversed');
  select array_agg(id order by position desc, name desc) into ids from todo_lists where kind = 'category';
  if ids is not null then
    r := public.todo_order_list('category', ids);
    perform pg_temp.check(pg_temp.names('category', toby) = array_to_string(ids, ','), 'tags reversed');
  end if;

  perform pg_temp.check(not has_function_privilege('anon', 'public.todo_order_list(text, text[])', 'execute'), 'anon cannot');
  perform pg_temp.check(has_function_privilege('authenticated', 'public.todo_order_list(text, text[])', 'execute'), 'staff can call it');
  raise notice 'todo list order: all assertions passed';
end $t$;
rollback;
