-- supabase/portal-layout-presets-test.sql
--
-- Assertions for 2026-09-13-portal-layout-presets.sql. Twelve.
--
-- ASSERTION 5 IS THE ONE TO READ. Loading a layout replaces every table the
-- wedding has, so anybody already sitting at one loses their seat. That is
-- unavoidable — the table ceases to exist — but it must never be silent, so the
-- function returns how many it unseated AND their names.
--
-- It is the same rule as the "one side only" tick, which evicts three guests
-- and names them. Quietly dropping people off a table plan is the family of
-- failure this project has had four times.
--
-- ASSERTION 11 is the other: deleting a suggestion cannot disturb a wedding
-- that used it, because loading COPIES the tables in rather than pointing at
-- them. That is the reason a preset is stored as plain positions and not as
-- rows in wp_layout_tables.
--
-- Rolled back.
--
--     ERROR: ALL 12 ASSERTIONS PASSED (rolled back)     <- what you want
--
-- Last run 13 September 2026: all 12 passed.

do $t$
declare
  r jsonb; fails text[] := '{}'; passes int := 0;
  uAdmin uuid; uX uuid := '00000000-0000-4000-8000-0000000000f7'; uY uuid := '00000000-0000-4000-8000-0000000000f8';
  evX int; evY int; pid uuid; gid uuid; tid uuid; otherRoom uuid;
begin
  select id into uAdmin from public.profiles where active and role='admin' order by id limit 1;
  if uAdmin is null then raise exception 'no active admin to test with'; end if;
  select min((e->>'id')::int), max((e->>'id')::int) into evX, evY
    from app_data d, lateral jsonb_array_elements(d.value) e where d.key='hawthbush_bookings_v6';
  insert into auth.users (id,instance_id,aud,role,email,created_at,updated_at) values
    (uX,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','px@test.invalid',now(),now()),
    (uY,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','py@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values
    (uX,'px@test.invalid','X','client',true),(uY,'py@test.invalid','Y','client',true)
  on conflict (id) do update set role='client', active=true;
  insert into public.wp_access (event_id,email,user_id) values (evX,'px@test.invalid',uX),(evY,'py@test.invalid',uY);

  perform set_config('request.jwt.claims', json_build_object('sub', uAdmin)::text, true);

  -- 1. Seats are counted, and a one-side top table counts three, not six
  r := wp_admin_save_preset(null, 'Long tables for 15', null,
        '[{"x_mm":3000,"y_mm":3000,"rotation":0,"one_side":false},
          {"x_mm":4830,"y_mm":3000,"rotation":0,"one_side":false},
          {"x_mm":3000,"y_mm":6000,"rotation":0,"one_side":true}]'::jsonb);
  pid := (r->>'id')::uuid;
  r := wp_admin_presets();
  if (select (e->>'seats')::int from jsonb_array_elements(r->'presets') e where (e->>'id')::uuid = pid) = 15
  then passes:=passes+1; else fails := fails || ('FAIL 1: seats wrong: ' || coalesce(r::text,'null')); end if;

  -- 2. A new layout needs a name — a couple chooses by it
  if (wp_admin_save_preset(null, '  ', null, '[]'::jsonb) ->> 'error') = 'needs_name'
  then passes:=passes+1; else fails := fails || 'FAIL 2: an unnamed layout was saved'::text; end if;

  perform set_config('request.jwt.claims', json_build_object('sub',uX,'email','px@test.invalid')::text, true);

  -- 3. The couple sees it and what it seats — but NOT Toby's private note
  r := wp_get_presets();
  if (select count(*) from jsonb_array_elements(r->'presets') e
       where (e->>'id')::uuid = pid and (e->>'seats')::int = 15 and not (e ? 'note')) = 1
  then passes:=passes+1; else fails := fails || ('FAIL 3: ' || coalesce(r::text,'null')); end if;

  -- Seat somebody, so loading has something to disturb.
  r := wp_add_table(1000,1000,'Old table'); tid := (r->>'id')::uuid;
  r := wp_add_guest('seated','Ada','Lovelace',null,'adult',false,null,null); gid := (r->>'id')::uuid;
  perform wp_set_guest_table(gid, tid);

  -- 4. Loading replaces every table
  r := wp_load_preset(pid);
  if (r->>'ok')::bool and (r->>'tables')::int = 3
     and (select count(*) from wp_layout_tables where event_id = evX) = 3
     and not exists (select 1 from wp_layout_tables where id = tid)
  then passes:=passes+1; else fails := fails || ('FAIL 4: ' || coalesce(r::text,'null')); end if;

  -- 5. ── THE ONE THAT MATTERS ── it says who it unseated, by name
  if (r->>'unseated')::int = 1 and (r->'unseated_names')::text like '%Ada Lovelace%'
  then passes:=passes+1; else fails := fails || ('FAIL 5: ' || coalesce(r::text,'null')); end if;

  -- 6. ...and nobody is deleted; they are back on the unassigned list
  if (select count(*) from wp_guests where id = gid and table_id is null) = 1
  then passes:=passes+1; else fails := fails || 'FAIL 6: a guest was lost, not unseated'::text; end if;

  -- 7. The one-side tick survives the round trip, or the top table silently
  --    gains three seats nobody can sit in
  if (select count(*) from wp_layout_tables where event_id = evX and one_side) = 1
  then passes:=passes+1; else fails := fails || 'FAIL 7: the top table lost its one-side tick'::text; end if;

  -- 8. Loading again is harmless and reports nobody unseated
  r := wp_load_preset(pid);
  if (r->>'ok')::bool and (r->>'unseated')::int = 0
  then passes:=passes+1; else fails := fails || 'FAIL 8: a second load misreported'::text; end if;

  -- 9. A layout for another room is neither offered nor loadable
  perform set_config('request.jwt.claims', json_build_object('sub', uAdmin)::text, true);
  insert into wp_rooms (name, active) values ('Somewhere else', false) returning id into otherRoom;
  r := wp_admin_save_preset(null, 'Elsewhere', null, '[]'::jsonb, otherRoom);
  perform set_config('request.jwt.claims', json_build_object('sub',uX,'email','px@test.invalid')::text, true);
  if (select count(*) from jsonb_array_elements(wp_get_presets()->'presets') e
       where e->>'name' = 'Elsewhere') = 0
     and (wp_load_preset((r->>'id')::uuid) ->> 'error') = 'not_found'
  then passes:=passes+1; else fails := fails || 'FAIL 9: another room''s layout was reachable'::text; end if;

  -- 10. A couple cannot create, change or delete a suggestion
  if (wp_admin_presets() ->> 'error') = 'not_staff'
     and (wp_admin_save_preset(null,'Mine',null,'[]'::jsonb) ->> 'error') = 'not_staff'
     and (wp_admin_delete_preset(pid) ->> 'error') = 'not_staff'
  then passes:=passes+1; else fails := fails || 'FAIL 10: a client reached the layouts'::text; end if;

  -- 11. ── THE OTHER ONE ── deleting a suggestion does not disturb a wedding
  --     that used it. Loading COPIES the tables in; the wedding owns its own.
  perform set_config('request.jwt.claims', json_build_object('sub', uAdmin)::text, true);
  r := wp_admin_delete_preset(pid);
  if (r->>'ok')::bool and (select count(*) from wp_layout_tables where event_id = evX) = 3
  then passes:=passes+1; else fails := fails || 'FAIL 11: deleting a layout took a wedding''s tables'::text; end if;

  perform set_config('request.jwt.claims', null, true);

  -- 12. Grants
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname in ('wp_get_presets','wp_load_preset','wp_admin_presets',
                                                  'wp_admin_save_preset','wp_admin_delete_preset')
         and has_function_privilege('anon', p.oid, 'execute')) = 0
  then passes:=passes+1; else fails := fails || 'FAIL 12: anon grant'::text; end if;

  if array_length(fails,1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails,' | ');
  end if;
end $t$;


-- ── Checking this file against the live catalogue ───────────────────────────
-- Compare the BODY, not pg_get_functiondef. Bodies on 13 September 2026:
--   wp_get_presets          0951abbc8afb82a4f23c383dc5d3ea65   715
--   wp_load_preset          60a777a80b4671e2c64e6c3e77de8eb4  1669
--   wp_admin_presets        3d6b13bb77a9e4adce298fadc33da832   545
--   wp_admin_save_preset    964eb7f55cefb16ff334d1797bf02c70  1572
--   wp_admin_delete_preset  b615ac3a8ff30df254e5b64bb8227197   461
