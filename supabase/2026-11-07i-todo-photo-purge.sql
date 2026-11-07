-- supabase/2026-11-07i-todo-photo-purge.sql
--
-- A to-do's photos go a month after it is done (Toby, 7 Nov 2026). The to-do
-- itself is kept for good (2026-11-07h); only its pictures are let go.
--
-- The nightly worker (netlify/functions/todo-photo-purge.js) does three steps,
-- so a run cut short is simply finished by the next one:
--   1. todo_worker_old_photos(before, limit): finished to-dos (done, done with
--      a note, not applicable) finished before `before` that still have
--      photos — id and paths.
--   2. it deletes those files from storage (the Storage API; paths starting
--      "todos/" are from build 06c and live in booking-files).
--   3. todo_worker_photos_cleared(ids, before): empties `photos` on those
--      to-dos — only if each is STILL finished before `before`, so one
--      unticked meanwhile is left alone.
-- Both are service role only.

create or replace function public.todo_worker_old_photos(p_before timestamptz, p_limit integer default 200)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id,
           'paths', (select coalesce(jsonb_agg(ph ->> 'path'), '[]'::jsonb) from jsonb_array_elements(x.photos) ph where coalesce(ph ->> 'path', '') <> ''))
           order by x.done_at), '[]'::jsonb)
    from (select i.id, i.photos, i.done_at from todo_items i
           where i.state <> 'open' and i.done_at is not null and p_before is not null and i.done_at < p_before
             and jsonb_typeof(i.photos) = 'array' and jsonb_array_length(i.photos) > 0
           order by i.done_at
           limit least(greatest(coalesce(p_limit, 200), 1), 1000)) x
$$;

create or replace function public.todo_worker_photos_cleared(p_ids text[], p_before timestamptz)
returns integer language plpgsql security definer set search_path to 'public' as $$
declare n int;
begin
  if p_before is null then return 0; end if;
  -- updated_at is left alone: a picture tidied away is not a change anybody made.
  update todo_items set photos = '[]'::jsonb
   where id = any (coalesce(p_ids, '{}')) and state <> 'open' and done_at < p_before
     and jsonb_typeof(photos) = 'array' and jsonb_array_length(photos) > 0;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.todo_worker_old_photos(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.todo_worker_photos_cleared(text[], timestamptz) from public, anon, authenticated;
grant execute on function public.todo_worker_old_photos(timestamptz, integer) to service_role;
grant execute on function public.todo_worker_photos_cleared(text[], timestamptz) to service_role;
