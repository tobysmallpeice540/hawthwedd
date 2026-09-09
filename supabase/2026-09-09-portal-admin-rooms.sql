-- supabase/2026-09-09-portal-admin-rooms.sql
--
-- APPLIED 9 September 2026 as migration portal_admin_rooms_reader.
--
-- WHY
--
-- Phase 08 shipped wp_admin_upsert_room() and no way to read a room back, so
-- the admin app could create one and then never find it again. There was
-- therefore no room editor, and every couple's Table plan tab said the room had
-- not been set up. This is the missing half.
--
-- THE ONE THING IT DOES BEYOND LISTING
--
-- wp_get_layout() picks the room like this:
--
--     from wp_rooms r where r.active order by r.created_at limit 1
--
-- The OLDEST ACTIVE room, and nothing else. A second active room is silently
-- ignored — so someone editing the wrong one would see their changes have no
-- effect on any client screen, with nothing to tell them why. This returns
-- live_room_id so the editor can say so out loud, which is cheaper than the
-- support conversation.
--
-- tables_using is there for the same reason: it says whether a room is in use
-- before anyone retires it.
--
-- SECURITY. is_staff() inside, and the grant revoked from anon and
-- authenticated by name — Supabase grants EXECUTE to both by default on every
-- new function in `public`, and revoking from `public` alone does not do it.
-- See CLAUDE.md.

begin;

create or replace function public.wp_admin_rooms()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare v_live uuid;
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;

  -- wp_get_layout() picks the oldest active room and nothing else, so a second
  -- active room is silently ignored. Name the one that actually wins rather
  -- than leaving somebody to wonder why their edits changed nothing.
  select id into v_live from wp_rooms where active order by created_at limit 1;

  return jsonb_build_object(
    'ok', true,
    'live_room_id', v_live,
    'rooms', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'name', r.name,
               'width_mm', r.width_mm, 'height_mm', r.height_mm,
               'shapes', r.shapes, 'active', r.active,
               'tables_using', (select count(*) from wp_layout_tables t where t.room_id = r.id))
             order by r.created_at)
        from wp_rooms r), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.wp_admin_rooms() from public, anon, authenticated;
grant execute on function public.wp_admin_rooms() to authenticated, service_role;

do $verify$
begin
  if has_function_privilege('anon','public.wp_admin_rooms()','execute') then
    raise exception 'anon can execute wp_admin_rooms() - refusing';
  end if;
  if not has_function_privilege('authenticated','public.wp_admin_rooms()','execute') then
    raise exception 'staff cannot execute wp_admin_rooms()';
  end if;
end
$verify$;

commit;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- drop function if exists public.wp_admin_rooms();
-- The room editor then has nothing to load and shows its empty state.
