-- supabase/2026-11-07g-todo-list-order.sql
--
-- Drag projects, tags and areas into order (Toby, 7 Nov 2026). The lists
-- already have `position` and todo_get already sends them in that order (and
-- the board's columns follow it); nothing could change it but a new one
-- going to the end.
--
-- todo_order_list(kind, ids): the office only, like every other change to the
-- lists. The ids given, in that order, take positions 0, 1, 2 …; any others of
-- that kind the caller can see (one added on another phone meanwhile) follow,
-- in the order they had. Someone else's private projects — which the caller
-- cannot see — are left exactly as they were. An id that is not there, or not
-- the caller's to see, refuses the whole order (not_found: the screen is out
-- of date), so nothing is half-moved.
--
-- New function: closed by default, then back to signed-in staff only (the
-- office check is inside).

create or replace function public.todo_order_list(p_kind text, p_ids text[])
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_me uuid := auth.uid(); v_role text := chk_my_role();
  v_ids text[];
  v_n int;
begin
  if v_role is null then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if v_role <> 'admin' then return jsonb_build_object('ok', false, 'error', 'office_only'); end if;
  if p_kind not in ('area', 'project', 'category') then return jsonb_build_object('ok', false, 'error', 'bad_kind'); end if;
  -- Each id once, first place wins.
  select coalesce(array_agg(id order by ord), '{}') into v_ids
    from (select id, min(ord) as ord from unnest(coalesce(p_ids, '{}')) with ordinality u(id, ord) group by id) d;
  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then return jsonb_build_object('ok', false, 'error', 'nothing_to_order'); end if;
  if v_n > 200 then return jsonb_build_object('ok', false, 'error', 'too_many'); end if;
  if exists (select 1 from unnest(v_ids) u(id)
              where not exists (select 1 from todo_lists l where l.kind = p_kind and l.id = u.id and todo_list_visible(l, v_me))) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  perform 1 from todo_lists where kind = p_kind for update;
  update todo_lists l set position = u.ord - 1, updated_at = now()
    from unnest(v_ids) with ordinality u(id, ord)
   where l.kind = p_kind and l.id = u.id;
  update todo_lists l set position = v_n + r.rn - 1, updated_at = now()
    from (select l2.id, row_number() over (order by l2.position, l2.name) as rn
            from todo_lists l2
           where l2.kind = p_kind and not (l2.id = any (v_ids)) and todo_list_visible(l2, v_me)) r
   where l.kind = p_kind and l.id = r.id;

  return jsonb_build_object('ok', true, 'lists',
    coalesce((select jsonb_agg(todo_list_json(l, v_me) order by l.position, l.name)
                from todo_lists l where l.kind = p_kind and todo_list_visible(l, v_me)), '[]'::jsonb));
end $$;

revoke all on function public.todo_order_list(text, text[]) from public, anon, authenticated;
grant execute on function public.todo_order_list(text, text[]) to authenticated;
