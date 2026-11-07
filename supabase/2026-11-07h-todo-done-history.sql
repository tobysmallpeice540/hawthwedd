-- supabase/2026-11-07h-todo-done-history.sql
--
-- Done to-dos, however old (Toby, 7 Nov 2026): "I might do them in the winter
-- and then want to review the done ones for the following winter and restate
-- them." Nothing has ever deleted a done to-do — todo_get just stops sending
-- them after 45 days. This sends them on request, newest first, a page at a
-- time, by the same rule as everything else (todo_visible: a private one only
-- to its people, one in a private project only to its owner).
--
-- todo_done_list(before, limit): finished to-dos (done, done with a note, or
-- not applicable) finished before `before` (null = now), at most `limit`
-- (1–1000, default 500), and `more` when there are older ones still.
--
-- New function: closed by default, then back to signed-in staff only.

create index if not exists todo_items_done_at on public.todo_items (done_at desc) where state <> 'open';

create or replace function public.todo_done_list(p_before timestamptz default null, p_limit integer default 500)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_me uuid := auth.uid(); v_role text := chk_my_role();
  v_limit int := least(greatest(coalesce(p_limit, 500), 1), 1000);
  v_items jsonb; v_n int;
begin
  if v_role is null then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  -- One more than the page, to know whether older ones remain.
  select coalesce(jsonb_agg(todo_item_json(p.t, v_me, v_role) order by p.rn) filter (where p.rn <= v_limit), '[]'::jsonb),
         count(*)
    into v_items, v_n
    from (select i as t, row_number() over (order by i.done_at desc, i.id) as rn
            from todo_items i
           where i.state <> 'open' and i.done_at is not null
             and (p_before is null or i.done_at < p_before)
             and todo_visible(i, v_me, v_role)
           order by i.done_at desc, i.id
           limit v_limit + 1) p;
  return jsonb_build_object('ok', true, 'more', v_n > v_limit, 'items', v_items);
end $$;

revoke all on function public.todo_done_list(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.todo_done_list(timestamptz, integer) to authenticated;
