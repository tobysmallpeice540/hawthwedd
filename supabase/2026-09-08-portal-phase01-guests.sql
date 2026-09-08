-- supabase/2026-09-08-portal-phase01-guests.sql
--
-- Wedding client portal — phase 01: guest numbers and the two name lists.
--
-- APPLIED TO PRODUCTION 8 September 2026 as two migrations:
--   portal_phase01_guests
--   portal_phase01_guest_ordering   (the patch at the foot of this file)
--
-- Depends on 2026-09-08-portal-phase00-schema.sql.
-- Assertions: portal-phase01-guests-test.sql — 15, all passing.
--
-- NUMBERS BEFORE NAMES. A couple knows the counts eighteen months before they
-- know who is coming, so the tab opens as four figures and the lists fill in
-- later. NULL means "not told us yet", which is not zero.
--
-- evening_extras is EXTRAS — people arriving in the evening only. The diary's
-- eveGuests is a TOTAL. wp_get_guests() returns the extras and the derived
-- total separately so the two can never be confused at the point of use.
--
-- THE RULE, which first has teeth here: the client-facing functions that take
-- an id (a guest id) MUST verify that row belongs to the caller's own event.
-- wp_my_event_id() decides whose data it is; a parameter never does.
--
-- Applying the numbers onto the booking record is deliberately NOT done here.
-- Writing the app_data events array from SQL is the pattern that has lost
-- records four times; the admin side reads these numbers and applies them
-- through the existing re-read-then-write path.

-- ── Read everything the Guests tab needs, in one call ───────────────────────

create or replace function public.wp_get_guests()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_num   wp_guest_numbers%rowtype;
  v_declared_seated integer;
  v_named_seated    integer;
  v_named_evening   integer;
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;

  select * into v_num from wp_guest_numbers where event_id = v_event;

  v_declared_seated := coalesce(v_num.seated_adults, 0)
                     + coalesce(v_num.seated_children, 0)
                     + coalesce(v_num.seated_babies, 0);

  select count(*) filter (where list = 'seated'),
         count(*) filter (where list = 'evening')
    into v_named_seated, v_named_evening
    from wp_guests where event_id = v_event;

  return jsonb_build_object(
    'ok', true,
    'numbers', jsonb_build_object(
      'seated_adults',   v_num.seated_adults,
      'seated_children', v_num.seated_children,
      'seated_babies',   v_num.seated_babies,
      'evening_extras',  v_num.evening_extras,
      'told_us',         v_num.event_id is not null,
      'updated_at',      v_num.updated_at
    ),
    'derived', jsonb_build_object(
      -- everyone seated for the meal
      'seated_total',   nullif(v_declared_seated, 0),
      -- everyone on site in the evening: seated plus the evening-only extras
      'evening_total',  case when v_num.event_id is null then null
                             else v_declared_seated + coalesce(v_num.evening_extras, 0) end,
      'named_seated',   v_named_seated,
      'named_evening',  v_named_evening,
      -- positive => more declared than named; the gentle nag
      'seated_unnamed', case when v_num.event_id is null then null
                             else v_declared_seated - v_named_seated end
    ),
    'guests', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', g.id, 'list', g.list,
               'first_name', g.first_name, 'last_name', g.last_name,
               'side', g.side, 'age_band', g.age_band,
               'staying', g.staying, 'access_needs', g.access_needs,
               'plus_one_of', g.plus_one_of, 'sort', g.sort)
             order by (g.list = 'evening'), g.sort, g.last_name, g.first_name)
        from wp_guests g where g.event_id = v_event), '[]'::jsonb)
  );
end;
$function$;

-- ── The numbers panel ───────────────────────────────────────────────────────

create or replace function public.wp_set_numbers(
  p_seated_adults   integer,
  p_seated_children integer,
  p_seated_babies   integer,
  p_evening_extras  integer
) returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;
  if coalesce(p_seated_adults, 0) < 0 or coalesce(p_seated_children, 0) < 0
     or coalesce(p_seated_babies, 0) < 0 or coalesce(p_evening_extras, 0) < 0 then
    return jsonb_build_object('ok', false, 'error', 'negative');
  end if;
  -- A wedding here does not seat four figures. Catches a stray keystroke
  -- rather than pretending to be a capacity rule.
  if greatest(coalesce(p_seated_adults,0), coalesce(p_seated_children,0),
              coalesce(p_seated_babies,0), coalesce(p_evening_extras,0)) > 2000 then
    return jsonb_build_object('ok', false, 'error', 'implausible');
  end if;

  insert into wp_guest_numbers as n
    (event_id, seated_adults, seated_children, seated_babies, evening_extras, updated_by)
  values (v_event, p_seated_adults, p_seated_children, p_seated_babies, p_evening_extras, auth.uid())
  on conflict (event_id) do update
    set seated_adults   = excluded.seated_adults,
        seated_children = excluded.seated_children,
        seated_babies   = excluded.seated_babies,
        evening_extras  = excluded.evening_extras,
        updated_at      = now(),
        updated_by      = auth.uid();

  perform wp_log('guests', format('numbers set: %s seated, %s children, %s babies, %s evening extras',
    coalesce(p_seated_adults::text,'-'), coalesce(p_seated_children::text,'-'),
    coalesce(p_seated_babies::text,'-'), coalesce(p_evening_extras::text,'-')));

  return jsonb_build_object('ok', true);
end;
$function$;

-- ── Names ───────────────────────────────────────────────────────────────────

create or replace function public.wp_add_guest(
  p_list         text,
  p_first_name   text,
  p_last_name    text default '',
  p_side         text default null,
  p_age_band     text default 'adult',
  p_staying      boolean default false,
  p_access_needs text default null
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

  insert into wp_guests (event_id, list, first_name, last_name, side, age_band, staying, access_needs, sort)
  values (v_event, p_list, left(v_first, 80), left(v_last, 80), left(nullif(trim(coalesce(p_side,'')),''), 40),
          coalesce(p_age_band, 'adult'), coalesce(p_staying, false),
          left(nullif(trim(coalesce(p_access_needs,'')),''), 300),
          coalesce((select max(sort) + 1 from wp_guests where event_id = v_event and list = p_list), 0))
  returning id into v_id;

  perform wp_log('guests', 'added ' || p_list || ' guest ' || trim(v_first || ' ' || v_last));
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$function$;

-- Takes a guest id, so it must prove the guest is the caller's. The
-- `and g.event_id = v_event` clause is the whole security of this function.
create or replace function public.wp_update_guest(
  p_id           uuid,
  p_first_name   text default null,
  p_last_name    text default null,
  p_side         text default null,
  p_age_band     text default null,
  p_staying      boolean default null,
  p_access_needs text default null,
  p_list         text default null
) returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_hit   integer;
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;
  if p_list is not null and p_list not in ('seated', 'evening') then
    return jsonb_build_object('ok', false, 'error', 'bad_list');
  end if;
  if p_age_band is not null and p_age_band not in ('adult', 'child', 'baby') then
    return jsonb_build_object('ok', false, 'error', 'bad_age_band');
  end if;

  update wp_guests g
     set first_name   = coalesce(left(trim(p_first_name), 80), g.first_name),
         last_name    = coalesce(left(trim(p_last_name), 80),  g.last_name),
         side         = coalesce(left(trim(p_side), 40),       g.side),
         age_band     = coalesce(p_age_band,                   g.age_band),
         staying      = coalesce(p_staying,                    g.staying),
         access_needs = coalesce(left(trim(p_access_needs), 300), g.access_needs),
         list         = coalesce(p_list,                       g.list),
         updated_at   = now()
   where g.id = p_id
     and g.event_id = v_event;          -- <- the security of this function
  get diagnostics v_hit = row_count;

  if v_hit = 0 then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  perform wp_log('guests', 'edited a guest');
  return jsonb_build_object('ok', true);
end;
$function$;

create or replace function public.wp_delete_guest(p_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_name  text;
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;

  delete from wp_guests
   where id = p_id and event_id = v_event      -- <- same clause, same reason
  returning trim(first_name || ' ' || last_name) into v_name;

  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  perform wp_log('guests', 'removed ' || v_name);
  return jsonb_build_object('ok', true);
end;
$function$;

-- Bulk import: CSV or a pasted column, mapped in the browser and sent as rows.
-- One statement, so a bad row fails the lot rather than leaving half a list.
create or replace function public.wp_import_guests(p_list text, p_rows jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_base  integer;
  v_added integer;
begin
  if v_event is null then
    return jsonb_build_object('ok', false, 'error', 'no_access');
  end if;
  if p_list not in ('seated', 'evening') then
    return jsonb_build_object('ok', false, 'error', 'bad_list');
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'rows_not_an_array');
  end if;
  if jsonb_array_length(p_rows) > 1000 then
    return jsonb_build_object('ok', false, 'error', 'too_many_rows');
  end if;

  select coalesce(max(sort) + 1, 0) into v_base
    from wp_guests where event_id = v_event and list = p_list;

  with rows as (
    select r, (ord - 1) as n
      from jsonb_array_elements(p_rows) with ordinality as t(r, ord)
  )
  insert into wp_guests (event_id, list, first_name, last_name, side, age_band, staying, access_needs, sort)
  select v_event, p_list,
         left(trim(coalesce(r ->> 'first_name', '')), 80),
         left(trim(coalesce(r ->> 'last_name', '')), 80),
         left(nullif(trim(coalesce(r ->> 'side', '')), ''), 40),
         case when coalesce(r ->> 'age_band', 'adult') in ('adult','child','baby')
              then coalesce(r ->> 'age_band', 'adult') else 'adult' end,
         coalesce((r ->> 'staying')::boolean, false),
         left(nullif(trim(coalesce(r ->> 'access_needs', '')), ''), 300),
         v_base + n
    from rows
   where length(trim(coalesce(r ->> 'first_name','') || ' ' || coalesce(r ->> 'last_name',''))) > 0;
  get diagnostics v_added = row_count;

  perform wp_log('guests', format('imported %s %s guests', v_added, p_list));
  return jsonb_build_object('ok', true, 'added', v_added,
                            'skipped', jsonb_array_length(p_rows) - v_added);
end;
$function$;

-- ── Admin: read what the couple has declared ────────────────────────────────
-- Read only. Applying onto the booking record happens in the app, through the
-- existing re-read-then-write path — never from here.

create or replace function public.wp_admin_numbers(p_event_id integer)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  n wp_guest_numbers%rowtype;
  v_seated integer;
begin
  if not is_staff() then
    return jsonb_build_object('ok', false, 'error', 'not_staff');
  end if;
  select * into n from wp_guest_numbers where event_id = p_event_id;
  if n.event_id is null then
    return jsonb_build_object('ok', true, 'told_us', false);
  end if;
  v_seated := coalesce(n.seated_adults,0) + coalesce(n.seated_children,0) + coalesce(n.seated_babies,0);
  return jsonb_build_object(
    'ok', true, 'told_us', true,
    'seated_adults', n.seated_adults, 'seated_children', n.seated_children,
    'seated_babies', n.seated_babies, 'evening_extras', n.evening_extras,
    'seated_total',  v_seated,
    -- what eveGuests should become if applied: the diary holds a TOTAL
    'evening_total', v_seated + coalesce(n.evening_extras, 0),
    'named_seated',  (select count(*) from wp_guests where event_id = p_event_id and list = 'seated'),
    'named_evening', (select count(*) from wp_guests where event_id = p_event_id and list = 'evening'),
    'updated_at', n.updated_at, 'applied_at', n.applied_at);
end;
$function$;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Supabase's default privileges grant EXECUTE to anon AND authenticated on every
-- new function here. Revoke both by name, then grant back.

revoke all on function public.wp_get_guests()                                   from public, anon, authenticated;
revoke all on function public.wp_set_numbers(integer,integer,integer,integer)   from public, anon, authenticated;
revoke all on function public.wp_add_guest(text,text,text,text,text,boolean,text) from public, anon, authenticated;
revoke all on function public.wp_update_guest(uuid,text,text,text,text,boolean,text,text) from public, anon, authenticated;
revoke all on function public.wp_delete_guest(uuid)                             from public, anon, authenticated;
revoke all on function public.wp_import_guests(text,jsonb)                      from public, anon, authenticated;
revoke all on function public.wp_admin_numbers(integer)                         from public, anon, authenticated;

grant execute on function public.wp_get_guests()                                 to authenticated, service_role;
grant execute on function public.wp_set_numbers(integer,integer,integer,integer) to authenticated, service_role;
grant execute on function public.wp_add_guest(text,text,text,text,text,boolean,text) to authenticated, service_role;
grant execute on function public.wp_update_guest(uuid,text,text,text,text,boolean,text,text) to authenticated, service_role;
grant execute on function public.wp_delete_guest(uuid)                           to authenticated, service_role;
grant execute on function public.wp_import_guests(text,jsonb)                    to authenticated, service_role;
grant execute on function public.wp_admin_numbers(integer)                       to authenticated, service_role;

-- ── Applied separately as portal_phase01_guest_ordering ─────────────────────
--
-- wp_get_guests() ordered by `list` alphabetically, which puts EVENING before
-- SEATED — backwards for every screen that shows them, since the seated list is
-- the one that matters and the one the layout tab reads. Found by a test that
-- assumed the first guest returned was the seated one. The order-by above is
-- already corrected; this block is what was run against the live function, kept
-- because patching in place from the catalogue is the house rule.

do $patch$
declare
  def    text;
  anchor text := 'order by g.list, g.sort, g.last_name, g.first_name';
  repl   text := 'order by (g.list = ''evening''), g.sort, g.last_name, g.first_name';
  hits   int;
begin
  select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'wp_get_guests';

  if def is null then raise exception 'wp_get_guests() not found'; end if;
  if position(repl in def) > 0 then
    raise notice 'already ordered seated-first - skipped';
    return;
  end if;

  hits := (length(def) - length(replace(def, anchor, ''))) / length(anchor);
  if hits <> 1 then
    raise exception 'expected exactly 1 occurrence of the order-by anchor, found %', hits;
  end if;

  execute replace(def, anchor, repl);
  raise notice 'wp_get_guests() now returns the seated list first';
end
$patch$;

do $verify$
declare n int;
begin
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname like 'wp\_%'
     and has_function_privilege('anon', p.oid, 'execute');
  if n <> 0 then raise exception '% wp_ function(s) callable by anon', n; end if;

  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname like 'wp\_%' and not p.prosecdef;
  if n > 0 then raise exception '% wp_ function(s) not SECURITY DEFINER', n; end if;

  raise notice 'phase 01 guest functions in place';
end
$verify$;
