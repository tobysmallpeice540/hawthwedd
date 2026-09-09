-- supabase/portal-phase03-invoices-test.sql
--
-- Twelve assertions for the mirrored invoice cache.
--
-- The ones to care about:
--   2   a DRAFT or VOIDED invoice is never stored, however the browser labels
--       it. This app pushes drafts, so the filter has to be here rather than
--       in the caller
--   9   one couple never sees another's invoices, or their balance
--  10   a client cannot write the cache
--  11   an invoice voided in Xero DISAPPEARS on the next sync rather than
--       lingering as a phantom amount owed
--  12   and a sync that carries no public link does not lose the one we had
--
-- Rolled back at the end.  Last run 9 September 2026: all 12 passed.

do $t$
declare
  adm uuid; uA uuid := '00000000-0000-4000-8000-00000000000a'; uB uuid := '00000000-0000-4000-8000-00000000000b';
  evA int; evB int; r jsonb;
  fails text[] := '{}'; passes int := 0;
begin
  select min((e->>'id')::int), max((e->>'id')::int) into evA, evB
    from app_data d, lateral jsonb_array_elements(d.value) e where d.key='hawthbush_bookings_v6';
  select id into adm from public.profiles where role='admin' and active limit 1;

  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
    (uA,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','a@test.invalid',now(),now()),
    (uB,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','b@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values
    (uA,'a@test.invalid','A','client',true),(uB,'b@test.invalid','B','client',true)
  on conflict (id) do update set role='client';
  insert into public.wp_access (event_id,email,user_id) values (evA,'a@test.invalid',uA),(evB,'b@test.invalid',uB);

  perform set_config('request.jwt.claims', json_build_object('sub',adm,'email','a@t')::text, true);

  r := wp_admin_sync_invoices(evA, '[
    {"xero_invoice_id":"inv-1","invoice_number":"INV-1041","invoice_date":"2026-05-01","due_date":"2026-05-15","status":"PAID","total":"1000.00","amount_due":"0","amount_paid":"1000.00","currency":"GBP","online_url":"https://in.xero.com/AAA"},
    {"xero_invoice_id":"inv-2","invoice_number":"INV-1042","invoice_date":"2026-06-01","due_date":"2026-06-15","status":"AUTHORISED","total":"2000.00","amount_due":"2000.00","amount_paid":"0","currency":"GBP"},
    {"xero_invoice_id":"inv-3","invoice_number":"DRAFT-9","status":"DRAFT","total":"999","amount_due":"999"},
    {"xero_invoice_id":"inv-4","invoice_number":"VOID-9","status":"VOIDED","total":"50","amount_due":"50"}
  ]'::jsonb);

  -- 1  only the two showable ones are stored
  if (r->>'ok')::bool and (r->>'stored')::int = 2 then passes:=passes+1;
  else fails:=fails||('1 stored: '||r::text); end if;
  -- 2  NO DRAFT OR VOIDED INVOICE IN THE TABLE
  if not exists (select 1 from wp_invoices where event_id=evA and xero_invoice_id in ('inv-3','inv-4'))
    then passes:=passes+1; else fails:=fails||'2 A DRAFT OR VOIDED INVOICE WAS STORED'; end if;
  -- 3  and it says which still need a public link
  if (r->'needs_url')::text like '%inv-2%' and (r->'needs_url')::text not like '%inv-1%'
    then passes:=passes+1; else fails:=fails||('3 needs_url: '||(r->'needs_url')::text); end if;

  -- ===== what the couple sees =====
  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','a@test.invalid')::text, true);
  r := wp_my_invoices();
  if (r->>'ok')::bool and jsonb_array_length(r->'invoices')=2 then passes:=passes+1;
  else fails:=fails||('4 portal read: '||r::text); end if;
  if (r->>'outstanding')::numeric = 2000 then passes:=passes+1;
  else fails:=fails||('5 outstanding: '||(r->>'outstanding')); end if;
  if exists (select 1 from jsonb_array_elements(r->'invoices') i
              where i->>'invoice_number'='INV-1042' and (i->>'overdue')::bool)
    then passes:=passes+1; else fails:=fails||'6 overdue not flagged'; end if;
  if exists (select 1 from jsonb_array_elements(r->'invoices') i where i->>'online_url'='https://in.xero.com/AAA')
    then passes:=passes+1; else fails:=fails||'7 online url missing'; end if;
  if nullif(r->>'checked_at','') is not null then passes:=passes+1; else fails:=fails||'8 no checked_at'; end if;

  -- 9  THE OTHER COUPLE SEES NONE OF IT
  perform set_config('request.jwt.claims', json_build_object('sub',uB,'email','b@test.invalid')::text, true);
  r := wp_my_invoices();
  if jsonb_array_length(r->'invoices')=0 and (r->>'outstanding')::numeric = 0 then passes:=passes+1;
  else fails:=fails||('9 B SEES A''S INVOICES: '||r::text); end if;

  -- 10 and cannot write the cache
  r := wp_admin_sync_invoices(evA, '[]'::jsonb);
  if not (r->>'ok')::bool and r->>'error'='not_staff' then passes:=passes+1;
  else fails:=fails||'10 client wrote the invoice cache'; end if;

  -- 11 an invoice voided in Xero disappears on the next sync
  perform set_config('request.jwt.claims', json_build_object('sub',adm,'email','a@t')::text, true);
  r := wp_admin_sync_invoices(evA, '[{"xero_invoice_id":"inv-1","invoice_number":"INV-1041","status":"PAID","total":"1000","amount_due":"0"}]'::jsonb);
  if (r->>'removed')::int = 1 and not exists (select 1 from wp_invoices where event_id=evA and xero_invoice_id='inv-2')
    then passes:=passes+1; else fails:=fails||('11 stale row kept: '||r::text); end if;

  -- 12 and that sync carried no URL, so the one we had must survive
  if (select online_url from wp_invoices where event_id=evA and xero_invoice_id='inv-1')='https://in.xero.com/AAA'
    then passes:=passes+1; else fails:=fails||'12 LOST A PUBLIC LINK ON RE-SYNC'; end if;

  if array_length(fails,1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else raise exception '% passed / FAILURES: %', passes, array_to_string(fails,' | '); end if;
end $t$;
