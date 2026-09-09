-- supabase/portal-room-doors-text-test.sql
--
-- Assertions for 2026-09-09-portal-room-doors-text-table-size.sql. Seven.
--
-- Note the shape: they set the JWT claims to a REAL active admin read out of
-- profiles. A block with no claims makes auth.uid() null, is_staff() false, and
-- every one of these functions correctly answers not_staff — which reads as a
-- failure and is not. Anything testing is_staff() has to supply an identity.
--
-- Rolled back, so the test room does not persist.
--
--     ERROR: ALL 7 ASSERTIONS PASSED (rolled back)     <- what you want
--
-- Last run 9 September 2026: all 7 passed.

do $t$
declare
  r jsonb; fails text[] := '{}'; passes int := 0;
  uAdmin uuid; v_room uuid;
begin
  select id into uAdmin from public.profiles where active and role='admin' order by id limit 1;
  if uAdmin is null then raise exception 'no active admin to test with'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', uAdmin)::text, true);

  -- 1. The in-place patch took. Without it the portal draws every table at
  --    1830 × 760 whatever the room says, and silently.
  if (select position('chair_depth_mm' in pg_get_functiondef(p.oid)) > 0
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='wp_get_layout') then passes:=passes+1;
  else fails := fails || 'FAIL 1: wp_get_layout still hardcodes the table size'; end if;

  -- 2. Exactly ONE upsert. Adding parameters makes an overload, and two
  --    overloads whose arguments all have defaults make every call ambiguous —
  --    PostgREST would start failing on a function that looks fine here.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='wp_admin_upsert_room') = 1 then passes:=passes+1;
  else fails := fails || 'FAIL 2: wp_admin_upsert_room is overloaded'; end if;

  -- 3. The measurements round-trip
  r := wp_admin_upsert_room(null, 'Test barn', 10000, 8000, '[]'::jsonb, false, 2400, 900, 500, 600);
  v_room := (r->>'id')::uuid;
  r := wp_admin_rooms();
  if (select count(*) from jsonb_array_elements(r->'rooms') e
       where (e->>'id')::uuid = v_room
         and (e->>'table_length_mm')::int = 2400 and (e->>'table_depth_mm')::int = 900
         and (e->>'chair_depth_mm')::int = 500 and (e->>'clearance_mm')::int = 600) = 1
  then passes:=passes+1;
  else fails := fails || 'FAIL 3: measurements did not round-trip'; end if;

  -- 4. A nonsense measurement is refused. A 40mm table is a typo, and a plan
  --    drawn from one is worse than no plan.
  r := wp_admin_upsert_room(v_room, null, null, null, null, null, 40, null, null, null);
  if not (r->>'ok')::bool and r->>'error' = 'measurement_out_of_range' then passes:=passes+1;
  else fails := fails || ('FAIL 4: a 40mm table was accepted: ' || coalesce(r::text,'null')); end if;

  -- 5. ...and the refusal wrote nothing. A validation that half-applies is
  --    worse than one that does not exist.
  if (select table_length_mm from wp_rooms where id = v_room) = 2400 then passes:=passes+1;
  else fails := fails || 'FAIL 5: the refused call still wrote'; end if;

  -- 6. Doors and text store, and a door keeps its swing
  r := wp_admin_upsert_room(v_room, null, null, null,
        '[{"kind":"door","label":"Main","x":1000,"y":0,"w":900,"h":900,"hinge":3},
          {"kind":"text","label":"Stage end","x":500,"y":500,"w":2000,"h":300}]'::jsonb,
        null, null, null, null, null);
  if (r->>'ok')::bool
     and (select shapes->0->>'kind' from wp_rooms where id=v_room) = 'door'
     and (select (shapes->0->>'hinge')::int from wp_rooms where id=v_room) = 3
     and (select shapes->1->>'kind' from wp_rooms where id=v_room) = 'text'
  then passes:=passes+1;
  else fails := fails || 'FAIL 6: doors and text did not store'; end if;

  -- 7. shapes must still be an array
  r := wp_admin_upsert_room(v_room, null, null, null, '{"kind":"door"}'::jsonb, null, null, null, null, null);
  if not (r->>'ok')::bool and r->>'error' = 'shapes_not_an_array' then passes:=passes+1;
  else fails := fails || 'FAIL 7: a bare object was accepted as shapes'; end if;

  perform set_config('request.jwt.claims', null, true);

  if array_length(fails,1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails,' | ');
  end if;
end $t$;


-- ── Checking this file against the live catalogue ───────────────────────────
--
-- The house rule is to checksum a migration file against pg_get_functiondef.
-- That comparison DOES NOT WORK for a function with parameters: Postgres prints
-- `p_id uuid DEFAULT NULL::uuid` where the file says `p_id uuid default null`,
-- so wp_admin_upsert_room reads 80 characters longer in the catalogue than in
-- the file — ten parameters, eight characters each — and nothing is wrong.
--
-- Compare the BODY and the SIGNATURE separately instead:
--
--   select md5(trim(regexp_replace(prosrc, '\s+', ' ', 'g'))),
--          pg_get_function_arguments(p.oid)
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'wp_admin_upsert_room';
--
-- On 9 September 2026 the body was md5 57832a5e79ee7de24baf7053842f650d,
-- 1928 characters normalised, matching this file exactly.

select p.proname,
       has_function_privilege('anon',          p.oid, 'execute') as anon_expected_false,
       has_function_privilege('authenticated', p.oid, 'execute') as authed_expected_true,
       md5(trim(regexp_replace(p.prosrc, '\s+', ' ', 'g')))       as body_md5
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('wp_admin_rooms', 'wp_admin_upsert_room', 'wp_get_layout')
order by p.proname;
