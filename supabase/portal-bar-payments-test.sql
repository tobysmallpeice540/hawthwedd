-- supabase/portal-bar-payments-test.sql
--
-- Assertions for 2026-10-23f-bar-payments.sql. Rolled back; the result
-- arrives as an exception:  ERROR: ALL n ASSERTIONS PASSED (rolled back)
-- Removes no rows.
--
--   P1  a client starts a payment for their own event only
--   P3  paid only when the session AND the amount match; a second webhook
--       delivery is not "first time", so nobody is emailed twice
--   P5  the running total and date land on wp_drinks for every reader
--   G1  the webhook-facing functions are service-only

do $t$
declare
  uA uuid := '00000000-0000-4000-8000-0000000000b1';
  uB uuid := '00000000-0000-4000-8000-0000000000b2';
  uS uuid := '00000000-0000-4000-8000-0000000000b3';
  evA int; evB int; r jsonb; pid uuid; pid2 uuid; fails text[] := '{}'; passes int := 0;
begin
  select (e->>'id')::int into evA from app_data x, lateral jsonb_array_elements(x.value) e
   where x.key='hawthbush_bookings_v6' and wp_event_type_label(e->>'eventType')='Wedding'
     and not exists (select 1 from wp_access a where a.event_id = (e->>'id')::int)
   order by e->>'date' desc limit 1;
  select (e->>'id')::int into evB from app_data x, lateral jsonb_array_elements(x.value) e
   where x.key='hawthbush_bookings_v6' and (e->>'id')::int <> evA
     and not exists (select 1 from wp_access a where a.event_id = (e->>'id')::int)
   order by e->>'date' desc limit 1;

  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
    (uA,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','pa@test.invalid',now(),now()),
    (uB,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','pb@test.invalid',now(),now()),
    (uS,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','ps@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values
    (uA,'pa@test.invalid','A','client',true),(uB,'pb@test.invalid','B','client',true),(uS,'ps@test.invalid','S','admin',true)
  on conflict (id) do update set role = excluded.role, active = true;
  insert into public.wp_access (event_id,email,user_id) values (evA,'pa@test.invalid',uA),(evB,'pb@test.invalid',uB);

  -- G1
  if not has_function_privilege('authenticated', 'public.wp_bar_payment_paid(text,numeric,text,text)'::regprocedure, 'execute')
     and not has_function_privilege('authenticated', 'public.wp_bar_payment_attach(uuid,text)'::regprocedure, 'execute')
     and not has_function_privilege('authenticated', 'public.wp_bar_payment_expired(text)'::regprocedure, 'execute')
     and not has_function_privilege('anon', 'public.wp_bar_payment_start(numeric)'::regprocedure, 'execute')
     and has_function_privilege('authenticated', 'public.wp_bar_payment_start(numeric)'::regprocedure, 'execute')
     and not has_table_privilege('authenticated', 'public.wp_bar_payments', 'select')
  then passes:=passes+1; else fails:=fails||text 'G1 grants'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','pa@test.invalid')::text, true);

  -- P1 start
  r := wp_bar_payment_start(500);
  pid := (r->>'id')::uuid;
  if (r->>'ok')::bool and (r->>'event_id')::int = evA and (r->>'amount')::numeric = 500
     and exists (select 1 from wp_bar_payments where id = pid and event_id = evA and status = 'pending' and payer_email = 'pa@test.invalid')
  then passes:=passes+1; else fails:=fails||('P1 '||r::text); end if;
  r := wp_bar_payment_start(5);
  if r->>'error' = 'bad_amount' then passes:=passes+1; else fails:=fails||text 'P2 £5 accepted'; end if;
  r := wp_bar_payment_start(12.345);
  if r->>'error' = 'bad_amount' then passes:=passes+1; else fails:=fails||text 'P2b part pence accepted'; end if;

  -- the pending one shows to the client
  r := wp_get_drinks();
  if jsonb_array_length(r->'order'->'bar_payments') = 1 and r->'order'->'bar_payments'->0->>'status' = 'pending'
  then passes:=passes+1; else fails:=fails||('P2c '||(r->'order')::text); end if;

  -- attach + paid, as the service
  perform wp_bar_payment_attach(pid, 'cs_test_bar_1');
  r := wp_bar_payment_paid('cs_test_bar_1', 499, 'pi_x', 'pa@test.invalid');
  if r->>'error' = 'amount_mismatch' and (select status from wp_bar_payments where id = pid) = 'pending'
  then passes:=passes+1; else fails:=fails||('P3a mismatch paid it '||r::text); end if;
  r := wp_bar_payment_paid('cs_test_unknown', 500, 'pi_x', 'pa@test.invalid');
  if r->>'error' = 'not_found' then passes:=passes+1; else fails:=fails||text 'P3b unknown session'; end if;
  r := wp_bar_payment_paid('cs_test_bar_1', 500, 'pi_x', 'pa@test.invalid');
  if (r->>'ok')::bool and (r->>'first_time')::bool and (r->>'total')::numeric = 500
     and (r->'client_emails') ? 'pa@test.invalid'
  then passes:=passes+1; else fails:=fails||('P3c '||r::text); end if;
  r := wp_bar_payment_paid('cs_test_bar_1', 500, 'pi_x', 'pa@test.invalid');
  if (r->>'ok')::bool and not (r->>'first_time')::bool and (r->>'total')::numeric = 500
  then passes:=passes+1; else fails:=fails||('P4 second delivery '||r::text); end if;

  -- P5 totals on wp_drinks, client view shows paid
  if exists (select 1 from wp_drinks where event_id = evA and bar_paid_amount = 500 and bar_paid_at is not null)
     and exists (select 1 from wp_change_log where event_id = evA and area = 'bar' and summary = 'paid £500.00 behind the bar')
  then passes:=passes+1; else fails:=fails||text 'P5 total/log'; end if;
  r := wp_get_drinks();
  if (r->'order'->>'bar_paid_amount')::numeric = 500 and r->'order'->'bar_payments'->0->>'status' = 'paid'
  then passes:=passes+1; else fails:=fails||('P6 '||(r->'order')::text); end if;

  -- a second payment, abandoned
  r := wp_bar_payment_start(100);
  pid2 := (r->>'id')::uuid;
  perform wp_bar_payment_attach(pid2, 'cs_test_bar_2');
  perform wp_bar_payment_expired('cs_test_bar_2');
  if (select status from wp_bar_payments where id = pid2) = 'expired'
     and (select bar_paid_amount from wp_drinks where event_id = evA) = 500
  then passes:=passes+1; else fails:=fails||text 'P7 expiry'; end if;

  -- B sees none of A's
  perform set_config('request.jwt.claims', json_build_object('sub',uB,'email','pb@test.invalid')::text, true);
  r := wp_get_drinks();
  if jsonb_array_length(coalesce(r->'order'->'bar_payments', '[]'::jsonb)) = 0 and (r->>'event_id')::int = evB
  then passes:=passes+1; else fails:=fails||('X1 cross-couple '||(r->'order')::text); end if;
  r := wp_admin_add_bar_payment(evA, 50, 'cash');
  if r->>'error' = 'not_staff' then passes:=passes+1; else fails:=fails||text 'X2 client used staff add'; end if;

  -- staff add + remove
  perform set_config('request.jwt.claims', json_build_object('sub',uS,'email','ps@test.invalid')::text, true);
  r := wp_admin_add_bar_payment(evA, 50, 'cash on the night');
  if (r->>'ok')::bool and (select bar_paid_amount from wp_drinks where event_id = evA) = 550
  then passes:=passes+1; else fails:=fails||('S1 '||r::text); end if;
  r := wp_admin_drinks(evA);
  if jsonb_array_length(r->'bar_payments') = 2 then passes:=passes+1; else fails:=fails||('S2 '||(r->'bar_payments')::text); end if;
  r := wp_admin_remove_bar_payment(pid);
  if r->>'error' = 'not_found' and (select status from wp_bar_payments where id = pid) = 'paid'
  then passes:=passes+1; else fails:=fails||text 'S3 staff removed a Stripe payment'; end if;
  r := wp_admin_remove_bar_payment((select id from wp_bar_payments where event_id = evA and source = 'staff'));
  if (r->>'ok')::bool and (select bar_paid_amount from wp_drinks where event_id = evA) = 500
  then passes:=passes+1; else fails:=fails||('S4 '||r::text); end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails, ' | ');
  end if;
end
$t$;
