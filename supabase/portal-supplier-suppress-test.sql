-- supabase/portal-supplier-suppress-test.sql
--
-- Assertions for 2026-09-09-portal-supplier-suppress.sql. Nine.
--
-- ASSERTIONS 4 AND 5 ARE THE ONES TO READ. Suppressing a supplier must not take
-- them off the wedding that added them, and must not tell that couple anything.
-- It is Hawthbush's judgement about its own recommendations, not a verdict to
-- deliver to a customer about a supplier they have already booked and probably
-- paid a deposit to. If either ever failed, the portal would be quietly
-- editorialising at couples about their own choices.
--
-- Assertion 3 is the other one worth knowing: suppressing UNDOES a promotion.
-- Without that, a supplier promoted last month sits in the recommended list
-- wearing a Suppressed tick and nobody notices for a year.
--
-- Rolled back.
--
--     ERROR: ALL 9 ASSERTIONS PASSED (rolled back)     <- what you want
--
-- Last run 9 September 2026: all 9 passed.

do $t$
declare
  r jsonb; fails text[] := '{}'; passes int := 0;
  uAdmin uuid; uX uuid := '00000000-0000-4000-8000-0000000000d1';
  evX int; sid uuid; dirSid uuid;
begin
  select id into uAdmin from public.profiles where active and role='admin' order by id limit 1;
  if uAdmin is null then raise exception 'no active admin to test with'; end if;
  select min((e->>'id')::int) into evX from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key='hawthbush_bookings_v6';
  insert into auth.users (id,instance_id,aud,role,email,created_at,updated_at)
  values (uX,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','sx@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values (uX,'sx@test.invalid','X','client',true)
  on conflict (id) do update set role='client', active=true;
  insert into public.wp_access (event_id,email,user_id) values (evX,'sx@test.invalid',uX);

  -- A couple adds one and offers it. NOTE: the category is a SLUG, and the
  -- function returns 'supplier_id', not 'id'.
  perform set_config('request.jwt.claims', json_build_object('sub',uX,'email','sx@test.invalid')::text, true);
  r := wp_add_own_supplier('Dodgy Discos', 'music');
  sid := (r->>'supplier_id')::uuid;
  perform wp_offer_supplier(sid, true);

  -- 1. The count reaches the couple's directory
  select id into dirSid from wp_suppliers where owner_event_id is null and active and suppressed_at is null limit 1;
  if dirSid is null then
    insert into wp_suppliers (name, category) values ('A directory band','music') returning id into dirSid;
  end if;
  r := wp_get_suppliers();
  if (select count(*) from jsonb_array_elements(r->'directory') e where e ? 'used_by') > 0
  then passes:=passes+1; else fails := fails || 'FAIL 1: no used_by on the directory'::text; end if;

  -- 2. Suppressing sets the flag and clears the offer
  perform set_config('request.jwt.claims', json_build_object('sub', uAdmin)::text, true);
  r := wp_admin_suppress_supplier(sid, true);
  if (r->>'ok')::bool
     and (select suppressed_at is not null and share_offered_at is null
                 and not public_listed and promoted_at is null from wp_suppliers where id = sid)
  then passes:=passes+1; else fails := fails || ('FAIL 2: ' || coalesce(r::text,'null')); end if;

  -- 3. It UNDOES a promotion and the supplier leaves the recommended list
  perform wp_admin_promote_supplier(dirSid);
  perform wp_admin_suppress_supplier(dirSid, true);
  perform set_config('request.jwt.claims', json_build_object('sub',uX,'email','sx@test.invalid')::text, true);
  r := wp_get_suppliers();
  if (select count(*) from jsonb_array_elements(r->'directory') e where (e->>'id')::uuid = dirSid) = 0
  then passes:=passes+1; else fails := fails || 'FAIL 3: a suppressed supplier stayed in the directory'::text; end if;

  -- 4. ── THE ONE THAT MATTERS ── the couple who added them KEEPS them
  if (select count(*) from jsonb_array_elements(r->'chosen') e where (e->>'supplier_id')::uuid = sid) = 1
  then passes:=passes+1; else fails := fails || 'FAIL 4: suppressing took the supplier off the couple'::text; end if;

  -- 5. ...and is told nothing about it
  if not (r->'chosen')::text like '%suppress%'
  then passes:=passes+1; else fails := fails || 'FAIL 5: suppression leaked to the couple'::text; end if;

  -- 6. It can be undone
  perform set_config('request.jwt.claims', json_build_object('sub', uAdmin)::text, true);
  r := wp_admin_suppress_supplier(sid, false);
  if (select suppressed_at is null from wp_suppliers where id = sid)
  then passes:=passes+1; else fails := fails || 'FAIL 6: could not un-suppress'::text; end if;

  -- 7. The admin list carries both new facts
  r := wp_admin_suppliers();
  if (select count(*) from jsonb_array_elements(r->'suppliers') e
       where e ? 'suppressed_at' and e ? 'used_by') > 0
  then passes:=passes+1; else fails := fails || 'FAIL 7: admin list missing the new fields'::text; end if;

  -- 8. A couple cannot suppress anything
  perform set_config('request.jwt.claims', json_build_object('sub',uX,'email','sx@test.invalid')::text, true);
  if (wp_admin_suppress_supplier(sid, true) ->> 'error') = 'not_staff'
  then passes:=passes+1; else fails := fails || 'FAIL 8: a client suppressed a supplier'::text; end if;

  perform set_config('request.jwt.claims', null, true);

  -- 9. Grants
  if not has_function_privilege('anon','public.wp_admin_suppress_supplier(uuid,boolean)','execute')
  then passes:=passes+1; else fails := fails || 'FAIL 9: anon grant'::text; end if;

  if array_length(fails,1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails,' | ');
  end if;
end $t$;
