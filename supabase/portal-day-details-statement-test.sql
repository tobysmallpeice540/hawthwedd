-- supabase/portal-day-details-statement-test.sql
--
-- Assertions for 2026-10-23g-day-details-statement.sql. Rolled back; the
-- result arrives as an exception:  ERROR: ALL n ASSERTIONS PASSED (rolled back)
--
--   G1  no new function is callable by anon
--   Q1  the new venue-form questions exist and the client form accepts them
--   K1  a client adds, changes and removes their own key contacts; another
--       event's contact cannot be changed or removed by id
--   D1  staff read the day details; a client cannot
--   S1  staff publish a schedule; the client reads only their own, field by
--       field; a republish replaces it; a client cannot publish

do $t$
declare
  uA uuid := '00000000-0000-4000-8000-0000000000e1';   -- admin
  uB uuid := '00000000-0000-4000-8000-0000000000e2';   -- bar
  uC uuid := '00000000-0000-4000-8000-0000000000e3';   -- client of ev
  uD uuid := '00000000-0000-4000-8000-0000000000e4';   -- client of ev2
  ev int; ev2 int; r jsonb; cid uuid; cid2 uuid; fails text[] := '{}'; passes int := 0;
begin
  select (e->>'id')::int into ev from app_data x, lateral jsonb_array_elements(x.value) e
   where x.key='hawthbush_bookings_v6' and (e->>'id') ~ '^\d+$'
     and not exists (select 1 from wp_access a where a.event_id = (e->>'id')::int)
   order by e->>'date' desc limit 1;
  select (e->>'id')::int into ev2 from app_data x, lateral jsonb_array_elements(x.value) e
   where x.key='hawthbush_bookings_v6' and (e->>'id') ~ '^\d+$' and (e->>'id')::int <> ev
     and not exists (select 1 from wp_access a where a.event_id = (e->>'id')::int)
   order by e->>'date' desc limit 1;

  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
    (uA,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','ta@test.invalid',now(),now()),
    (uB,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','tb@test.invalid',now(),now()),
    (uC,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','tc@test.invalid',now(),now()),
    (uD,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','td@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values
    (uA,'ta@test.invalid','A','admin',true),(uB,'tb@test.invalid','B','bar',true),
    (uC,'tc@test.invalid','C','client',true),(uD,'td@test.invalid','D','client',true)
  on conflict (id) do update set role = excluded.role, active = true;
  insert into public.wp_access (event_id,email,user_id) values (ev,'tc@test.invalid',uC),(ev2,'td@test.invalid',uD);

  -- G1 grants
  if not has_function_privilege('anon', 'public.wp_get_key_contacts()'::regprocedure, 'execute')
     and not has_function_privilege('anon', 'public.wp_save_key_contact(uuid,text,text,text,text)'::regprocedure, 'execute')
     and not has_function_privilege('anon', 'public.wp_delete_key_contact(uuid)'::regprocedure, 'execute')
     and not has_function_privilege('anon', 'public.wp_admin_day_details(integer)'::regprocedure, 'execute')
     and not has_function_privilege('anon', 'public.wp_admin_publish_schedule(jsonb)'::regprocedure, 'execute')
     and not has_function_privilege('anon', 'public.wp_my_statement()'::regprocedure, 'execute')
     and has_function_privilege('authenticated', 'public.wp_my_statement()'::regprocedure, 'execute')
     and not has_table_privilege('authenticated', 'public.wp_key_contacts', 'select')
     and not has_table_privilege('authenticated', 'public.wp_payment_schedule', 'select')
  then passes:=passes+1; else fails:=fails||text 'G1 grants'; end if;

  -- Q1 questions exist and the client's form keeps the new answers
  if (select count(*) from wp_venue_form_questions where qkey in
        ('officiant_name','officiant_contact','ceremony_location','wet_weather_location',
         'dropoff_date','dropoff_time','collect_date','collect_time')) = 8
  then passes:=passes+1; else fails:=fails||text 'Q1 questions'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub',uC,'email','tc@test.invalid')::text, true);
  r := wp_save_venue_form('{"officiant_name":"Jo Registrar","dropoff_date":"2027-06-02","dropoff_time":"14:00"}'::jsonb);
  if (r->>'saved')::int = 3 then passes:=passes+1; else fails:=fails||('Q2 save '||r::text); end if;
  -- a partial save merges, it does not wipe the others
  r := wp_save_venue_form('{"collect_date":"2027-06-04"}'::jsonb);
  if (select answers->>'officiant_name' = 'Jo Registrar' and answers->>'collect_date' = '2027-06-04'
        from wp_venue_form where event_id = ev)
  then passes:=passes+1; else fails:=fails||text 'Q3 merge'; end if;

  -- K1 key contacts
  r := wp_save_key_contact(null, '  Sam Usher ', 'Best man', '07700 900123', 'Has the rings');
  cid := (r->>'id')::uuid;
  r := wp_save_key_contact(null, '', null, null, null);
  if cid is not null and r->>'error' = 'no_name' then passes:=passes+1; else fails:=fails||('K1 add '||r::text); end if;
  r := wp_save_key_contact(cid, 'Sam Usher', 'Best man', '07700 900999', null);
  r := wp_get_key_contacts();
  if jsonb_array_length(r->'contacts') = 1 and r->'contacts'->0->>'name' = 'Sam Usher'
     and r->'contacts'->0->>'phone' = '07700 900999' and r->'contacts'->0->>'note' is null
  then passes:=passes+1; else fails:=fails||('K2 read '||r::text); end if;

  -- another couple cannot touch it
  perform set_config('request.jwt.claims', json_build_object('sub',uD,'email','td@test.invalid')::text, true);
  r := wp_save_key_contact(cid, 'Hijacked', null, null, null);
  if r->>'error' = 'not_found' then passes:=passes+1; else fails:=fails||('K3 cross-event update '||r::text); end if;
  r := wp_delete_key_contact(cid);
  if r->>'error' = 'not_found' and exists (select 1 from wp_key_contacts where id = cid and name = 'Sam Usher')
  then passes:=passes+1; else fails:=fails||('K4 cross-event delete '||r::text); end if;
  r := wp_get_key_contacts();
  if jsonb_array_length(r->'contacts') = 0 then passes:=passes+1; else fails:=fails||text 'K5 sees other contacts'; end if;
  r := wp_save_key_contact(null, 'Other', null, null, null);
  cid2 := (r->>'id')::uuid;

  -- D1 day details: staff yes (bar too), client no
  r := wp_admin_day_details(ev);
  if r->>'error' = 'not_staff' then passes:=passes+1; else fails:=fails||text 'D1 client read day details'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub',uB,'email','tb@test.invalid')::text, true);
  r := wp_admin_day_details(ev);
  if (r->>'ok')::bool and r->'answers'->>'officiant_name' = 'Jo Registrar'
     and jsonb_array_length(r->'contacts') = 1 and r->'contacts'->0->>'role' = 'Best man'
     and jsonb_array_length(r->'questions') >= 8
  then passes:=passes+1; else fails:=fails||('D2 staff read '||r::text); end if;

  -- S1 schedule
  perform set_config('request.jwt.claims', json_build_object('sub',uC,'email','tc@test.invalid')::text, true);
  r := wp_admin_publish_schedule(jsonb_build_array(jsonb_build_object('event_id', ev, 'rows', '[]'::jsonb)));
  if r->>'error' = 'not_admin' then passes:=passes+1; else fails:=fails||text 'S1 client published'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub',uB,'email','tb@test.invalid')::text, true);
  r := wp_admin_publish_schedule(jsonb_build_array(jsonb_build_object('event_id', ev, 'rows', '[]'::jsonb)));
  if r->>'error' = 'not_admin' then passes:=passes+1; else fails:=fails||text 'S1b bar login published'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','ta@test.invalid')::text, true);
  r := wp_admin_publish_schedule(jsonb_build_array(
    jsonb_build_object('event_id', ev, 'rows', jsonb_build_array(
      jsonb_build_object('label','Final balance','due_on','2027-05-06','amount', 1234.5,
                         'lines', jsonb_build_array(jsonb_build_object('desc','Venue fee (50%)','amount',1500,'secret','x'),
                                                    jsonb_build_object('desc','Less deposit','amount',-265.5)),
                         'internal','do not show'),
      jsonb_build_object('label','Damage deposit (refundable)','due_on','2027-05-06','amount', 250, 'refundable', true),
      jsonb_build_object('label','Zero','amount', 0),
      jsonb_build_object('label','Junk','amount', 'abc'))),
    jsonb_build_object('event_id', ev2, 'rows', jsonb_build_array(jsonb_build_object('label','Second payment','due_on','2026-12-01','amount', 99))),
    jsonb_build_object('event_id', -5, 'rows', '[]'::jsonb),
    jsonb_build_object('event_id', ev, 'rows', 'nope')));
  if (r->>'ok')::bool and (r->>'events')::int = 2 and (r->>'rows')::int = 3 and jsonb_array_length(r->'skipped') = 2
  then passes:=passes+1; else fails:=fails||('S2 publish '||r::text); end if;
  -- the last entry for ev was skipped, so ev keeps the two good rows from the first
  if (select count(*) from wp_payment_schedule where event_id = ev) = 2
  then passes:=passes+1; else fails:=fails||text 'S3 rows kept'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub',uC,'email','tc@test.invalid')::text, true);
  r := wp_my_statement();
  if (r->>'ok')::bool and jsonb_array_length(r->'schedule') = 2
     and (r->'schedule'->0->>'amount')::numeric = 1234.50
     and not (r->'schedule'->0 ? 'internal') and not (r->'schedule'->0 ? 'event_id')
     and not (r->'schedule'->0->'lines'->0 ? 'secret')
     and (r->'schedule'->0->'lines'->1->>'amount')::numeric = -265.50
     and (r->'schedule'->1->>'refundable')::bool
     and r::text not like '%Second payment%'
  then passes:=passes+1; else fails:=fails||('S4 client read '||r::text); end if;

  -- republish replaces; an empty list clears
  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','ta@test.invalid')::text, true);
  r := wp_admin_publish_schedule(jsonb_build_array(jsonb_build_object('event_id', ev, 'rows', '[]'::jsonb)));
  if not exists (select 1 from wp_payment_schedule where event_id = ev)
     and exists (select 1 from wp_payment_schedule where event_id = ev2)
  then passes:=passes+1; else fails:=fails||text 'S5 clear'; end if;

  -- anon (no claims) reads nothing
  perform set_config('request.jwt.claims', '{}', true);
  r := wp_my_statement();
  if r->>'error' = 'no_access' then passes:=passes+1; else fails:=fails||text 'S6 no-claims read'; end if;

  if array_length(fails, 1) > 0 then
    raise exception 'FAILED % of %: %', array_length(fails, 1), passes + array_length(fails, 1), array_to_string(fails, ' | ');
  end if;
  raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
end $t$;
