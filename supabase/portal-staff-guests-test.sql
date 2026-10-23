-- supabase/portal-staff-guests-test.sql
--
-- Assertions for 2026-10-23d-staff-guests-suppliers.sql. Rolled back; the
-- result arrives as an exception:  ERROR: ALL n ASSERTIONS PASSED (rolled back)
-- Removes no rows, so it can run through tools that hold destructive SQL.
--
--   A1  the guest list is admin-only: a bar login and a client both refused
--   N1  staff-set numbers land, are read back by the client's own tab, and
--       are logged against the event
--   L1  the all-events totals agree with the per-event numbers

do $t$
declare
  uA uuid := '00000000-0000-4000-8000-0000000000f1';   -- admin
  uB uuid := '00000000-0000-4000-8000-0000000000f2';   -- bar
  uC uuid := '00000000-0000-4000-8000-0000000000f3';   -- client of ev
  ev int; r jsonb; fails text[] := '{}'; passes int := 0;
begin
  select (e->>'id')::int into ev from app_data x, lateral jsonb_array_elements(x.value) e
   where x.key='hawthbush_bookings_v6' and wp_event_type_label(e->>'eventType')='Wedding'
     and not exists (select 1 from wp_access a where a.event_id = (e->>'id')::int)
     and not exists (select 1 from wp_guest_numbers n where n.event_id = (e->>'id')::int)
   order by e->>'date' desc limit 1;

  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
    (uA,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','sa@test.invalid',now(),now()),
    (uB,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','sb@test.invalid',now(),now()),
    (uC,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','sc@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values
    (uA,'sa@test.invalid','A','admin',true),(uB,'sb@test.invalid','B','bar',true),(uC,'sc@test.invalid','C','client',true)
  on conflict (id) do update set role = excluded.role, active = true;
  insert into public.wp_access (event_id,email,user_id) values (ev,'sc@test.invalid',uC);

  -- G1 grants
  if not has_function_privilege('anon', 'public.wp_admin_guests(integer)'::regprocedure, 'execute')
     and not has_function_privilege('anon', 'public.wp_admin_set_numbers(integer,integer,integer,integer,integer)'::regprocedure, 'execute')
     and not has_function_privilege('anon', 'public.wp_admin_all_numbers()'::regprocedure, 'execute')
     and not has_function_privilege('anon', 'public.wp_admin_event_suppliers(integer)'::regprocedure, 'execute')
     and not has_function_privilege('authenticated', 'public.wp_is_admin()'::regprocedure, 'execute')
  then passes:=passes+1; else fails:=fails||text 'G1 grants'; end if;

  -- client writes a guest the normal way
  perform set_config('request.jwt.claims', json_build_object('sub',uC,'email','sc@test.invalid')::text, true);
  insert into wp_guests (event_id, list, first_name, last_name, role, access_needs, age_band)
  values (ev, 'seated', 'Ben', 'Young', 'Best man', 'nut allergy', 'adult');

  -- A1 client and bar refused the list; client refused staff numbers
  r := wp_admin_guests(ev);
  if r->>'error' = 'not_admin' then passes:=passes+1; else fails:=fails||text 'A1 client read guests'; end if;
  r := wp_admin_set_numbers(ev, 1, 0, 0, 0);
  if r->>'error' = 'not_staff' then passes:=passes+1; else fails:=fails||text 'A2 client set numbers'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub',uB,'email','sb@test.invalid')::text, true);
  r := wp_admin_guests(ev);
  if r->>'error' = 'not_admin' then passes:=passes+1; else fails:=fails||text 'A3 bar login read guests'; end if;
  r := wp_admin_event_suppliers(ev);
  if (r->>'ok')::bool then passes:=passes+1; else fails:=fails||('A4 bar cannot read suppliers '||r::text); end if;

  -- N1 admin sets numbers
  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','sa@test.invalid')::text, true);
  r := wp_admin_set_numbers(ev, 80, 6, 2, 40);
  if (r->>'ok')::bool and exists (select 1 from wp_guest_numbers where event_id = ev and seated_adults = 80 and evening_extras = 40)
     and exists (select 1 from wp_change_log where event_id = ev and area = 'guests' and summary like 'venue set numbers: 80 adults%')
  then passes:=passes+1; else fails:=fails||('N1 '||r::text); end if;
  r := wp_admin_set_numbers(ev, -1, 0, 0, 0);
  if r->>'error' = 'negative' then passes:=passes+1; else fails:=fails||text 'N2 negative accepted'; end if;
  r := wp_admin_set_numbers(-999, 1, 0, 0, 0);
  if r->>'error' = 'not_found' then passes:=passes+1; else fails:=fails||text 'N3 unknown event accepted'; end if;

  r := wp_admin_guests(ev);
  if (r->'numbers'->>'seated_total')::int = 88 and (r->'numbers'->>'evening_total')::int = 128
     and jsonb_array_length(r->'guests') = 1 and r->'guests'->0->>'role' = 'Best man'
     and r->'guests'->0->>'access_needs' = 'nut allergy'
  then passes:=passes+1; else fails:=fails||('G2 admin read '||r::text); end if;

  -- L1 all-events totals
  r := wp_admin_all_numbers();
  if (r->'numbers'->(ev::text)->>'seated')::int = 88 and (r->'numbers'->(ev::text)->>'evening')::int = 128
  then passes:=passes+1; else fails:=fails||text 'L1 all numbers'; end if;

  -- N4 the client's own tab sees what staff set
  perform set_config('request.jwt.claims', json_build_object('sub',uC,'email','sc@test.invalid')::text, true);
  r := wp_get_guests();
  if (r->'numbers'->>'seated_adults')::int = 80 and (r->'derived'->>'evening_total')::int = 128
  then passes:=passes+1; else fails:=fails||text 'N4 client does not see staff numbers'; end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails, ' | ');
  end if;
end
$t$;
