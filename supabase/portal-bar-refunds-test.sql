-- supabase/portal-bar-refunds-test.sql
--
-- Assertions for 2026-10-23h-bar-refunds.sql (needs f and h). Rolled back; the
-- result arrives as an exception: ERROR: ALL n ASSERTIONS PASSED (rolled back)
-- Removes no rows. 8/8 on production, 23 Oct, before h was applied.
--
--   R1  a partial refund comes off the total and is logged
--   R2  the same cumulative figure again changes nothing (Stripe retries)
--   R3  a refund can never exceed what was paid
--   R4  a refund that is not a bar payment (a ticket) is not_found

do $t$
declare
  uA uuid := '00000000-0000-4000-8000-0000000000c1';
  evA int; r jsonb; pid uuid; pid2 uuid; fails text[] := '{}'; passes int := 0;
begin
  select (e->>'id')::int into evA from app_data x, lateral jsonb_array_elements(x.value) e
   where x.key='hawthbush_bookings_v6' and wp_event_type_label(e->>'eventType')='Wedding'
     and not exists (select 1 from wp_access a where a.event_id = (e->>'id')::int)
   order by e->>'date' desc limit 1;
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  values (uA,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','ra@test.invalid',now(),now()) on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values (uA,'ra@test.invalid','A','client',true) on conflict (id) do update set role = excluded.role;
  insert into public.wp_access (event_id,email,user_id) values (evA,'ra@test.invalid',uA);
  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','ra@test.invalid')::text, true);

  if not has_function_privilege('authenticated', 'public.wp_bar_payment_refunded(text,numeric)'::regprocedure, 'execute')
     and not has_function_privilege('anon', 'public.wp_bar_payment_refunded(text,numeric)'::regprocedure, 'execute')
  then passes:=passes+1; else fails:=fails||text 'G1 grants'; end if;

  r := wp_bar_payment_start(500); pid := (r->>'id')::uuid;
  perform wp_bar_payment_attach(pid, 'cs_r1');
  perform wp_bar_payment_paid('cs_r1', 500, 'pi_r1', 'ra@test.invalid');
  r := wp_bar_payment_start(200); pid2 := (r->>'id')::uuid;
  perform wp_bar_payment_attach(pid2, 'cs_r2');
  perform wp_bar_payment_paid('cs_r2', 200, 'pi_r2', 'ra@test.invalid');
  if (select bar_paid_amount from wp_drinks where event_id = evA) = 700 then passes:=passes+1; else fails:=fails||text 'P0 paid 700'; end if;

  r := wp_bar_payment_refunded('pi_r1', 120);
  if (r->>'changed')::bool and (r->>'refund')::numeric = 120 and (r->>'total')::numeric = 580
     and (select bar_paid_amount from wp_drinks where event_id = evA) = 580
     and exists (select 1 from wp_change_log where event_id = evA and summary = 'refunded £120.00 of money behind the bar')
  then passes:=passes+1; else fails:=fails||('R1 '||r::text); end if;

  r := wp_bar_payment_refunded('pi_r1', 120);
  if not (r->>'changed')::bool and (r->>'total')::numeric = 580 then passes:=passes+1; else fails:=fails||('R2 repeat '||r::text); end if;

  r := wp_bar_payment_refunded('pi_r1', 900);
  if (r->>'refund')::numeric = 380 and (r->>'refunded_total')::numeric = 500 and (r->>'total')::numeric = 200
  then passes:=passes+1; else fails:=fails||('R3 capped '||r::text); end if;

  r := wp_bar_payment_refunded('pi_ticket_xyz', 50);
  if r->>'error' = 'not_found' then passes:=passes+1; else fails:=fails||text 'R4 unknown pi'; end if;

  r := wp_get_drinks();
  if (r->'order'->>'bar_paid_amount')::numeric = 200
     and exists (select 1 from jsonb_array_elements(r->'order'->'bar_payments') p where (p->>'refunded_amount')::numeric = 500)
  then passes:=passes+1; else fails:=fails||('R5 client view '||(r->'order')::text); end if;

  r := wp_bar_payment_start(50); pid := (r->>'id')::uuid;
  perform wp_bar_payment_attach(pid, 'cs_r3');
  r := wp_bar_payment_paid('cs_r3', 50, 'pi_r3', 'ra@test.invalid');
  if (r->>'total')::numeric = 250 and (select bar_paid_amount from wp_drinks where event_id = evA) = 250
  then passes:=passes+1; else fails:=fails||('R6 net total '||r::text); end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails, ' | ');
  end if;
end
$t$;
