-- supabase/2026-09-09-portal-accommodation-capacity.sql
--
-- APPLIED 9 September 2026 as migration portal_accommodation_capacity.
-- Assertions: portal-accommodation-test.sql — 10, all passing.
--
-- "4 of 6" on the couple's overview, per place.
--
-- CAPACITIES LIVE IN A TABLE, NOT IN THE CODE. They are facts about the farm
-- that change when a bed is added or a bell tent retired, and a venue fact
-- buried in a JavaScript bundle is one nobody can correct without a deploy.
-- Seeded with what Toby gave: Amly 6, the Hamlet 14 adults and 1 child,
-- glamping 20 — and editable under Manage Client Portal → Templates.
--
-- ADULTS AND CHILDREN ARE COUNTED SEPARATELY because the Hamlet's capacity is
-- genuinely "fourteen and a cot" rather than fifteen of anything.
--
-- TWO DECISIONS WORTH KNOWING:
--
-- 1. Allocated counts BOTH lists. An evening guest who stays over occupies a
--    bed exactly as a seated one does, and counting only the seated list would
--    quietly under-report the very thing this panel exists to show.
--
-- 2. Over capacity WARNS and never refuses — the house rule throughout. Someone
--    may well know something we do not: a travel cot, a child sharing, two in a
--    single. The venue flags; the couple decides.
--
-- The slugs are fixed to the three the diary has fields for. Inventing a fourth
-- would create a place that shows as permanently undecided with nothing to
-- explain why, so wp_admin_save_accommodation refuses one.

begin;

create table if not exists public.wp_accommodation (
  slug            text primary key,
  label           text not null,
  sleeps_adults   integer not null default 0,
  sleeps_children integer not null default 0,
  sort            integer not null default 0
);
alter table public.wp_accommodation enable row level security;

insert into public.wp_accommodation (slug, label, sleeps_adults, sleeps_children, sort) values
  ('amly',    'Amly',       6,  0, 10),
  ('hamlet',  'The Hamlet', 14, 1, 20),
  ('camping', 'Glamping',   20, 0, 30)
on conflict (slug) do update
  set label = excluded.label,
      sleeps_adults = excluded.sleeps_adults,
      sleeps_children = excluded.sleeps_children,
      sort = excluded.sort;

create or replace function public.wp_get_accommodation()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  ev      jsonb;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;

  select e into ev from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key = 'hawthbush_bookings_v6' and (e ->> 'id')::int = v_event limit 1;

  return jsonb_build_object(
    'ok', true,
    'places', coalesce((
      select jsonb_agg(jsonb_build_object(
               'slug', p.slug, 'label', p.label,
               'sleeps_adults', p.sleeps_adults, 'sleeps_children', p.sleeps_children,
               'sleeps', p.sleeps_adults + p.sleeps_children,
               'status', coalesce(ev ->> (case p.slug
                                            when 'amly'    then 'amlyBooked'
                                            when 'hamlet'  then 'hamletBooked'
                                            else                'campingBooked' end), 'undecided'),
               'allocated', (select count(*) from wp_guests g
                              where g.event_id = v_event and g.staying and g.staying_where = p.slug),
               'allocated_adults', (select count(*) from wp_guests g
                              where g.event_id = v_event and g.staying and g.staying_where = p.slug
                                and g.age_band = 'adult'),
               'allocated_children', (select count(*) from wp_guests g
                              where g.event_id = v_event and g.staying and g.staying_where = p.slug
                                and g.age_band <> 'adult'))
             order by p.sort)
        from wp_accommodation p), '[]'::jsonb),
    -- Anyone marked as staying but not yet put anywhere. This is the number
    -- that actually prompts somebody to finish the job.
    'unplaced', (select count(*) from wp_guests g
                  where g.event_id = v_event and g.staying and g.staying_where is null)
  );
end;
$function$;

create or replace function public.wp_admin_accommodation()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true,
    'places', coalesce((select jsonb_agg(jsonb_build_object(
                          'slug', p.slug, 'label', p.label,
                          'sleeps_adults', p.sleeps_adults, 'sleeps_children', p.sleeps_children)
                        order by p.sort)
                          from wp_accommodation p), '[]'::jsonb));
end;
$function$;

create or replace function public.wp_admin_save_accommodation(p_rows jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare e jsonb; v_n integer := 0;
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'rows_not_an_array');
  end if;

  -- Only the three that exist can be changed, and only their numbers and name.
  -- Inventing a slug here would create a place the diary has no field for, and
  -- it would show as permanently undecided with nothing to explain why.
  for e in select * from jsonb_array_elements(p_rows) loop
    if not exists (select 1 from wp_accommodation where slug = e ->> 'slug') then
      return jsonb_build_object('ok', false, 'error', 'unknown_place');
    end if;
    if coalesce((e ->> 'sleeps_adults')::int, 0) < 0
       or coalesce((e ->> 'sleeps_children')::int, 0) < 0
       or coalesce((e ->> 'sleeps_adults')::int, 0) > 200
       or coalesce((e ->> 'sleeps_children')::int, 0) > 200 then
      return jsonb_build_object('ok', false, 'error', 'bad_capacity');
    end if;
  end loop;

  for e in select * from jsonb_array_elements(p_rows) loop
    update wp_accommodation
       set label           = coalesce(left(nullif(trim(e ->> 'label'), ''), 60), label),
           sleeps_adults   = coalesce((e ->> 'sleeps_adults')::int, sleeps_adults),
           sleeps_children = coalesce((e ->> 'sleeps_children')::int, sleeps_children)
     where slug = e ->> 'slug';
    v_n := v_n + 1;
  end loop;

  perform wp_log('admin', 'changed what the accommodation sleeps');
  return jsonb_build_object('ok', true, 'saved', v_n);
end;
$function$;

revoke all on function public.wp_get_accommodation()                from public, anon, authenticated;
revoke all on function public.wp_admin_accommodation()              from public, anon, authenticated;
revoke all on function public.wp_admin_save_accommodation(jsonb)    from public, anon, authenticated;

grant execute on function public.wp_get_accommodation()             to authenticated, service_role;
grant execute on function public.wp_admin_accommodation()           to authenticated, service_role;
grant execute on function public.wp_admin_save_accommodation(jsonb) to authenticated, service_role;

commit;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- drop the three functions; the overview falls back to showing booked/held with
-- no counts, which is what it did before. The table is additive.
