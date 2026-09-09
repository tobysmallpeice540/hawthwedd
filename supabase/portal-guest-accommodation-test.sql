-- supabase/portal-guest-accommodation-test.sql
--
-- Assertions for 2026-09-09-portal-guest-accommodation-and-table.sql. Sixteen.
--
-- Assertions 9 and 10 are the ones that matter. wp_set_guest_table() takes TWO
-- ids, and the whole security of the function is that both are checked against
-- wp_my_event_id(). If either check went, one couple could seat their guests at
-- another wedding's tables, or move another wedding's guests — and neither
-- would look like a fault from the inside.
--
-- Everything runs inside a block that raises at the end, so the two fake
-- couples, their access rows, guests and tables are all rolled back.
--
--     ERROR: ALL 16 ASSERTIONS PASSED (rolled back)     <- what you want
--
-- Last run 9 September 2026: all 16 passed.

do $t$
declare
  r jsonb; fails text[] := '{}'; passes int := 0;
  uX uuid := '00000000-0000-4000-8000-0000000000e1';
  uY uuid := '00000000-0000-4000-8000-0000000000e2';
  evX int; evY int; gid uuid; tid uuid; otherTid uuid; i int;
begin
  select min((e->>'id')::int), max((e->>'id')::int) into evX, evY
    from app_data d, lateral jsonb_array_elements(d.value) e where d.key='hawthbush_bookings_v6';

  insert into auth.users (id,instance_id,aud,role,email,created_at,updated_at) values
    (uX,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','gx@test.invalid',now(),now()),
    (uY,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','gy@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values
    (uX,'gx@test.invalid','X','client',true),(uY,'gy@test.invalid','Y','client',true)
  on conflict (id) do update set role='client', active=true;
  insert into public.wp_access (event_id,email,user_id) values (evX,'gx@test.invalid',uX),(evY,'gy@test.invalid',uY);

  perform set_config('request.jwt.claims', json_build_object('sub',uX,'email','gx@test.invalid')::text, true);

  -- 1. Which accommodation, not merely whether
  r := wp_add_guest('seated','Ann','Adams',null,'adult',true,null,'hamlet');
  gid := (r->>'id')::uuid;
  if (select staying_where from wp_guests where id=gid) = 'hamlet' then passes:=passes+1;
  else fails := fails || 'FAIL 1: staying_where did not store'; end if;

  -- 2. Nobody is not-staying somewhere: unticking clears it
  r := wp_update_guest(gid, null,null,null,null,false,null,null,null);
  if (select staying_where from wp_guests where id=gid) is null then passes:=passes+1;
  else fails := fails || 'FAIL 2: unticking staying left an accommodation behind'; end if;

  -- 3. ...and nobody is staying nowhere, even through add
  r := wp_add_guest('seated','Bob','Brown',null,'adult',false,null,'hamlet');
  if (select staying_where from wp_guests where id=(r->>'id')::uuid) is null then passes:=passes+1;
  else fails := fails || 'FAIL 3: a not-staying guest got an accommodation'; end if;

  -- 4. An invented accommodation is refused rather than stored
  r := wp_add_guest('seated','Cal','Clark',null,'adult',true,null,'treehouse');
  if not (r->>'ok')::bool and r->>'error' = 'bad_accommodation' then passes:=passes+1;
  else fails := fails || 'FAIL 4: treehouse was accepted'; end if;

  -- 5. The dropdown path takes the first free chair
  r := wp_add_table(1000,1000,'Table 1'); tid := (r->>'id')::uuid;
  r := wp_set_guest_table(gid, tid);
  if (r->>'ok')::bool and (r->>'seat_index')::int = 0 then passes:=passes+1;
  else fails := fails || ('FAIL 5: first seat not taken: ' || coalesce(r::text,'null')); end if;

  -- 6. The list gets the table by name, and the tables to choose from
  r := wp_get_guests();
  if (select count(*) from jsonb_array_elements(r->'guests') e
       where (e->>'id')::uuid = gid and e->>'table_label' = 'Table 1') = 1
     and jsonb_array_length(r->'tables') = 1 then passes:=passes+1;
  else fails := fails || 'FAIL 6: the table did not reach the guest list'; end if;

  -- 7. A full table refuses rather than silently displacing whoever is there
  for i in 1..5 loop
    r := wp_add_guest('seated','Fill'||i,'X',null,'adult',false,null,null);
    perform wp_set_guest_table((r->>'id')::uuid, tid);
  end loop;
  r := wp_add_guest('seated','Spare','X',null,'adult',false,null,null);
  r := wp_set_guest_table((r->>'id')::uuid, tid);
  if not (r->>'ok')::bool and r->>'error' = 'table_full' then passes:=passes+1;
  else fails := fails || ('FAIL 7: a seventh guest fitted on six chairs: ' || coalesce(r::text,'null')); end if;

  -- 8. Null takes somebody off a table
  r := wp_set_guest_table(gid, null);
  if (r->>'ok')::bool and (select table_id from wp_guests where id=gid) is null then passes:=passes+1;
  else fails := fails || 'FAIL 8: could not unseat'; end if;

  -- 9. ── THE ONE THAT MATTERS ── another wedding's table is unreachable
  perform set_config('request.jwt.claims', json_build_object('sub',uY,'email','gy@test.invalid')::text, true);
  r := wp_add_table(1000,1000,'Their table'); otherTid := (r->>'id')::uuid;
  perform set_config('request.jwt.claims', json_build_object('sub',uX,'email','gx@test.invalid')::text, true);
  r := wp_set_guest_table(gid, otherTid);
  if not (r->>'ok')::bool and r->>'error' = 'not_found' then passes:=passes+1;
  else fails := fails || ('FAIL 9: seated a guest at another wedding''s table: ' || coalesce(r::text,'null')); end if;

  -- 10. ...and another wedding's guest cannot be moved
  perform set_config('request.jwt.claims', json_build_object('sub',uY,'email','gy@test.invalid')::text, true);
  r := wp_set_guest_table(gid, otherTid);
  if not (r->>'ok')::bool and r->>'error' = 'not_found' then passes:=passes+1;
  else fails := fails || 'FAIL 10: moved another wedding''s guest'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub',uX,'email','gx@test.invalid')::text, true);

  -- ── clearing it back to undecided ────────────────────────────────────────
  -- Everything else in wp_update_guest coalesces null to the existing value, so
  -- an emptied field cannot be cleared. staying_where has to be an exception:
  -- a couple who picked The Hamlet and went back to undecided must be able to
  -- say so. Empty string clears; not sending it leaves it alone.
  r := wp_update_guest(gid, null,null,null,null,true,null,null,'hamlet');

  -- 11. An unrelated edit does not lose it
  r := wp_update_guest(gid, 'Annabel', null,null,null,null,null,null,null);
  if (select staying_where from wp_guests where id=gid) = 'hamlet' then passes:=passes+1;
  else fails := fails || 'FAIL 11: an unrelated edit lost the accommodation'; end if;

  -- 12. An empty string clears it
  r := wp_update_guest(gid, null,null,null,null,null,null,null,'');
  if (select staying_where from wp_guests where id=gid) is null then passes:=passes+1;
  else fails := fails || 'FAIL 12: could not go back to not decided'; end if;

  -- 13. ...and it can be set again afterwards
  r := wp_update_guest(gid, null,null,null,null,null,null,null,'amly');
  if (select staying_where from wp_guests where id=gid) = 'amly' then passes:=passes+1;
  else fails := fails || 'FAIL 13: could not set it again'; end if;

  -- 14. Unticking staying wins over any accommodation sent with it
  r := wp_update_guest(gid, null,null,null,null,false,null,null,'amly');
  if (select staying_where from wp_guests where id=gid) is null then passes:=passes+1;
  else fails := fails || 'FAIL 14: not staying, but somewhere'; end if;

  -- 15. No overloads left behind. Two overloads whose arguments all carry
  --     defaults make every call ambiguous, and PostgREST starts failing on a
  --     function that looks perfectly fine in the catalogue.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname in ('wp_add_guest','wp_update_guest')) = 2
  then passes:=passes+1; else fails := fails || 'FAIL 15: the guest functions are overloaded'; end if;

  -- 16. A dropped-and-recreated function is a NEW function, so Supabase has
  --     granted EXECUTE to anon all over again unless it was revoked by name.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname in ('wp_add_guest','wp_update_guest','wp_set_guest_table')
         and has_function_privilege('anon', p.oid, 'execute')) = 0
  then passes:=passes+1; else fails := fails || 'FAIL 16: anon can execute a guest function'; end if;

  perform set_config('request.jwt.claims', null, true);

  if array_length(fails,1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails,' | ');
  end if;
end $t$;


-- ── Checking this file against the live catalogue ───────────────────────────
--
-- Compare the BODY and the SIGNATURE separately. pg_get_functiondef prints
-- `DEFAULT NULL::text` where the file says `default null`, so a faithful
-- nine-parameter function reads longer in the catalogue and looks like drift.
--
-- On 9 September 2026, normalised bodies:
--   wp_add_guest        f4e9de0737ab15c6682b496d91291ee7   1689 chars
--   wp_update_guest     c287baaae676da9d568d9e91febe24ce   2065 chars
--   wp_set_guest_table  b187b9ec53a7a280b7038a82913b3c65   1763 chars

select p.proname,
       md5(trim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) as body_md5,
       length(trim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) as body_len,
       has_function_privilege('anon', p.oid, 'execute') as anon_expected_false
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('wp_add_guest','wp_update_guest','wp_set_guest_table','wp_get_guests')
order by p.proname;
