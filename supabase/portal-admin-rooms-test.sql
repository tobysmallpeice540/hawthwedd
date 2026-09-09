-- supabase/portal-admin-rooms-test.sql
--
-- Assertions for wp_admin_rooms(). Four, and all of them are about who is
-- asking rather than what comes back — the room is shared scenery, so the only
-- way to get this wrong is to let the wrong person read or redraw it.
--
-- Note the shape of assertion 1: it sets the JWT claims to a REAL active admin
-- read out of profiles. Running the block with no claims at all makes
-- auth.uid() null, is_staff() false, and the function correctly answers
-- not_staff — which looks like a failure and is not. Anything testing
-- is_staff() has to supply an identity.
--
-- Rolled back, so the fake client account it creates does not persist.
--
--     ERROR: ALL 4 ASSERTIONS PASSED (rolled back)     <- what you want
--
-- Last run 9 September 2026: all 4 passed.

do $t$
declare
  r jsonb; fails text[] := '{}'; passes int := 0;
  uAdmin uuid; uC uuid := '00000000-0000-4000-8000-00000000000c';
begin
  select id into uAdmin from public.profiles where active and role = 'admin' order by id limit 1;
  if uAdmin is null then raise exception 'no active admin to test with'; end if;

  -- 1. A real member of staff gets the list, and is told which room is live.
  --    live_room_id is the whole point: wp_get_layout() takes the oldest active
  --    room, so without it somebody edits a second room and sees no effect.
  perform set_config('request.jwt.claims', json_build_object('sub', uAdmin)::text, true);
  r := wp_admin_rooms();
  if (r->>'ok')::bool and r ? 'rooms' and r ? 'live_room_id' then passes:=passes+1;
  else fails := fails || ('FAIL 1: staff got ' || coalesce(r::text,'null')); end if;

  -- 2. A wedding client cannot read the room list
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  values (uC,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','rooms@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active)
  values (uC,'rooms@test.invalid','C','client',true)
  on conflict (id) do update set role='client', active=true;

  perform set_config('request.jwt.claims', json_build_object('sub',uC)::text, true);
  r := wp_admin_rooms();
  if not (r->>'ok')::bool and r->>'error' = 'not_staff' then passes:=passes+1;
  else fails := fails || 'FAIL 2: a client could list rooms'; end if;

  -- 3. ...nor redraw the barn. The couple arranges tables; they do not move
  --    the bar, and nothing in the portal should let them try.
  r := wp_admin_upsert_room(null, 'Sneaky', 5000, 5000, '[]'::jsonb, true);
  if not (r->>'ok')::bool and r->>'error' = 'not_staff' then passes:=passes+1;
  else fails := fails || 'FAIL 3: a client could create a room'; end if;
  perform set_config('request.jwt.claims', null, true);

  -- 4. Not callable by anon at all
  if has_function_privilege('anon','public.wp_admin_rooms()','execute') then
    fails := fails || 'FAIL 4: anon can execute wp_admin_rooms()';
  else passes:=passes+1; end if;

  if array_length(fails,1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails,' | ');
  end if;
end $t$;


-- ── Grant surface ───────────────────────────────────────────────────────────
-- Expected: anon false, authenticated true (the function does its own
-- is_staff() check), service_role true.

select p.proname,
       has_function_privilege('anon',          p.oid, 'execute') as anon_expected_false,
       has_function_privilege('authenticated', p.oid, 'execute') as authed_expected_true,
       has_function_privilege('service_role',  p.oid, 'execute') as svc_expected_true
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('wp_admin_rooms', 'wp_admin_upsert_room')
order by p.proname;
