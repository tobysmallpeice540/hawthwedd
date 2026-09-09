-- supabase/2026-09-09-portal-room-doors-text-table-size.sql
--
-- APPLIED 9 September 2026 as migration portal_room_doors_text_table_size.
-- Assertions: portal-room-doors-text-test.sql — 7, all passing.
--
-- THREE CHANGES, ONE THEME: the room stops being a rectangle with boxes on it.
--
-- 1. DOORS AND TEXT. shapes[] gains two kinds beyond fixed and nogo:
--
--      door   {kind, label, x, y, w, h, hinge}  hinge is 0-7
--      text   {kind, label, x, y, w, h}         h is the text height
--
--    No column changes — shapes has always been open jsonb and the upsert only
--    ever checked it was an array. A door's `hinge` picks one of eight
--    arrangements: four corners to hinge on, and for each, two choices of which
--    adjacent edge the leaf rests against. Toby cycles a button until it looks
--    like the real door; there is no attempt to model walls.
--
--    The arithmetic behind those eight is written out TWICE in the front end —
--    once in the admin editor, once in the portal — and tests/door-geometry-test.mjs
--    exists to stop them drifting. If they ever disagree, a door is drawn
--    opening one way for Toby and the other way for the couple, with nothing to
--    say so.
--
-- 2. THE TABLE IS NO LONGER A CONSTANT. Its length and depth used to be
--    hardcoded at 1830 × 760 inside wp_get_layout(). They now live on the room,
--    along with two new measurements:
--
--      chair_depth_mm  how far a chair sticks out from the table edge
--      clearance_mm    the room somebody needs to pull that chair back and stand
--
--    The second is the one that matters. Without it two tables can be drawn
--    200mm apart: it fits on screen and traps everybody sitting between them.
--    The portal now refuses a position that leaves no pull-out room, and draws
--    the space so a couple can see why. A table ticked "one side only" is padded
--    on ONE side, so it can still go hard against a wall — which is the entire
--    point of that tick.
--
-- 3. wp_get_layout() IS PATCHED IN PLACE. Read out of the catalogue with
--    pg_get_functiondef() and string patched, never retyped: a copy through a
--    chat window once arrived 24 characters short. The anchor must appear
--    exactly once or the block raises and changes nothing, and it skips if
--    already applied.
--
-- WHY THE UPSERT IS DROPPED RATHER THAN REPLACED. Adding parameters to a
-- function makes an OVERLOAD, not a replacement. Two overloads whose arguments
-- all carry defaults make every call ambiguous, and PostgREST would start
-- failing on a function that looked fine in the catalogue.

begin;

-- ── 1. The table is no longer a constant ────────────────────────────────────

alter table public.wp_rooms add column if not exists table_length_mm integer not null default 1830;
alter table public.wp_rooms add column if not exists table_depth_mm  integer not null default 760;
alter table public.wp_rooms add column if not exists chair_depth_mm  integer not null default 450;
alter table public.wp_rooms add column if not exists clearance_mm    integer not null default 450;

-- ── 2. Patch wp_get_layout() in place ───────────────────────────────────────

do $patch$
declare
  def    text;
  anchor text := $a$'table_size', jsonb_build_object('length_mm', 1830, 'depth_mm', 760, 'seats_per_side', 3),$a$;
  repl   text := $r$'table_size', coalesce((select jsonb_build_object('length_mm', r2.table_length_mm, 'depth_mm', r2.table_depth_mm, 'seats_per_side', 3, 'chair_depth_mm', r2.chair_depth_mm, 'clearance_mm', r2.clearance_mm) from wp_rooms r2 where r2.active order by r2.created_at limit 1), jsonb_build_object('length_mm', 1830, 'depth_mm', 760, 'seats_per_side', 3, 'chair_depth_mm', 450, 'clearance_mm', 450)),$r$;
  hits   int;
begin
  select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'wp_get_layout';
  if def is null then raise exception 'wp_get_layout() not found'; end if;

  if position('chair_depth_mm' in def) > 0 then
    raise notice 'wp_get_layout() already reads the table size from the room - skipped';
    return;
  end if;

  hits := (length(def) - length(replace(def, anchor, ''))) / length(anchor);
  if hits <> 1 then
    raise exception 'expected exactly 1 occurrence of the table_size anchor, found % - not patching', hits;
  end if;

  execute replace(def, anchor, repl);
  raise notice 'wp_get_layout() patched: table size now comes from the room';
end
$patch$;

-- ── 3. The upsert gains the four measurements ───────────────────────────────

drop function if exists public.wp_admin_upsert_room(uuid, text, integer, integer, jsonb, boolean);

create or replace function public.wp_admin_upsert_room(
  p_id uuid default null, p_name text default null,
  p_width_mm integer default null, p_height_mm integer default null,
  p_shapes jsonb default null, p_active boolean default null,
  p_table_length_mm integer default null, p_table_depth_mm integer default null,
  p_chair_depth_mm integer default null, p_clearance_mm integer default null
) returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare v_id uuid;
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if p_shapes is not null and jsonb_typeof(p_shapes) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'shapes_not_an_array');
  end if;

  -- A table 40mm long, or a room-sized one, is a typo rather than an intention.
  -- Refuse it here: the plan is indicative, but it still has to be recognisable.
  if coalesce(p_table_length_mm, 1830) not between 300 and 6000
     or coalesce(p_table_depth_mm, 760) not between 300 and 3000
     or coalesce(p_chair_depth_mm, 450) not between 0 and 1500
     or coalesce(p_clearance_mm, 450) not between 0 and 2000 then
    return jsonb_build_object('ok', false, 'error', 'measurement_out_of_range');
  end if;

  if p_id is null then
    insert into wp_rooms (name, width_mm, height_mm, shapes, active,
                          table_length_mm, table_depth_mm, chair_depth_mm, clearance_mm)
    values (coalesce(nullif(trim(coalesce(p_name,'')),''), 'The barn'),
            coalesce(p_width_mm, 12000), coalesce(p_height_mm, 9000),
            coalesce(p_shapes, '[]'::jsonb), coalesce(p_active, true),
            coalesce(p_table_length_mm, 1830), coalesce(p_table_depth_mm, 760),
            coalesce(p_chair_depth_mm, 450), coalesce(p_clearance_mm, 450))
    returning id into v_id;
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  update wp_rooms
     set name            = coalesce(left(trim(p_name),80), name),
         width_mm        = coalesce(p_width_mm, width_mm),
         height_mm       = coalesce(p_height_mm, height_mm),
         shapes          = coalesce(p_shapes, shapes),
         active          = coalesce(p_active, active),
         table_length_mm = coalesce(p_table_length_mm, table_length_mm),
         table_depth_mm  = coalesce(p_table_depth_mm, table_depth_mm),
         chair_depth_mm  = coalesce(p_chair_depth_mm, chair_depth_mm),
         clearance_mm    = coalesce(p_clearance_mm, clearance_mm)
   where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'id', p_id);
end;
$function$;

-- ── 4. The reader hands the measurements back ───────────────────────────────

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
               'table_length_mm', r.table_length_mm, 'table_depth_mm', r.table_depth_mm,
               'chair_depth_mm', r.chair_depth_mm, 'clearance_mm', r.clearance_mm,
               'tables_using', (select count(*) from wp_layout_tables t where t.room_id = r.id))
             order by r.created_at)
        from wp_rooms r), '[]'::jsonb)
  );
end;
$function$;

-- ── 5. Grants ───────────────────────────────────────────────────────────────
-- Supabase grants EXECUTE to anon AND authenticated by default on every new
-- function in `public`, and a DROP + CREATE is a new function. Revoking from
-- `public` alone does not do it. See CLAUDE.md.

revoke all on function public.wp_admin_rooms() from public, anon, authenticated;
grant execute on function public.wp_admin_rooms() to authenticated, service_role;
revoke all on function public.wp_admin_upsert_room(uuid,text,integer,integer,jsonb,boolean,integer,integer,integer,integer) from public, anon, authenticated;
grant execute on function public.wp_admin_upsert_room(uuid,text,integer,integer,jsonb,boolean,integer,integer,integer,integer) to authenticated, service_role;

commit;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- The columns can stay; they are additive and defaulted. To put the table size
-- back to a constant, patch wp_get_layout() the same way in reverse. Dropping
-- the columns would break it, since the patched body reads them.
