-- supabase/2026-09-13-portal-layout-presets.sql
--
-- APPLIED 13 September 2026 as migration portal_layout_presets.
-- Assertions: portal-layout-presets-test.sql — 12, all passing.
--
-- Layouts Toby has already worked out, for a couple to start from.
--
-- Most couples do not want to place twenty tables one at a time; they want the
-- room the way it usually is. So arrangements are built once in the admin app,
-- named for what they seat ("98 seated, long tables"), and a couple loads one.
--
-- A PRESET IS NOT ROWS IN wp_layout_tables. It belongs to nobody's wedding, so
-- it is stored as plain positions and loading COPIES them in. That one decision
-- is what makes assertion 11 true: deleting a suggestion later cannot disturb a
-- wedding that used it, because the wedding owns its own tables.
--
-- ── THE PART THAT MATTERS: wp_load_preset ──────────────────────────────────
--
-- Loading replaces every table this wedding has, and anyone already sitting at
-- one loses their seat. That is unavoidable — the table they were sitting at
-- ceases to exist — but it must never be a surprise. So the function returns
-- HOW MANY it unseated AND THEIR NAMES, and the screen says so out loud.
--
-- It is the same rule as the "one side only" tick, which evicts three guests
-- and names them. Silently dropping people off a table plan is the family of
-- failure this project has had four times, and the answer each time has been
-- the same: report it, do not just do it.
--
-- Nobody is deleted. They go back to the unassigned list, visibly, where the
-- couple can put them somewhere else.
--
-- ── WHAT A COUPLE CAN SEE ──────────────────────────────────────────────────
--
-- Only presets for the room they are actually planning in, and only enough to
-- choose between them: name, what it seats, and the shapes. NOT the note, which
-- is Toby's aide-memoire and is withheld the same way insurance status and
-- internal notes are withheld on the supplier list.

begin;

create table if not exists public.wp_layout_presets (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid references public.wp_rooms(id) on delete cascade,
  name       text not null,
  note       text,
  -- [{x_mm, y_mm, rotation, one_side, label}]
  tables     jsonb not null default '[]'::jsonb,
  sort       integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists wp_layout_presets_room on public.wp_layout_presets (room_id);
alter table public.wp_layout_presets enable row level security;

create or replace function public.wp_get_presets()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_room  uuid;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  select id into v_room from wp_rooms where active order by created_at limit 1;

  return jsonb_build_object(
    'ok', true,
    'presets', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name,
               'tables', p.tables,
               'table_count', jsonb_array_length(p.tables),
               -- What it actually seats, counting the top table properly.
               'seats', (select coalesce(sum(case when (e ->> 'one_side')::boolean then 3 else 6 end), 0)
                           from jsonb_array_elements(p.tables) e))
             order by p.sort, p.name)
        from wp_layout_presets p
       where p.room_id = v_room), '[]'::jsonb)
  );
end;
$function$;

create or replace function public.wp_load_preset(p_preset_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_room  uuid;
  v_names text[];
  v_n     integer := 0;
  e       jsonb;
  v_ord   integer := 0;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  select id into v_room from wp_rooms where active order by created_at limit 1;

  -- The preset must belong to the room this wedding is actually in.
  if not exists (select 1 from wp_layout_presets where id = p_preset_id and room_id = v_room) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  -- Who is about to lose a seat, by name, before anything is touched.
  select array_agg(trim(g.first_name || ' ' || g.last_name) order by g.last_name, g.first_name)
    into v_names
    from wp_guests g
   where g.event_id = v_event and g.table_id is not null;

  update wp_guests set table_id = null, seat_index = null, updated_at = now()
   where event_id = v_event and table_id is not null;
  get diagnostics v_n = row_count;

  delete from wp_layout_tables where event_id = v_event;

  for e in select * from jsonb_array_elements(
             (select tables from wp_layout_presets where id = p_preset_id)) loop
    v_ord := v_ord + 1;
    insert into wp_layout_tables (event_id, room_id, label, x_mm, y_mm, rotation, one_side)
    values (v_event, v_room,
            coalesce(nullif(trim(e ->> 'label'), ''), 'Table ' || v_ord),
            coalesce((e ->> 'x_mm')::int, 1000), coalesce((e ->> 'y_mm')::int, 1000),
            coalesce((e ->> 'rotation')::int, 0),
            coalesce((e ->> 'one_side')::boolean, false));
  end loop;

  perform wp_log('table plan', 'loaded a suggested layout');
  return jsonb_build_object('ok', true, 'tables', v_ord,
                            'unseated', v_n,
                            'unseated_names', coalesce(to_jsonb(v_names), '[]'::jsonb));
end;
$function$;

create or replace function public.wp_admin_presets()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true,
    'presets', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'room_id', p.room_id, 'name', p.name, 'note', p.note,
               'tables', p.tables, 'sort', p.sort,
               'table_count', jsonb_array_length(p.tables),
               'seats', (select coalesce(sum(case when (e ->> 'one_side')::boolean then 3 else 6 end), 0)
                           from jsonb_array_elements(p.tables) e))
             order by p.sort, p.name)
        from wp_layout_presets p), '[]'::jsonb));
end;
$function$;

create or replace function public.wp_admin_save_preset(
  p_id uuid default null, p_name text default null, p_note text default null,
  p_tables jsonb default null, p_room_id uuid default null, p_sort integer default null
) returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_room uuid;
  v_id   uuid;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if p_tables is not null and jsonb_typeof(p_tables) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'tables_not_an_array');
  end if;
  if p_tables is not null and jsonb_array_length(p_tables) > 60 then
    return jsonb_build_object('ok', false, 'error', 'too_many_tables');
  end if;

  v_room := coalesce(p_room_id, (select id from wp_rooms where active order by created_at limit 1));
  if v_room is null then return jsonb_build_object('ok', false, 'error', 'no_room'); end if;

  if p_id is null then
    if v_name is null then return jsonb_build_object('ok', false, 'error', 'needs_name'); end if;
    insert into wp_layout_presets (room_id, name, note, tables, sort)
    values (v_room, left(v_name, 80), left(nullif(trim(coalesce(p_note,'')),''), 300),
            coalesce(p_tables, '[]'::jsonb), coalesce(p_sort, 0))
    returning id into v_id;
    perform wp_log('admin', 'saved a new layout: ' || left(v_name, 60));
    return jsonb_build_object('ok', true, 'id', v_id);
  end if;

  update wp_layout_presets
     set name    = coalesce(left(v_name, 80), name),
         note    = case when p_note is null then note
                        else left(nullif(trim(p_note), ''), 300) end,
         tables  = coalesce(p_tables, tables),
         sort    = coalesce(p_sort, sort)
   where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  perform wp_log('admin', 'changed a saved layout');
  return jsonb_build_object('ok', true, 'id', p_id);
end;
$function$;

create or replace function public.wp_admin_delete_preset(p_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  delete from wp_layout_presets where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  -- Deleting a suggestion cannot disturb a wedding: loading one COPIES the
  -- tables in, so anybody who used it keeps what they have.
  perform wp_log('admin', 'removed a saved layout');
  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.wp_get_presets()                                     from public, anon, authenticated;
revoke all on function public.wp_load_preset(uuid)                                 from public, anon, authenticated;
revoke all on function public.wp_admin_presets()                                   from public, anon, authenticated;
revoke all on function public.wp_admin_save_preset(uuid,text,text,jsonb,uuid,integer) from public, anon, authenticated;
revoke all on function public.wp_admin_delete_preset(uuid)                         from public, anon, authenticated;

grant execute on function public.wp_get_presets()                                     to authenticated, service_role;
grant execute on function public.wp_load_preset(uuid)                                 to authenticated, service_role;
grant execute on function public.wp_admin_presets()                                   to authenticated, service_role;
grant execute on function public.wp_admin_save_preset(uuid,text,text,jsonb,uuid,integer) to authenticated, service_role;
grant execute on function public.wp_admin_delete_preset(uuid)                         to authenticated, service_role;

commit;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- drop table if exists public.wp_layout_presets cascade;  -- and the 5 functions.
-- No wedding is affected: a loaded layout was copied in and the tables belong
-- to the event.
