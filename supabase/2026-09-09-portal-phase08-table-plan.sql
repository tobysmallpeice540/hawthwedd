-- supabase/2026-09-09-portal-phase08-table-plan.sql
--
-- Wedding client portal — phases 07/08: the table plan.
--
-- APPLIED TO PRODUCTION 9 September 2026 as migration portal_phase08_table_plan.
-- Assertions: portal-phase08-table-plan-test.sql — 19, all passing.
--
-- ONE TABLE TYPE. Rectangular, six seats, three a side — a 6ft trestle at
-- 1830 × 760mm, which is 610mm a cover. Seats are NOT objects the client
-- places: they are derived from the table's position and rotation, so a table
-- and its six seats move as one thing and rotating in 90° steps simply redraws
-- them. A per-table "one side only" tick drops it to three seats for the top
-- table.
--
-- THE BEHAVIOUR THAT EARNS ITS ASSERTIONS, and the reason this is not just CRUD:
--
--   · Ticking "one side only" destroys seats 3, 4 and 5. Anyone sitting there
--     must return to the unassigned list VISIBLY. Silently dropping three
--     guests off a table plan is the same family as the four record-loss
--     incidents, so the function reports how many it moved AND their names, and
--     the screen says so out loud.
--   · Rotating must not reshuffle anybody. Seats keep their index; only their
--     drawn position changes. Rotation therefore touches no assignment at all.
--   · Deleting a table returns its guests to the unassigned list rather than
--     deleting them.
--
-- The plan is INDICATIVE, not authoritative — Toby's setup sheet stays master —
-- so there is no millimetre accuracy here and no fire-gangway checking.
--
-- Seat assignment lives on wp_guests rather than in a join table, because a
-- guest can only be in one seat and a unique index then makes double-seating
-- impossible rather than merely unlikely.

create table if not exists public.wp_rooms (
  id        uuid primary key default gen_random_uuid(),
  name      text not null,
  width_mm  integer not null default 12000,
  height_mm integer not null default 9000,
  -- fixed things and no-go zones: [{kind, label, x, y, w, h}]
  -- kind: 'fixed' (bar, stage, doors, pillars) or 'nogo' (nothing may sit here)
  shapes    jsonb not null default '[]'::jsonb,
  active    boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.wp_rooms enable row level security;

create table if not exists public.wp_layout_tables (
  id        uuid primary key default gen_random_uuid(),
  event_id  integer not null,
  room_id   uuid references public.wp_rooms(id) on delete set null,
  label     text,
  x_mm      integer not null,
  y_mm      integer not null,
  rotation  integer not null default 0 check (rotation in (0, 90, 180, 270)),
  one_side  boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists wp_layout_tables_event on public.wp_layout_tables (event_id);
alter table public.wp_layout_tables enable row level security;

alter table public.wp_guests add column if not exists table_id uuid
  references public.wp_layout_tables(id) on delete set null;
alter table public.wp_guests add column if not exists seat_index integer;

-- One bottom to a seat.
create unique index if not exists wp_guests_one_per_seat
  on public.wp_guests (table_id, seat_index) where table_id is not null;

-- ── Read ────────────────────────────────────────────────────────────────────

create or replace function public.wp_get_layout()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_seated integer;
  v_placed integer;
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;

  select count(*) into v_seated from wp_guests where event_id = v_event and list = 'seated';
  select coalesce(sum(case when one_side then 3 else 6 end), 0) into v_placed
    from wp_layout_tables where event_id = v_event;

  return jsonb_build_object(
    'ok', true,
    'room', (select jsonb_build_object('id', r.id, 'name', r.name,
               'width_mm', r.width_mm, 'height_mm', r.height_mm, 'shapes', r.shapes)
               from wp_rooms r where r.active order by r.created_at limit 1),
    'table_size', jsonb_build_object('length_mm', 1830, 'depth_mm', 760, 'seats_per_side', 3),
    'tables', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'label', t.label, 'x_mm', t.x_mm, 'y_mm', t.y_mm,
               'rotation', t.rotation, 'one_side', t.one_side,
               'seats', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'seat_index', g.seat_index, 'guest_id', g.id,
                          'name', trim(g.first_name || ' ' || g.last_name))
                        order by g.seat_index)
                   from wp_guests g where g.table_id = t.id), '[]'::jsonb))
             order by t.created_at)
        from wp_layout_tables t where t.event_id = v_event), '[]'::jsonb),
    'unseated', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', g.id, 'name', trim(g.first_name || ' ' || g.last_name), 'side', g.side)
             order by g.last_name, g.first_name)
        from wp_guests g
       where g.event_id = v_event and g.list = 'seated' and g.table_id is null), '[]'::jsonb),
    'counts', jsonb_build_object(
      'seated_guests', v_seated,
      'seats_placed',  v_placed,
      -- 96 guests is 16 tables. Worth saying so rather than making them count.
      'tables_needed', ceil(v_seated::numeric / 6)::int)
  );
end;
$function$;

-- ── Tables ──────────────────────────────────────────────────────────────────

create or replace function public.wp_add_table(p_x_mm integer, p_y_mm integer, p_label text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_room uuid; v_id uuid; v_n integer;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  select id into v_room from wp_rooms where active order by created_at limit 1;
  select count(*) into v_n from wp_layout_tables where event_id = v_event;
  if v_n >= 60 then return jsonb_build_object('ok', false, 'error', 'too_many_tables'); end if;

  insert into wp_layout_tables (event_id, room_id, label, x_mm, y_mm)
  values (v_event, v_room,
          coalesce(nullif(trim(coalesce(p_label,'')),''), 'Table ' || (v_n + 1)),
          coalesce(p_x_mm, 1000), coalesce(p_y_mm, 1000))
  returning id into v_id;

  perform wp_log('table plan', 'added a table');
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$function$;

-- Moving and rotating. Rotation deliberately does not touch seat assignments:
-- a seat keeps its index and only its drawn position changes.
create or replace function public.wp_move_table(
  p_id uuid, p_x_mm integer default null, p_y_mm integer default null,
  p_rotation integer default null, p_label text default null
) returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_hit integer;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if p_rotation is not null and p_rotation not in (0,90,180,270) then
    return jsonb_build_object('ok', false, 'error', 'bad_rotation');
  end if;

  update wp_layout_tables
     set x_mm     = coalesce(p_x_mm, x_mm),
         y_mm     = coalesce(p_y_mm, y_mm),
         rotation = coalesce(p_rotation, rotation),
         label    = coalesce(left(trim(p_label), 40), label)
   where id = p_id and event_id = v_event;     -- <- the security of this function
  get diagnostics v_hit = row_count;

  if v_hit = 0 then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end;
$function$;

-- The one that can lose people if it is careless. Turning a table to one side
-- destroys seats 3, 4 and 5; anyone there goes back to the unassigned list and
-- the count of who moved is returned so the screen can say so out loud.
create or replace function public.wp_set_table_sides(p_id uuid, p_one_side boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_exists boolean;
  v_moved integer := 0;
  v_names text[];
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;

  select true into v_exists from wp_layout_tables where id = p_id and event_id = v_event;
  if v_exists is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  if p_one_side then
    select array_agg(trim(first_name || ' ' || last_name)) into v_names
      from wp_guests where table_id = p_id and seat_index >= 3;

    update wp_guests set table_id = null, seat_index = null
     where table_id = p_id and seat_index >= 3;
    get diagnostics v_moved = row_count;
  end if;

  update wp_layout_tables set one_side = p_one_side where id = p_id and event_id = v_event;

  if v_moved > 0 then
    perform wp_log('table plan', format('one side only: %s guest(s) went back to the list', v_moved));
  end if;
  return jsonb_build_object('ok', true, 'unseated', v_moved,
                            'names', coalesce(to_jsonb(v_names), '[]'::jsonb));
end;
$function$;

create or replace function public.wp_delete_table(p_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_moved integer := 0;
  v_hit integer;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if not exists (select 1 from wp_layout_tables where id = p_id and event_id = v_event) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  -- Back to the list, not deleted with the table.
  update wp_guests set table_id = null, seat_index = null where table_id = p_id;
  get diagnostics v_moved = row_count;

  delete from wp_layout_tables where id = p_id and event_id = v_event;
  get diagnostics v_hit = row_count;

  perform wp_log('table plan', 'removed a table');
  return jsonb_build_object('ok', true, 'unseated', v_moved);
end;
$function$;

-- ── Seating ─────────────────────────────────────────────────────────────────

create or replace function public.wp_assign_seat(p_guest_id uuid, p_table_id uuid, p_seat_index integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_one_side boolean;
  v_list text;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;

  select one_side into v_one_side from wp_layout_tables where id = p_table_id and event_id = v_event;
  if v_one_side is null then return jsonb_build_object('ok', false, 'error', 'table_not_found'); end if;

  select list into v_list from wp_guests where id = p_guest_id and event_id = v_event;
  if v_list is null then return jsonb_build_object('ok', false, 'error', 'guest_not_found'); end if;
  -- Evening-only guests do not get a seat at the meal.
  if v_list <> 'seated' then return jsonb_build_object('ok', false, 'error', 'not_a_seated_guest'); end if;

  if p_seat_index is null or p_seat_index < 0
     or p_seat_index > (case when v_one_side then 2 else 5 end) then
    return jsonb_build_object('ok', false, 'error', 'no_such_seat');
  end if;

  -- Whoever is in that seat gets up first, so a swap does not fail on the
  -- unique index and leave the screen disagreeing with the database.
  update wp_guests set table_id = null, seat_index = null
   where table_id = p_table_id and seat_index = p_seat_index and id <> p_guest_id;

  update wp_guests set table_id = p_table_id, seat_index = p_seat_index
   where id = p_guest_id and event_id = v_event;

  return jsonb_build_object('ok', true);
end;
$function$;

create or replace function public.wp_unassign_seat(p_guest_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_hit integer;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  update wp_guests set table_id = null, seat_index = null
   where id = p_guest_id and event_id = v_event;
  get diagnostics v_hit = row_count;
  if v_hit = 0 then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end;
$function$;

-- ── Admin: the room ─────────────────────────────────────────────────────────

create or replace function public.wp_admin_upsert_room(
  p_id uuid default null, p_name text default null,
  p_width_mm integer default null, p_height_mm integer default null,
  p_shapes jsonb default null, p_active boolean default null
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

  if p_id is null then
    insert into wp_rooms (name, width_mm, height_mm, shapes, active)
    values (coalesce(nullif(trim(coalesce(p_name,'')),''), 'The barn'),
            coalesce(p_width_mm, 12000), coalesce(p_height_mm, 9000),
            coalesce(p_shapes, '[]'::jsonb), coalesce(p_active, true))
    returning id into v_id;
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  update wp_rooms
     set name      = coalesce(left(trim(p_name),80), name),
         width_mm  = coalesce(p_width_mm, width_mm),
         height_mm = coalesce(p_height_mm, height_mm),
         shapes    = coalesce(p_shapes, shapes),
         active    = coalesce(p_active, active)
   where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'id', p_id);
end;
$function$;

-- ── Grants ──────────────────────────────────────────────────────────────────

revoke all on function public.wp_get_layout()                                  from public, anon, authenticated;
revoke all on function public.wp_add_table(integer,integer,text)                from public, anon, authenticated;
revoke all on function public.wp_move_table(uuid,integer,integer,integer,text)  from public, anon, authenticated;
revoke all on function public.wp_set_table_sides(uuid,boolean)                  from public, anon, authenticated;
revoke all on function public.wp_delete_table(uuid)                             from public, anon, authenticated;
revoke all on function public.wp_assign_seat(uuid,uuid,integer)                 from public, anon, authenticated;
revoke all on function public.wp_unassign_seat(uuid)                            from public, anon, authenticated;
revoke all on function public.wp_admin_upsert_room(uuid,text,integer,integer,jsonb,boolean) from public, anon, authenticated;

grant execute on function public.wp_get_layout()                                 to authenticated, service_role;
grant execute on function public.wp_add_table(integer,integer,text)              to authenticated, service_role;
grant execute on function public.wp_move_table(uuid,integer,integer,integer,text) to authenticated, service_role;
grant execute on function public.wp_set_table_sides(uuid,boolean)                to authenticated, service_role;
grant execute on function public.wp_delete_table(uuid)                           to authenticated, service_role;
grant execute on function public.wp_assign_seat(uuid,uuid,integer)               to authenticated, service_role;
grant execute on function public.wp_unassign_seat(uuid)                          to authenticated, service_role;
grant execute on function public.wp_admin_upsert_room(uuid,text,integer,integer,jsonb,boolean) to authenticated, service_role;
