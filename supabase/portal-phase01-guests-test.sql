-- supabase/portal-phase01-guests-test.sql
--
-- Fifteen assertions for the guest numbers and the two name lists.
--
-- Two of them are the point of the whole file: 11 and 12, which prove that one
-- couple cannot edit or delete another couple's guest by passing its id. Every
-- guest-mutating function takes an id, so `and event_id = wp_my_event_id()` is
-- the only thing standing between a curious client and somebody else's wedding.
-- If either ever fails, stop and fix it before shipping anything.
--
-- Assertion 3 guards the eveGuests trap: evening_total must be seated PLUS the
-- evening-only extras, never the extras alone.
--
-- Runs inside a block that raises at the end, so the fake couples it creates
-- are rolled back. The result arrives as an exception, by design:
--
--     ERROR: ALL 15 ASSERTIONS PASSED (rolled back)      <- what you want
--
-- Last run 8 September 2026: all 15 passed.

do $t$
declare
  uA uuid := '00000000-0000-4000-8000-00000000000a';
  uB uuid := '00000000-0000-4000-8000-00000000000b';
  evA int; evB int; r jsonb; gidA uuid;
  fails text[] := '{}'; passes int := 0;
begin
  select min((e->>'id')::int), max((e->>'id')::int) into evA, evB
    from app_data d, lateral jsonb_array_elements(d.value) e where d.key='hawthbush_bookings_v6';

  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
    (uA,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','a@test.invalid',now(),now()),
    (uB,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','b@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values
    (uA,'a@test.invalid','A','client',true),(uB,'b@test.invalid','B','client',true)
  on conflict (id) do update set role='client';
  insert into public.wp_access (event_id,email,user_id) values (evA,'a@test.invalid',uA),(evB,'b@test.invalid',uB);

  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','a@test.invalid')::text, true);

  -- 1  numbers round-trip
  r := wp_set_numbers(90, 6, 2, 40);
  if (r->>'ok')::bool then passes:=passes+1; else fails:=fails||('1 '||r::text); end if;

  r := wp_get_guests();
  -- 2  seated total is adults + children + babies
  if (r->'derived'->>'seated_total')::int = 98 then passes:=passes+1; else fails:=fails||'2 seated_total'; end if;
  -- 3  THE TRAP: evening total is seated + extras (138), not the extras (40)
  if (r->'derived'->>'evening_total')::int = 138 then passes:=passes+1; else fails:=fails||'3 evening_total not seated+extras'; end if;
  -- 4  nothing named yet, so the whole seated count is outstanding
  if (r->'derived'->>'seated_unnamed')::int = 98 then passes:=passes+1; else fails:=fails||'4 unnamed'; end if;

  -- 5  add a name
  r := wp_add_guest('seated','Ada','Lovelace','bride','adult',true,'step-free access');
  gidA := (r->>'id')::uuid;
  if (r->>'ok')::bool then passes:=passes+1; else fails:=fails||'5 add'; end if;

  -- 6  the reconciliation moves with it
  r := wp_get_guests();
  if (r->'derived'->>'named_seated')::int = 1 and (r->'derived'->>'seated_unnamed')::int = 97 then passes:=passes+1;
  else fails:=fails||'6 reconciliation'; end if;

  -- 7  import adds the real rows and skips the blank one
  r := wp_import_guests('evening', '[{"first_name":"Bob","last_name":"Tables"},{"first_name":"","last_name":""},{"first_name":"Cee","last_name":"Quel","age_band":"child"}]'::jsonb);
  if (r->>'ok')::bool and (r->>'added')::int=2 and (r->>'skipped')::int=1 then passes:=passes+1; else fails:=fails||'7 import'; end if;

  -- 8  an invented list is refused
  r := wp_add_guest('breakfast','X','Y');
  if not (r->>'ok')::bool and r->>'error'='bad_list' then passes:=passes+1; else fails:=fails||'8 bad_list'; end if;

  -- 9  a client cannot use the admin reader
  r := wp_admin_numbers(evA);
  if not (r->>'ok')::bool and r->>'error'='not_staff' then passes:=passes+1; else fails:=fails||'9 admin leak'; end if;

  -- ===== as the other couple =====
  perform set_config('request.jwt.claims', json_build_object('sub',uB,'email','b@test.invalid')::text, true);

  -- 10 B sees none of A's guests and none of A's numbers
  r := wp_get_guests();
  if jsonb_array_length(r->'guests')=0 and (r->'numbers'->>'told_us')::bool=false then passes:=passes+1; else fails:=fails||'10 B sees A'; end if;

  -- 11 B CANNOT EDIT A'S GUEST BY ID          <- the one that matters
  r := wp_update_guest(gidA,'Hacked','Name');
  if not (r->>'ok')::bool and r->>'error'='not_found' then passes:=passes+1; else fails:=fails||'11 B EDITED ANOTHER COUPLE''S GUEST'; end if;

  -- 12 B CANNOT DELETE A'S GUEST BY ID        <- and so does this
  r := wp_delete_guest(gidA);
  if not (r->>'ok')::bool and r->>'error'='not_found' then passes:=passes+1; else fails:=fails||'12 B DELETED ANOTHER COUPLE''S GUEST'; end if;

  -- 13 A's data is intact, and the seated list comes first
  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','a@test.invalid')::text, true);
  r := wp_get_guests();
  if (r->'guests'->0->>'first_name')='Ada' and (r->'guests'->0->>'list')='seated'
     and jsonb_array_length(r->'guests')=3 then passes:=passes+1;
  else fails:=fails||('13 ordering/integrity: '||(r->'guests'->0)::text); end if;

  -- 14 A can edit their own
  r := wp_update_guest(gidA,'Augusta');
  if (r->>'ok')::bool then passes:=passes+1; else fails:=fails||'14 own edit'; end if;

  -- 15 a partial update leaves the fields it was not given alone
  r := wp_get_guests();
  if (r->'guests'->0->>'first_name')='Augusta' and (r->'guests'->0->>'last_name')='Lovelace' then passes:=passes+1;
  else fails:=fails||'15 partial update clobbered other fields'; end if;

  if array_length(fails,1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails,' | ');
  end if;
end $t$;
