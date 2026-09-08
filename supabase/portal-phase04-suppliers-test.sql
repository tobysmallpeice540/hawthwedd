-- supabase/portal-phase04-suppliers-test.sql
--
-- Sixteen assertions for suppliers.
--
-- The ones to care about:
--   2   the PLI fields and internal note never reach a client
--   7   a client cannot edit a DIRECTORY supplier (it belongs to every wedding)
--   10  one couple's private supplier is invisible in another's directory
--   12  and cannot be chosen even by naming its id
--   13  nor edited, 14 nor un-chosen from the other side
--   16  removing your own invented supplier does not leave an orphan behind
--
-- Rolled back at the end. The result arrives as an exception, by design:
--
--     ERROR: ALL 16 ASSERTIONS PASSED (rolled back)
--
-- Last run 8 September 2026: all 16 passed.

do $t$
declare
  uA uuid := '00000000-0000-4000-8000-00000000000a';
  uB uuid := '00000000-0000-4000-8000-00000000000b';
  evA int; evB int; r jsonb; dir_id uuid; a_sup uuid; b_sup uuid; a_sel uuid;
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

  insert into wp_suppliers (name, category, email, pli_held, pli_expires, internal_note)
  values ('Circa Catering','catering','hello@circa.invalid', true, '2027-01-01','owes us a PLI cert')
  returning id into dir_id;

  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','a@test.invalid')::text, true);

  -- 1  the directory is visible
  r := wp_get_suppliers();
  if (r->>'ok')::bool and exists (select 1 from jsonb_array_elements(r->'directory') d where (d->>'id')::uuid = dir_id)
    then passes:=passes+1; else fails:=fails||'1 directory missing'; end if;

  -- 2  VENUE-ONLY FIELDS NEVER REACH A CLIENT
  if r::text not like '%pli_held%' and r::text not like '%internal_note%'
     and r::text not like '%owes us a PLI cert%'
    then passes:=passes+1; else fails:=fails||'2 PLI/internal note leaked to a client'; end if;

  -- 3-5  choosing, adding their own, and the count
  r := wp_choose_supplier(dir_id, 'they know the barn');
  if (r->>'ok')::bool then passes:=passes+1; else fails:=fails||('3 choose: '||r::text); end if;

  r := wp_add_own_supplier('Auntie Jean Flowers','flowers','Jean','jean@example.invalid');
  a_sup := (r->>'supplier_id')::uuid;
  if (r->>'ok')::bool then passes:=passes+1; else fails:=fails||'4 add own'; end if;

  r := wp_get_suppliers();
  if jsonb_array_length(r->'chosen') = 2 then passes:=passes+1; else fails:=fails||'5 chosen count'; end if;
  select (c->>'id')::uuid into a_sel from jsonb_array_elements(r->'chosen') c where (c->>'supplier_id')::uuid = a_sup;

  -- 6  an invented category is refused
  r := wp_add_own_supplier('X','not_a_category');
  if not (r->>'ok')::bool and r->>'error'='bad_category' then passes:=passes+1; else fails:=fails||'6 bad category'; end if;

  -- 7  a client CANNOT edit a directory supplier
  r := wp_update_own_supplier(dir_id, 'Circa (hacked)');
  if not (r->>'ok')::bool and r->>'error'='not_yours' then passes:=passes+1;
  else fails:=fails||('7 EDITED A DIRECTORY SUPPLIER: '||r::text); end if;

  -- 8-9  nor promote, nor read the admin list
  r := wp_admin_promote_supplier(a_sup);
  if not (r->>'ok')::bool and r->>'error'='not_staff' then passes:=passes+1; else fails:=fails||'8 client promoted'; end if;

  r := wp_admin_suppliers();
  if not (r->>'ok')::bool and r->>'error'='not_staff' then passes:=passes+1; else fails:=fails||'9 admin leak'; end if;

  -- ===== the other couple =====
  perform set_config('request.jwt.claims', json_build_object('sub',uB,'email','b@test.invalid')::text, true);
  r := wp_add_own_supplier('B''s Band','music');
  b_sup := (r->>'supplier_id')::uuid;

  r := wp_get_suppliers();
  -- 10 A's PRIVATE SUPPLIER IS NOT IN B'S DIRECTORY
  if not exists (select 1 from jsonb_array_elements(r->'directory') d where (d->>'id')::uuid = a_sup)
    then passes:=passes+1; else fails:=fails||'10 A PRIVATE SUPPLIER VISIBLE TO B'; end if;

  -- 11 nor are A's choices
  if jsonb_array_length(r->'chosen') = 1 then passes:=passes+1; else fails:=fails||'11 B sees A choices'; end if;

  -- 12 B CANNOT CHOOSE A'S PRIVATE SUPPLIER BY ID
  r := wp_choose_supplier(a_sup);
  if not (r->>'ok')::bool and r->>'error'='not_found' then passes:=passes+1;
  else fails:=fails||('12 B CHOSE A''S PRIVATE SUPPLIER: '||r::text); end if;

  -- 13 B CANNOT EDIT A'S SUPPLIER
  r := wp_update_own_supplier(a_sup, 'nope');
  if not (r->>'ok')::bool and r->>'error'='not_yours' then passes:=passes+1;
  else fails:=fails||('13 B EDITED A''S SUPPLIER: '||r::text); end if;

  -- 14 B CANNOT UN-CHOOSE A'S SELECTION
  r := wp_unchoose_supplier(a_sel);
  if not (r->>'ok')::bool and r->>'error'='not_found' then passes:=passes+1;
  else fails:=fails||('14 B REMOVED A''S SELECTION: '||r::text); end if;

  -- 15 A's data is intact
  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','a@test.invalid')::text, true);
  r := wp_get_suppliers();
  if jsonb_array_length(r->'chosen') = 2 then passes:=passes+1; else fails:=fails||'15 A data damaged'; end if;

  -- 16 removing your own invented supplier leaves no orphan row
  r := wp_unchoose_supplier(a_sel);
  if (r->>'ok')::bool and not exists (select 1 from wp_suppliers where id = a_sup)
    then passes:=passes+1; else fails:=fails||'16 orphan supplier left behind'; end if;

  if array_length(fails,1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails,' | ');
  end if;
end $t$;
