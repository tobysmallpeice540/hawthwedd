-- supabase/portal-drinks-test.sql
--
-- Assertions for 2026-10-23b-portal-drinks.sql. Rolled back; the result
-- arrives as an exception:  ERROR: ALL n ASSERTIONS PASSED (rolled back)
--
-- The ones to care about:
--   C3   corkage: the allowance absorbs the DEAREST drinks first, part bottles
--        round up, and moments do not pool
--   P2   a price change after a line is added does not move the line
--   L1–L3  once locked, the client cannot change the order; staff can unlock
--   X1   no invoice is recorded from an unlocked or half-priced order
--   S1   one couple cannot change another's drinks lines

do $t$
declare
  uA uuid := '00000000-0000-4000-8000-0000000000d1';
  uB uuid := '00000000-0000-4000-8000-0000000000d2';
  uS uuid := '00000000-0000-4000-8000-0000000000d3';
  evA int; evB int; r jsonb; sm jsonb; lineA uuid; c_fizz uuid; c_beer uuid; c_spirit uuid; c_wine uuid;
  c_toast uuid; c_champ uuid; c_extra uuid; v_date date;
  fails text[] := '{}'; passes int := 0;
begin
  select (e->>'id')::int into evA from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key='hawthbush_bookings_v6' and wp_event_type_label(e->>'eventType')='Wedding'
   order by e->>'date' desc limit 1;
  select (e->>'id')::int into evB from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key='hawthbush_bookings_v6' and wp_event_type_label(e->>'eventType')='Wedding' and (e->>'id')::int <> evA
   order by e->>'date' desc limit 1;

  delete from wp_drinks where event_id in (evA, evB);
  delete from wp_drinks_lines where event_id in (evA, evB);
  delete from wp_guest_numbers where event_id in (evA, evB);
  -- Put A's date far enough ahead that it is not locked, whatever today is.
  update app_data set value = (select jsonb_agg(case when (e->>'id')::int = evA
                                   then jsonb_set(e, '{date}', to_jsonb((current_date + 200)::text)) else e end)
                                 from jsonb_array_elements(value) e)
   where key = 'hawthbush_bookings_v6';
  insert into wp_guest_numbers (event_id, seated_adults, seated_children, seated_babies, evening_extras)
  values (evA, 100, 10, 2, 40);

  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
    (uA,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','da@test.invalid',now(),now()),
    (uB,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','db@test.invalid',now(),now()),
    (uS,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','ds@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values
    (uA,'da@test.invalid','A','client',true),(uB,'db@test.invalid','B','client',true),(uS,'ds@test.invalid','S','admin',true)
  on conflict (id) do update set role = excluded.role;
  insert into public.wp_access (event_id,email,user_id) values (evA,'da@test.invalid',uA),(evB,'db@test.invalid',uB);

  select id into c_fizz  from wp_drinks_catalogue where route='corkage' and moment='reception' and name like 'Prosecco%';
  select id into c_beer  from wp_drinks_catalogue where route='corkage' and moment='reception' and name like 'Bottled beer%';
  select id into c_spirit from wp_drinks_catalogue where route='corkage' and name = 'Spirits';
  select id into c_wine  from wp_drinks_catalogue where route='corkage' and moment='wine';
  select id into c_toast from wp_drinks_catalogue where route='corkage' and moment='toast';
  select id into c_champ from wp_drinks_catalogue where route='classic' and moment='toast' and name like 'Champagne%';
  select id into c_extra from wp_drinks_catalogue where route='classic' and moment='extra' and name = 'Extra Prosecco';

  -- G1  nothing new is callable by anon; helpers not by clients
  if not exists (select 1 from pg_proc p join pg_namespace s on s.oid=p.pronamespace
                  where s.nspname='public' and p.proname like 'wp\_%drinks%' and has_function_privilege('anon', p.oid, 'execute'))
     and not has_function_privilege('authenticated', 'public.wp_drinks_summary(integer)'::regprocedure, 'execute')
     and not has_function_privilege('anon', 'public.wp_save_bar_tab(numeric,text)'::regprocedure, 'execute')
  then passes:=passes+1; else fails:=fails||text 'G1 grants'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','da@test.invalid')::text, true);

  -- R1  choosing corkage copies the rate onto the wedding
  r := wp_set_drinks_route('corkage');
  if exists (select 1 from wp_drinks where event_id = evA and route = 'corkage' and rate_pp = 14.28 and child_rate_pp = 0)
  then passes:=passes+1; else fails:=fails||('R1 route: '||r::text); end if;

  -- C1  spirits are refused; a Classic item is refused under corkage
  r := wp_save_drinks_line(null, c_spirit, 2);
  if r->>'error' = 'not_allowed' then passes:=passes+1; else fails:=fails||('C1 spirits accepted: '||r::text); end if;
  r := wp_save_drinks_line(null, c_champ, 2);
  if r->>'error' = 'wrong_package' then passes:=passes+1; else fails:=fails||text 'C2 classic line under corkage'; end if;

  -- C3  reception allowance 200 drinks. 30 bottles fizz (180 drinks, £2/drink)
  --     + 48 beers (£2.40/drink). Beers absorbed first (dearer per drink):
  --     48 used, 152 left for fizz → 28 drinks over = 5 bottles (rounded up) × £12.
  --     Toast: 100 glasses allowance; 15 bottles × 8 = 120 → 20 over = 3 bottles.
  --     Meal: 50 bottles allowance; 50 brought → nothing over (no pooling with toast).
  perform wp_save_drinks_line(null, c_fizz, 30);
  perform wp_save_drinks_line(null, c_beer, 48);
  perform wp_save_drinks_line(null, c_toast, 15);
  r := wp_save_drinks_line(null, c_wine, 50);
  sm := wp_drinks_summary(evA);
  if (sm->'moments'->0->>'allowance')::numeric = 200 and (sm->'moments'->0->>'cost')::numeric = 60
     and (sm->'moments'->1->>'cost')::numeric = 0 and (sm->'moments'->2->>'cost')::numeric = 36
     and (sm->>'total')::numeric = 1428 + 60 + 36
  then passes:=passes+1; else fails:=fails||('C3 corkage maths: '||sm::text); end if;

  -- C4  VAT is the inc-VAT share, not added on
  if (sm->>'vat')::numeric = round(1524 * 20.0 / 120, 2) then passes:=passes+1;
  else fails:=fails||('C4 vat: '||(sm->>'vat')); end if;

  -- C5  invoice lines add up to the total, and children at £0 add no line
  if (select sum((x->>'amount')::numeric) from jsonb_array_elements(sm->'invoice_lines') x) = (sm->>'total')::numeric
     and not exists (select 1 from jsonb_array_elements(sm->'invoice_lines') x where x->>'desc' like '%children%')
  then passes:=passes+1; else fails:=fails||('C5 invoice lines: '||(sm->'invoice_lines')::text); end if;

  -- P1/P2  switch to Classic: corkage lines go; an extra's price is kept as added
  r := wp_set_drinks_route('classic');
  if not exists (select 1 from wp_drinks_lines where event_id = evA and route = 'corkage')
     and (select rate_pp from wp_drinks where event_id = evA) = 28.80
  then passes:=passes+1; else fails:=fails||text 'P1 route change'; end if;
  update wp_drinks_catalogue set price_on_request = false, price_inc_vat = 18 where id = c_extra;
  r := wp_save_drinks_line(null, c_extra, 4);
  lineA := (r->>'id')::uuid;
  update wp_drinks_catalogue set price_inc_vat = 99 where id = c_extra;
  if (select unit_price from wp_drinks_lines where id = lineA) = 18 then passes:=passes+1;
  else fails:=fails||text 'P2 snapshot price moved'; end if;

  -- P3  a price-on-request upgrade counts as unpriced until staff price it
  r := wp_save_drinks_line(null, c_champ, 20);
  sm := wp_drinks_summary(evA);
  if (sm->>'unpriced')::int = 1 and (sm->>'total')::numeric = 2880 + 72 then passes:=passes+1;
  else fails:=fails||('P3 unpriced: '||sm::text); end if;

  -- B1  money behind the bar
  r := wp_save_bar_tab(500, 'Beer and wine only — no spirits');
  if exists (select 1 from wp_drinks where event_id = evA and bar_amount = 500 and bar_rules like 'Beer and wine%')
  then passes:=passes+1; else fails:=fails||text 'B1 bar tab'; end if;

  -- B2  a non-wedding gets no packages
  -- (only if the replica/production has a party to test with)

  -- S1  B cannot touch A's line
  perform set_config('request.jwt.claims', json_build_object('sub',uB,'email','db@test.invalid')::text, true);
  r := wp_save_drinks_line(lineA, null, 999);
  if r->>'error' = 'not_found' and (select qty from wp_drinks_lines where id = lineA) = 4 then passes:=passes+1;
  else fails:=fails||text 'S1 B CHANGED A''s LINE'; end if;
  r := wp_delete_drinks_line(lineA);
  if r->>'error' = 'not_found' then passes:=passes+1; else fails:=fails||text 'S2 B DELETED A''s LINE'; end if;

  -- L1  lock: move A's date inside the lock window
  update app_data set value = (select jsonb_agg(case when (e->>'id')::int = evA
                                   then jsonb_set(e, '{date}', to_jsonb((current_date + 10)::text)) else e end)
                                 from jsonb_array_elements(value) e)
   where key = 'hawthbush_bookings_v6';
  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','da@test.invalid')::text, true);
  r := wp_save_drinks_line(lineA, null, 5);
  if r->>'error' = 'locked' then passes:=passes+1; else fails:=fails||('L1 edited when locked: '||r::text); end if;
  r := wp_set_drinks_route('corkage');
  if r->>'error' = 'locked' then passes:=passes+1; else fails:=fails||text 'L2 route changed when locked'; end if;
  -- the bar tab is not part of the lock
  r := wp_save_bar_tab(600, null);
  if (r->>'ok')::bool then passes:=passes+1; else fails:=fails||text 'L3 bar tab locked'; end if;

  -- staff
  perform set_config('request.jwt.claims', json_build_object('sub',uS,'email','ds@test.invalid')::text, true);
  -- X1  cannot record an invoice while a line is unpriced
  r := wp_admin_mark_drinks_invoiced(evA, 'x', 'INV-1');
  if r->>'error' = 'unpriced_lines' then passes:=passes+1; else fails:=fails||('X1 invoiced with unpriced: '||r::text); end if;
  update wp_drinks_catalogue set price_inc_vat = 3 where id = c_champ;   -- the list, not the line
  perform wp_admin_price_drinks_line(id, 3) from wp_drinks_lines where event_id = evA and catalogue_id = c_champ;
  r := wp_admin_mark_drinks_invoiced(evA, 'xero-id', 'INV-1');
  if (r->>'ok')::bool and exists (select 1 from wp_drinks where event_id = evA and xero_invoice_number = 'INV-1')
  then passes:=passes+1; else fails:=fails||('X2 mark invoiced: '||r::text); end if;
  -- L4  staff unlock lets the client change it again
  perform wp_admin_set_drinks(evA, null, null, true);
  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','da@test.invalid')::text, true);
  r := wp_save_drinks_line(lineA, null, 5);
  if (r->>'ok')::bool then passes:=passes+1; else fails:=fails||text 'L4 unlock did not unlock'; end if;
  -- X3  and an unlocked order cannot be (re)invoiced
  perform set_config('request.jwt.claims', json_build_object('sub',uS,'email','ds@test.invalid')::text, true);
  r := wp_admin_mark_drinks_invoiced(evA, 'x', 'INV-2');
  if r->>'error' = 'not_locked' then passes:=passes+1; else fails:=fails||text 'X3 invoiced while unlocked'; end if;

  -- K1  staff-only refuses a client
  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','da@test.invalid')::text, true);
  r := wp_admin_set_drinks(evA, 1);
  if r->>'error' = 'not_staff' then passes:=passes+1; else fails:=fails||text 'K1 client used a staff function'; end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails, ' | ');
  end if;
end
$t$;
