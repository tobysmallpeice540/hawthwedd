-- supabase/2026-11-07i-todo-photo-purge-test.sql — after the to-do sequence (06b … 07h):
--   psql -d tdtest -f supabase/2026-11-07i-todo-photo-purge.sql   (twice)
--   psql -d tdtest -f supabase/2026-11-07i-todo-photo-purge-test.sql
-- All passing prints "todo photo purge: all assertions passed". Rolled back.
\set ON_ERROR_STOP 1
begin;
create or replace function pg_temp.check(ok boolean, what text) returns void language plpgsql as
  $$ begin if not coalesce(ok, false) then raise exception 'FAILED: %', what; end if; end $$;
do $t$
declare r jsonb; cut timestamptz := now() - interval '30 days'; cnt int; before_upd timestamptz;
begin
  delete from todo_items;
  insert into todo_items (id, title, who, priority, set_on, state, done_at, photos, created_at, updated_at) values
    ('td_ph-old',  'Done 40 days ago', 'anyone', 'week', current_date - 50, 'done', now() - interval '40 days',
       '[{"path":"td_ph-old/a.jpg","name":"a"},{"path":"todos/td_ph-old/b.jpg","name":"b"}]', now() - interval '50 days', now() - interval '40 days'),
    ('td_ph-nota',   'N/A 35 days ago',  'anyone', 'week', current_date - 50, 'na',   now() - interval '35 days',
       '[{"path":"td_ph-nota/c.jpg","name":"c"}]', now() - interval '50 days', now() - interval '35 days'),
    ('td_ph-new',  'Done last week',   'anyone', 'week', current_date - 10, 'done', now() - interval '7 days',
       '[{"path":"td_ph-new/d.jpg","name":"d"}]', now() - interval '10 days', now() - interval '7 days'),
    ('td_ph-open', 'Still open',       'anyone', 'week', current_date - 90, 'open', null,
       '[{"path":"td_ph-open/e.jpg","name":"e"}]', now() - interval '90 days', now() - interval '90 days'),
    ('td_ph-none', 'Old, no photos',   'anyone', 'week', current_date - 90, 'done', now() - interval '80 days',
       '[]', now() - interval '90 days', now() - interval '80 days');

  r := public.todo_worker_old_photos(cut, null);
  perform pg_temp.check((select string_agg(x ->> 'id', ',' order by n) from jsonb_array_elements(r) with ordinality e(x, n)) = 'td_ph-old,td_ph-nota',
    'only finished over a month ago with photos, oldest first: ' || r::text);
  perform pg_temp.check((select x -> 'paths' from jsonb_array_elements(r) x where x ->> 'id' = 'td_ph-old') = '["td_ph-old/a.jpg", "todos/td_ph-old/b.jpg"]'::jsonb, 'paths, both buckets');
  perform pg_temp.check(jsonb_array_length(public.todo_worker_old_photos(cut, 1)) = 1, 'limit');

  -- Unticked between the plan and the clear: left alone.
  update todo_items set state = 'open', done_at = null where id = 'td_ph-nota';
  select updated_at into before_upd from todo_items where id = 'td_ph-old';
  cnt := public.todo_worker_photos_cleared(array['td_ph-old', 'td_ph-nota', 'td_ph-new', 'td_ph-open'], cut);
  perform pg_temp.check(cnt = 1, 'one cleared: ' || cnt);
  perform pg_temp.check((select photos from todo_items where id = 'td_ph-old') = '[]'::jsonb, 'old one has no photos now');
  perform pg_temp.check((select state from todo_items where id = 'td_ph-old') = 'done', 'the to-do itself is kept');
  perform pg_temp.check((select updated_at from todo_items where id = 'td_ph-old') = before_upd, 'updated_at not moved');
  perform pg_temp.check(jsonb_array_length((select photos from todo_items where id = 'td_ph-nota')) = 1, 'unticked meanwhile: kept');
  perform pg_temp.check(jsonb_array_length((select photos from todo_items where id = 'td_ph-new')) = 1, 'done last week: kept');
  perform pg_temp.check(jsonb_array_length((select photos from todo_items where id = 'td_ph-open')) = 1, 'open: kept');
  perform pg_temp.check(public.todo_worker_photos_cleared(array['td_ph-old'], null) = 0, 'no cut-off, nothing');

  perform pg_temp.check(not has_function_privilege('authenticated', 'public.todo_worker_old_photos(timestamptz, integer)', 'execute'), 'staff cannot list');
  perform pg_temp.check(not has_function_privilege('authenticated', 'public.todo_worker_photos_cleared(text[], timestamptz)', 'execute'), 'staff cannot clear');
  perform pg_temp.check(not has_function_privilege('anon', 'public.todo_worker_photos_cleared(text[], timestamptz)', 'execute'), 'anon cannot clear');
  raise notice 'todo photo purge: all assertions passed';
end $t$;
rollback;
