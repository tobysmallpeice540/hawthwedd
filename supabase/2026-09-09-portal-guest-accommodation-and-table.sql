-- supabase/2026-09-09-portal-guest-accommodation-and-table.sql
--
-- APPLIED 9 September 2026 as two migrations:
--   portal_guest_accommodation_and_table
--   portal_guest_accommodation_clearable   (the correction at the foot)
--
-- Assertions: portal-guest-accommodation-test.sql — 16, all passing.
--
-- TWO THINGS A LIST NEEDS THAT A PLAN DOES NOT
--
-- 1. WHICH accommodation, not merely whether. `staying` was a boolean, so a
--    list of forty people staying said nothing about who was in the Hamlet and
--    who was in a bell tent. staying_where holds one of the three the diary
--    knows — and only the ones this wedding has actually booked or held are
--    ever offered, which the portal takes from wp_my_event().
--
--    Two invariants, enforced in SQL rather than left to the screen, because
--    the CSV import path exists too:
--      · nobody is staying nowhere    (not staying ⇒ staying_where is null)
--      · nobody is not-staying somewhere
--
-- 2. MOVING SOMEBODY TO A TABLE WITHOUT PICKING A CHAIR. wp_assign_seat() takes
--    a seat index, which is right when you are looking at the plan and wrong
--    when you are working down a list of a hundred names. wp_set_guest_table()
--    takes the table and finds the first free chair. Passing null takes them
--    off. The unique index on (table_id, seat_index) is still what makes
--    double-seating impossible; this only picks a gap it will accept.
--
-- THE ASSERTION THAT MATTERS most here is not either of those. It is that
-- wp_set_guest_table() refuses a table belonging to another wedding, and
-- refuses to move another wedding's guest. It takes two ids, and the whole
-- security of the function is that both are checked against wp_my_event_id().
-- A parameter never decides whose data this is.
--
-- WHY add/update ARE DROPPED AND RECREATED. Adding a parameter makes an
-- OVERLOAD, not a replacement, and two overloads whose arguments all carry
-- defaults make every call ambiguous. A dropped-and-recreated function is also
-- a NEW function, so Supabase's default privileges have granted EXECUTE to anon
-- and authenticated again and both must be revoked by name. See CLAUDE.md.
--
-- wp_get_guests() is patched IN PLACE from the catalogue, two anchors, each
-- asserted exactly once.

begin;

alter table public.wp_guests add column if not exists staying_where text;
alter table public.wp_guests drop constraint if exists wp_guests_staying_where_check;
alter table public.wp_guests add constraint wp_guests_staying_where_check
  check (staying_where is null or staying_where in ('amly','hamlet','camping'));

update public.wp_guests set staying_where = null where staying = false and staying_where is not null;

do $patch$
declare
  def text; hits int;
  a1 text := $x$'plus_one_of', g.plus_one_of, 'sort', g.sort)$x$;
  r1 text := $x$'plus_one_of', g.plus_one_of, 'sort', g.sort,
               'staying_where', g.staying_where,
               'table_id', g.table_id, 'seat_index', g.seat_index,
               'table_label', (select t.label from wp_layout_tables t where t.id = g.table_id))$x$;
  a2 text := $x$        from wp_guests g where g.event_id = v_event), '[]'::jsonb)
  );$x$;
  r2 text := $x$        from wp_guests g where g.event_id = v_event), '[]'::jsonb),
    'tables', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'label', t.label,
                                          'seats', case when t.one_side then 3 else 6 end)
             order by t.created_at)
        from wp_layout_tables t where t.event_id = v_event), '[]'::jsonb)
  );$x$;
begin
  select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'wp_get_guests';
  if def is null then raise exception 'wp_get_guests() not found'; end if;

  if position('staying_where' in def) > 0 then
    raise notice 'wp_get_guests() already returns staying_where - skipped';
    return;
  end if;

  hits := (length(def) - length(replace(def, a1, ''))) / length(a1);
  if hits <> 1 then raise exception 'guest-fields anchor found % times - not patching', hits; end if;
  def := replace(def, a1, r1);

  hits := (length(def) - length(replace(def, a2, ''))) / length(a2);
  if hits <> 1 then raise exception 'tables anchor found % times - not patching', hits; end if;
  def := replace(def, a2, r2);

  execute def;
  raise notice 'wp_get_guests() patched: staying_where, table and the table list';
end
$patch$;

drop function if exists public.wp_add_guest(text, text, text, text, text, boolean, text);

create or replace function public.wp_add_guest(
  p_list         text,
  p_first_name   text,
  p_last_name    text default '',
  p_side         text default null,
  p_age_band     text default 'adult',
  p_staying      boolean default false,
  p_access_needs text default null,
  p_staying_where text default null
) returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_id    uuid;
  v_first text := trim(coalesce(p_first_name, ''));
  v_last  text := trim(coalesce(p_last_name, ''));
  v_where text := nullif(trim(coalesce(p_staying_where, '')), '');
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;
  if p_list not in ('seated', 'evening') then
    return jsonb_build_object('ok', false, 'error', 'bad_list');
  end if;
  if coalesce(p_age_band, 'adult') not in ('adult', 'child', 'baby') then
    return jsonb_build_object('ok', false, 'error', 'bad_age_band');
  end if;
  if length(trim(v_first || ' ' || v_last)) = 0 then
    return jsonb_build_object('ok', false, 'error', 'no_name');
  end if;
  if v_where is not null and v_where not in ('amly','hamlet','camping') then
    return jsonb_build_object('ok', false, 'error', 'bad_accommodation');
  end if;
  -- Nobody is staying nowhere, and nobody is not-staying somewhere. Enforced
  -- here rather than left to the screen, because the import path exists too.
  if not coalesce(p_staying, false) then v_where := null; end if;

  insert into wp_guests (event_id, list, first_name, last_name, side, age_band, staying,
                         staying_where, access_needs, sort)
  values (v_event, p_list, left(v_first, 80), left(v_last, 80), left(nullif(trim(coalesce(p_side,'')),''), 40),
          coalesce(p_age_band, 'adult'), coalesce(p_staying, false), v_where,
          left(nullif(trim(coalesce(p_access_needs,'')),''), 300),
          coalesce((select max(sort) + 1 from wp_guests where event_id = v_event and list = p_list), 0))
  returning id into v_id;

  perform wp_log('guests', 'added ' || p_list || ' guest ' || trim(v_first || ' ' || v_last));
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$function$;

drop function if exists public.wp_update_guest(uuid, text, text, text, text, boolean, text, text);

create or replace function public.wp_update_guest(
  p_id           uuid,
  p_first_name   text default null,
  p_last_name    text default null,
  p_side         text default null,
  p_age_band     text default null,
  p_staying      boolean default null,
  p_access_needs text default null,
  p_list         text default null,
  p_staying_where text default null
) returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_stay  boolean;
  v_where text := nullif(trim(coalesce(p_staying_where, '')), '');
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;
  if p_age_band is not null and p_age_band not in ('adult', 'child', 'baby') then
    return jsonb_build_object('ok', false, 'error', 'bad_age_band');
  end if;
  if p_list is not null and p_list not in ('seated', 'evening') then
    return jsonb_build_object('ok', false, 'error', 'bad_list');
  end if;
  if v_where is not null and v_where not in ('amly','hamlet','camping') then
    return jsonb_build_object('ok', false, 'error', 'bad_accommodation');
  end if;

  -- The `and event_id = v_event` clause is the whole security of this function:
  -- it takes a guest id, so it must prove that guest is the caller's.
  select staying into v_stay from wp_guests where id = p_id and event_id = v_event;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  v_stay := coalesce(p_staying, v_stay);

  -- Everything else here coalesces null to the existing value, so a field a
  -- caller emptied cannot be cleared. staying_where must be clearable — a
  -- couple who has picked The Hamlet and gone back to undecided has to be able
  -- to say so — which is why it tests p_staying_where for NULL rather than
  -- using its trimmed form. An empty string means "clear it"; not sending the
  -- parameter at all means "leave it alone".
  update wp_guests
     set first_name   = coalesce(left(trim(p_first_name), 80), first_name),
         last_name    = coalesce(left(trim(p_last_name), 80), last_name),
         side         = coalesce(left(trim(p_side), 40), side),
         age_band     = coalesce(p_age_band, age_band),
         staying      = v_stay,
         staying_where = case when not v_stay              then null
                              when p_staying_where is null then staying_where
                              else v_where end,
         access_needs = coalesce(left(trim(p_access_needs), 300), access_needs),
         list         = coalesce(p_list, list),
         updated_at   = now()
   where id = p_id and event_id = v_event;

  perform wp_log('guests', 'updated a guest');
  return jsonb_build_object('ok', true);
end;
$function$;

create or replace function public.wp_set_guest_table(p_guest_id uuid, p_table_id uuid default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_seats integer;
  v_seat  integer;
  v_label text;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;

  -- Both ids must belong to the caller's own event. A parameter never decides
  -- whose data this is.
  if not exists (select 1 from wp_guests where id = p_guest_id and event_id = v_event) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if p_table_id is null then
    update wp_guests set table_id = null, seat_index = null, updated_at = now()
     where id = p_guest_id and event_id = v_event;
    perform wp_log('table plan', 'took a guest off a table');
    return jsonb_build_object('ok', true, 'table_id', null);
  end if;

  select case when one_side then 3 else 6 end, label into v_seats, v_label
    from wp_layout_tables where id = p_table_id and event_id = v_event;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  -- Lowest free chair. The unique index on (table_id, seat_index) is what makes
  -- double-seating impossible rather than merely unlikely; this just picks a
  -- gap it will accept.
  select s into v_seat from generate_series(0, v_seats - 1) s
   where not exists (select 1 from wp_guests g
                      where g.table_id = p_table_id and g.seat_index = s and g.id <> p_guest_id)
   order by s limit 1;

  if v_seat is null then
    return jsonb_build_object('ok', false, 'error', 'table_full', 'label', v_label);
  end if;

  update wp_guests set table_id = p_table_id, seat_index = v_seat, updated_at = now()
   where id = p_guest_id and event_id = v_event;

  perform wp_log('table plan', 'seated a guest at ' || coalesce(v_label, 'a table'));
  return jsonb_build_object('ok', true, 'table_id', p_table_id, 'seat_index', v_seat, 'label', v_label);
end;
$function$;

revoke all on function public.wp_add_guest(text,text,text,text,text,boolean,text,text) from public, anon, authenticated;
grant execute on function public.wp_add_guest(text,text,text,text,text,boolean,text,text) to authenticated, service_role;
revoke all on function public.wp_update_guest(uuid,text,text,text,text,boolean,text,text,text) from public, anon, authenticated;
grant execute on function public.wp_update_guest(uuid,text,text,text,text,boolean,text,text,text) to authenticated, service_role;
revoke all on function public.wp_set_guest_table(uuid,uuid) from public, anon, authenticated;
grant execute on function public.wp_set_guest_table(uuid,uuid) to authenticated, service_role;

commit;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- The column is additive and nullable; leaving it costs nothing. To undo the
-- functions, restore the seven- and eight-argument signatures from
-- 2026-09-08-portal-phase01-guests.sql and drop wp_set_guest_table(uuid,uuid).
