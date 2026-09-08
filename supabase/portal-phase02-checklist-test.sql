-- supabase/portal-phase02-checklist-test.sql
--
-- Fifteen assertions for the checklist.
--
-- The ones to care about: 6 and 7 prove a couple cannot edit or delete a venue
-- deadline, and 13 proves one couple cannot tick another couple's item by
-- passing its id. 1-3 prove the seeding works and does not run twice.
--
-- Rolled back at the end, so the fake couples and their seeded lists do not
-- persist. The result arrives as an exception, by design:
--
--     ERROR: ALL 15 ASSERTIONS PASSED (rolled back)
--
-- Last run 8 September 2026: all 15 passed.

do $t$
declare
  uA uuid := '00000000-0000-4000-8000-00000000000a';
  uB uuid := '00000000-0000-4000-8000-00000000000b';
  evA int; evB int; r jsonb; venue_id uuid; own_id uuid; wdate date;
  fails text[] := '{}'; passes int := 0;
begin
  select (e->>'id')::int, (e->>'date')::date into evA, wdate
    from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key='hawthbush_bookings_v6' and nullif(e->>'date','') is not null
   order by (e->>'date')::date desc limit 1;
  select min((e->>'id')::int) into evB
    from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key='hawthbush_bookings_v6' and (e->>'id')::int <> evA;

  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
    (uA,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','a@test.invalid',now(),now()),
    (uB,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','b@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values
    (uA,'a@test.invalid','A','client',true),(uB,'b@test.invalid','B','client',true)
  on conflict (id) do update set role='client';
  insert into public.wp_access (event_id,email,user_id) values (evA,'a@test.invalid',uA),(evB,'b@test.invalid',uB);

  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','a@test.invalid')::text, true);

  -- 1  first read seeds the venue items
  r := wp_get_checklist();
  if (r->>'ok')::bool and jsonb_array_length(r->'items') = 9 then passes:=passes+1;
  else fails:=fails||('1 seed: '||coalesce(jsonb_array_length(r->'items')::text,'null')); end if;

  -- 2  due dates are computed backwards from the wedding date
  select (i->>'id')::uuid into venue_id from jsonb_array_elements(r->'items') i
   where i->>'title' = 'Confirm your final numbers';
  if exists (select 1 from wp_checklist where id = venue_id and due_on = wdate - 28) then passes:=passes+1;
  else fails:=fails||'2 due date offset wrong'; end if;

  -- 3  seeding does not run twice
  r := wp_get_checklist();
  if jsonb_array_length(r->'items') = 9 then passes:=passes+1; else fails:=fails||'3 double-seeded'; end if;

  -- 4  a venue item CAN be ticked
  r := wp_set_task_done(venue_id, true);
  if (r->>'ok')::bool then passes:=passes+1; else fails:=fails||'4 cannot tick venue item'; end if;

  -- 5  progress reflects it
  r := wp_get_checklist();
  if (r->'progress'->>'done')::int = 1 and (r->'progress'->>'total')::int = 9 then passes:=passes+1;
  else fails:=fails||'5 progress'; end if;

  -- 6  but a venue item CANNOT be edited
  r := wp_update_task(venue_id, 'Whenever suits us');
  if not (r->>'ok')::bool and r->>'error'='locked' then passes:=passes+1;
  else fails:=fails||('6 EDITED A LOCKED ITEM: '||r::text); end if;

  -- 7  nor deleted
  r := wp_delete_task(venue_id);
  if not (r->>'ok')::bool and r->>'error'='locked' then passes:=passes+1;
  else fails:=fails||('7 DELETED A LOCKED ITEM: '||r::text); end if;

  -- 8-10  their own items are fully theirs
  r := wp_add_task('Book a cake tasting', (wdate - 90)::date);
  own_id := (r->>'id')::uuid;
  if (r->>'ok')::bool then passes:=passes+1; else fails:=fails||'8 add own'; end if;

  r := wp_update_task(own_id, 'Book two cake tastings');
  if (r->>'ok')::bool then passes:=passes+1; else fails:=fails||'9 edit own'; end if;

  r := wp_delete_task(own_id);
  if (r->>'ok')::bool then passes:=passes+1; else fails:=fails||'10 delete own'; end if;

  -- 11  a blank title is refused
  r := wp_add_task('   ');
  if not (r->>'ok')::bool and r->>'error'='no_title' then passes:=passes+1; else fails:=fails||'11 blank title'; end if;

  -- 12  a client cannot use the admin view
  r := wp_admin_checklist(evA);
  if not (r->>'ok')::bool and r->>'error'='not_staff' then passes:=passes+1; else fails:=fails||'12 admin leak'; end if;

  -- ===== the other couple =====
  perform set_config('request.jwt.claims', json_build_object('sub',uB,'email','b@test.invalid')::text, true);

  -- 13  B CANNOT TICK A'S ITEM BY ID
  r := wp_set_task_done(venue_id, false);
  if not (r->>'ok')::bool and r->>'error'='not_found' then passes:=passes+1;
  else fails:=fails||('13 B TICKED ANOTHER COUPLE''S ITEM: '||r::text); end if;

  -- 14  B gets their own seeded list, untouched by A
  r := wp_get_checklist();
  if jsonb_array_length(r->'items') = 9 and (r->'progress'->>'done')::int = 0 then passes:=passes+1;
  else fails:=fails||('14 B list wrong: '||(r->'progress')::text); end if;

  -- 15  and A's tick survived
  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','a@test.invalid')::text, true);
  r := wp_get_checklist();
  if (r->'progress'->>'done')::int = 1 then passes:=passes+1; else fails:=fails||'15 A tick lost'; end if;

  if array_length(fails,1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails,' | ');
  end if;
end $t$;
