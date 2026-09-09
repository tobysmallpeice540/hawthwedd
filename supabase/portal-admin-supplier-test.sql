-- supabase/portal-admin-supplier-test.sql
--
-- Seven assertions for managing the supplier directory from the admin screen.
--
-- Assertion 5 is the one that matters: a supplier a COUPLE invented cannot be
-- edited from the directory screen, because editing it would change it under
-- them. Promoting it into the directory is the separate, deliberate step, and
-- assertion 6 covers that.
--
-- Rolled back at the end.  Last run 9 September 2026: all 7 passed.

do $t$
declare
  adm uuid; uA uuid := '00000000-0000-4000-8000-00000000000a';
  evA int; r jsonb; dir_id uuid; own_id uuid;
  fails text[] := '{}'; passes int := 0;
begin
  select min((e->>'id')::int) into evA from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key='hawthbush_bookings_v6';
  select id into adm from public.profiles where role='admin' and active limit 1;

  perform set_config('request.jwt.claims', json_build_object('sub',adm,'email','a@t')::text, true);
  r := wp_admin_upsert_supplier(null,'Circa Catering','catering','Greg',null,null,'circa.co.uk','Knows the barn well', true, '2027-06-01','chase cert');
  dir_id := (r->>'id')::uuid;
  if (r->>'ok')::bool and dir_id is not null then passes:=passes+1; else fails:=fails||('1 create: '||r::text); end if;

  if exists (select 1 from wp_suppliers where id=dir_id and owner_event_id is null and pli_held and internal_note='chase cert')
    then passes:=passes+1; else fails:=fails||'2 stored wrong'; end if;

  r := wp_admin_upsert_supplier(dir_id,'Circa Catering Ltd');
  if (r->>'ok')::bool and (select name from wp_suppliers where id=dir_id)='Circa Catering Ltd'
    then passes:=passes+1; else fails:=fails||'3 edit'; end if;

  r := wp_admin_upsert_supplier(null,'X','nope');
  if not (r->>'ok')::bool and r->>'error'='bad_category' then passes:=passes+1; else fails:=fails||'4 bad category'; end if;

  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  values (uA,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','c@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values (uA,'c@test.invalid','C','client',true)
  on conflict (id) do update set role='client';
  insert into public.wp_access (event_id,email,user_id) values (evA,'c@test.invalid',uA);
  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','c@test.invalid')::text, true);
  r := wp_add_own_supplier('Auntie Jean','flowers');
  own_id := (r->>'supplier_id')::uuid;

  perform set_config('request.jwt.claims', json_build_object('sub',adm,'email','a@t')::text, true);
  -- 5 A COUPLE'S OWN SUPPLIER IS NOT THE DIRECTORY'S TO EDIT
  r := wp_admin_upsert_supplier(own_id,'Hijacked');
  if not (r->>'ok')::bool and r->>'error'='belongs_to_a_couple' then passes:=passes+1;
  else fails:=fails||('5 EDITED A COUPLE''S OWN SUPPLIER: '||r::text); end if;

  -- 6 promoting it is the deliberate step
  r := wp_admin_promote_supplier(own_id);
  if (r->>'ok')::bool and (select owner_event_id is null from wp_suppliers where id=own_id)
    then passes:=passes+1; else fails:=fails||'6 promote'; end if;

  -- 7 and a client cannot create directory rows
  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','c@test.invalid')::text, true);
  r := wp_admin_upsert_supplier(null,'Sneaky','catering');
  if not (r->>'ok')::bool and r->>'error'='not_staff' then passes:=passes+1; else fails:=fails||'7 client created directory row'; end if;

  if array_length(fails,1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else raise exception '% passed / FAILURES: %', passes, array_to_string(fails,' | '); end if;
end $t$;
