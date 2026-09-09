-- supabase/portal-accommodation-test.sql
--
-- Assertions for 2026-09-09-portal-accommodation-capacity.sql. Ten.
--
-- ASSERTION 4 IS THE ONE THAT MATTERS: another wedding's guests must not reach
-- this count. It is a bare number on a screen, so a leak here would not look
-- like a leak — it would look like the couple having miscounted their own
-- guests, and nobody would ever question it.
--
-- Assertion 2 is the one that catches a plausible mistake: allocated counts
-- BOTH lists. An evening guest who stays over occupies a bed exactly as a
-- seated one does, and counting only the seated list would under-report the
-- very thing the panel exists to show — quietly, and in the safe direction,
-- which is the worst kind.
--
-- Rolled back. It changes a live capacity in assertion 7, so the query at the
-- foot proves the seeded numbers came back: Amly 6, Hamlet 14 + 1, glamping 20.
--
--     ERROR: ALL 10 ASSERTIONS PASSED (rolled back)     <- what you want
--
-- Last run 9 September 2026: all 10 passed.

do $t$
declare
  r jsonb; fails text[] := '{}'; passes int := 0;
  uAdmin uuid; uX uuid := '00000000-0000-4000-8000-0000000000e5'; uY uuid := '00000000-0000-4000-8000-0000000000e6';
  evX int; evY int;
begin
  select id into uAdmin from public.profiles where active and role='admin' order by id limit 1;
  if uAdmin is null then raise exception 'no active admin to test with'; end if;
  select min((e->>'id')::int), max((e->>'id')::int) into evX, evY
    from app_data d, lateral jsonb_array_elements(d.value) e where d.key='hawthbush_bookings_v6';
  insert into auth.users (id,instance_id,aud,role,email,created_at,updated_at) values
    (uX,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','ax@test.invalid',now(),now()),
    (uY,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','ay@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values
    (uX,'ax@test.invalid','X','client',true),(uY,'ay@test.invalid','Y','client',true)
  on conflict (id) do update set role='client', active=true;
  insert into public.wp_access (event_id,email,user_id) values (evX,'ax@test.invalid',uX),(evY,'ay@test.invalid',uY);

  perform set_config('request.jwt.claims', json_build_object('sub',uX,'email','ax@test.invalid')::text, true);

  -- 1. The seeded capacities are the ones Toby gave
  r := wp_get_accommodation();
  if (r->>'ok')::bool
     and (select (e->>'sleeps_adults')::int from jsonb_array_elements(r->'places') e where e->>'slug'='amly') = 6
     and (select (e->>'sleeps_adults')::int from jsonb_array_elements(r->'places') e where e->>'slug'='hamlet') = 14
     and (select (e->>'sleeps_children')::int from jsonb_array_elements(r->'places') e where e->>'slug'='hamlet') = 1
     and (select (e->>'sleeps_adults')::int from jsonb_array_elements(r->'places') e where e->>'slug'='camping') = 20
  then passes:=passes+1; else fails := fails || ('FAIL 1: ' || coalesce(r::text,'null')); end if;

  -- 2. Allocation counts both lists, split by age band. An evening guest who
  --    stays over occupies a bed exactly like a seated one.
  perform wp_add_guest('seated','A','Adult',null,'adult',true,null,'hamlet');
  perform wp_add_guest('seated','B','Child',null,'child',true,null,'hamlet');
  perform wp_add_guest('evening','C','Evening',null,'adult',true,null,'hamlet');
  r := wp_get_accommodation();
  if (select (e->>'allocated')::int from jsonb_array_elements(r->'places') e where e->>'slug'='hamlet') = 3
     and (select (e->>'allocated_adults')::int from jsonb_array_elements(r->'places') e where e->>'slug'='hamlet') = 2
     and (select (e->>'allocated_children')::int from jsonb_array_elements(r->'places') e where e->>'slug'='hamlet') = 1
  then passes:=passes+1; else fails := fails || ('FAIL 2: ' || coalesce((r->'places')::text,'null')); end if;

  -- 3. Staying but not yet placed is counted — that is the number that prompts
  --    anybody to finish the job
  perform wp_add_guest('seated','D','Nowhere',null,'adult',true,null,null);
  r := wp_get_accommodation();
  if (r->>'unplaced')::int = 1 then passes:=passes+1;
  else fails := fails || ('FAIL 3: unplaced=' || coalesce(r->>'unplaced','null')); end if;

  -- 4. ── THE ONE THAT MATTERS ── another wedding's guests never reach it
  perform set_config('request.jwt.claims', json_build_object('sub',uY,'email','ay@test.invalid')::text, true);
  perform wp_add_guest('seated','Their','Guest',null,'adult',true,null,'hamlet');
  perform set_config('request.jwt.claims', json_build_object('sub',uX,'email','ax@test.invalid')::text, true);
  r := wp_get_accommodation();
  if (select (e->>'allocated')::int from jsonb_array_elements(r->'places') e where e->>'slug'='hamlet') = 3
  then passes:=passes+1; else fails := fails || 'FAIL 4: another wedding leaked into the count'::text; end if;

  -- 5. Whether it is booked still comes from the diary
  if (select e->>'status' from jsonb_array_elements(r->'places') e where e->>'slug'='amly') is not null
  then passes:=passes+1; else fails := fails || 'FAIL 5: no booking status'::text; end if;

  -- 6. A couple cannot change what anything sleeps
  if (wp_admin_accommodation() ->> 'error') = 'not_staff'
     and (wp_admin_save_accommodation('[]'::jsonb) ->> 'error') = 'not_staff'
  then passes:=passes+1; else fails := fails || 'FAIL 6: a client reached the capacities'::text; end if;

  -- 7. Staff can
  perform set_config('request.jwt.claims', json_build_object('sub', uAdmin)::text, true);
  r := wp_admin_save_accommodation('[{"slug":"amly","sleeps_adults":8}]'::jsonb);
  if (r->>'ok')::bool and (select sleeps_adults from wp_accommodation where slug='amly') = 8
  then passes:=passes+1; else fails := fails || ('FAIL 7: ' || coalesce(r::text,'null')); end if;

  -- 8. An invented place is refused rather than created. It would show as
  --    permanently undecided with nothing to explain why.
  r := wp_admin_save_accommodation('[{"slug":"treehouse","sleeps_adults":2}]'::jsonb);
  if not (r->>'ok')::bool and r->>'error' = 'unknown_place' then passes:=passes+1;
  else fails := fails || 'FAIL 8: an invented place was accepted'::text; end if;

  -- 9. A nonsense capacity is refused, and writes nothing
  r := wp_admin_save_accommodation('[{"slug":"hamlet","sleeps_adults":-4}]'::jsonb);
  if not (r->>'ok')::bool and r->>'error' = 'bad_capacity'
     and (select sleeps_adults from wp_accommodation where slug='hamlet') = 14
  then passes:=passes+1; else fails := fails || 'FAIL 9: a negative capacity was accepted'::text; end if;

  perform set_config('request.jwt.claims', null, true);

  -- 10. Grants
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname in ('wp_get_accommodation','wp_admin_accommodation','wp_admin_save_accommodation')
         and has_function_privilege('anon', p.oid, 'execute')) = 0
  then passes:=passes+1; else fails := fails || 'FAIL 10: anon grant'::text; end if;

  if array_length(fails,1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails,' | ');
  end if;
end $t$;


-- ── RUN THIS AFTERWARDS ─────────────────────────────────────────────────────
-- Assertion 7 changes a live capacity and relies on the exception to undo it.
-- Expected: amly 6/0, hamlet 14/1, camping 20/0.

select slug, label, sleeps_adults, sleeps_children from wp_accommodation order by sort;


-- ── Checking this file against the live catalogue ───────────────────────────
-- Compare the BODY, not pg_get_functiondef. Bodies on 9 September 2026:
--   wp_get_accommodation         b3a45e53e13ef33ac0fc5592ae2703a0  1432
--   wp_admin_accommodation       340c5f6ff154a20235e018f23eaefdf8   362
--   wp_admin_save_accommodation  eeebfaa51fe3fd9dd276a69f06b8d497  1474
