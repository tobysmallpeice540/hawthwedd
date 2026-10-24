-- supabase/security-tightening-test.sql
--
-- Assertions for 2026-10-24i-security-tightening.sql. Rolled back; the result
-- arrives as an exception:  ERROR: ALL n ASSERTIONS PASSED (rolled back)

do $t$
declare
  uA uuid := '00000000-0000-4000-8000-0000000000d1';   -- admin
  uB uuid := '00000000-0000-4000-8000-0000000000d2';   -- bar
  uN uuid := '00000000-0000-4000-8000-0000000000d3';   -- signs up claiming admin
  ev int; r jsonb; fails text[] := '{}'; passes int := 0; q text;
begin
  select (e->>'id')::int into ev from app_data x, lateral jsonb_array_elements(x.value) e
   where x.key='hawthbush_bookings_v6' and (e->>'id') ~ '^\d+$' order by e->>'date' desc limit 1;

  -- S1 storage policies all require is_staff()
  if (select count(*) from pg_policies where schemaname='storage' and tablename='objects'
        and policyname like 'booking_files_%'
        and coalesce(qual,'') || coalesce(with_check,'') like '%is_staff()%') = 4
  then passes:=passes+1; else fails:=fails||text 'S1 storage policies'; end if;

  -- S2 a sign-up claiming admin becomes a client
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values (uN,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','sn@test.invalid',
          '{"role":"admin","name":"Sneaky"}'::jsonb, now(), now());
  if (select role from profiles where id = uN) = 'client'
  then passes:=passes+1; else fails:=fails||('S2 signup role '||coalesce((select role from profiles where id = uN),'(no profile)')); end if;

  -- S3 admin-only functions: a bar login is refused, an admin is not
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
    (uA,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','sa@test.invalid',now(),now()),
    (uB,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','sb@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values
    (uA,'sa@test.invalid','A','admin',true),(uB,'sb@test.invalid','B','bar',true)
  on conflict (id) do update set role = excluded.role, active = true;

  perform set_config('request.jwt.claims', json_build_object('sub',uB,'email','sb@test.invalid')::text, true);
  r := wp_grant_access(ev, 'sb@test.invalid');
  if coalesce(r->>'ok','') <> 'true' and not exists (select 1 from wp_access where email = 'sb@test.invalid')
  then passes:=passes+1; else fails:=fails||('S3a bar granted itself access '||r::text); end if;
  r := wp_admin_sync_invoices(ev, '[]'::jsonb);
  if coalesce(r->>'ok','') <> 'true' then passes:=passes+1; else fails:=fails||text 'S3b bar synced invoices'; end if;
  r := wp_admin_add_bar_payment(ev, 10, 'test');
  if coalesce(r->>'ok','') <> 'true' then passes:=passes+1; else fails:=fails||text 'S3c bar recorded money'; end if;
  begin
    r := wp_list_access(ev);
    if r is null or coalesce(r->>'ok','true') = 'false' then passes:=passes+1; else fails:=fails||text 'S3d bar listed access'; end if;
  exception when others then passes:=passes+1;
  end;

  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','sa@test.invalid')::text, true);
  r := wp_admin_sync_invoices(ev, jsonb_build_array(
    jsonb_build_object('xero_invoice_id','t-1','status','AUTHORISED','total','10','amount_due','10','online_url','javascript:alert(1)'),
    jsonb_build_object('xero_invoice_id','t-2','status','AUTHORISED','total','20','amount_due','20','online_url','https://in.xero.com/abc')));
  if (r->>'ok')::bool
     and (select online_url from wp_invoices where event_id = ev and xero_invoice_id = 't-1') is null
     and (select online_url from wp_invoices where event_id = ev and xero_invoice_id = 't-2') = 'https://in.xero.com/abc'
  then passes:=passes+1; else fails:=fails||('S3e admin sync / url filter '||r::text); end if;
  r := wp_grant_access(ev, 'couple-x@test.invalid');
  if exists (select 1 from wp_access where email = 'couple-x@test.invalid' and event_id = ev)
  then passes:=passes+1; else fails:=fails||('S3f admin grant '||coalesce(r::text,'null')); end if;

  -- S4 table privileges
  if not has_table_privilege('anon', 'public.app_data', 'INSERT')
     and not has_table_privilege('anon', 'public.app_data', 'TRUNCATE')
     and not has_table_privilege('authenticated', 'public.app_data', 'TRUNCATE')
     and has_table_privilege('authenticated', 'public.app_data', 'UPDATE')
     and has_table_privilege('anon', 'public.app_data', 'SELECT')
     and not has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
     and not has_table_privilege('authenticated', 'public.profiles', 'INSERT')
     and has_table_privilege('authenticated', 'public.profiles', 'SELECT')
     and not has_table_privilege('anon', 'public.profiles', 'SELECT')
     and not has_table_privilege('authenticated', 'public.audit_log', 'DELETE')
     and has_table_privilege('authenticated', 'public.audit_log', 'SELECT')
  then passes:=passes+1; else fails:=fails||text 'S4 table privileges'; end if;

  -- S5 the audit trigger still writes (it runs as its owner)
  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','sa@test.invalid')::text, true);
  insert into app_data (key, value) values ('zz_security_test', '[]'::jsonb)
  on conflict (key) do update set value = excluded.value;
  if exists (select 1 from audit_log where key = 'zz_security_test')
  then passes:=passes+1; else fails:=fails||text 'S5 audit trigger'; end if;

  if array_length(fails, 1) > 0 then
    raise exception 'FAILED % of %: %', array_length(fails, 1), passes + array_length(fails, 1), array_to_string(fails, ' | ');
  end if;
  raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
end $t$;
