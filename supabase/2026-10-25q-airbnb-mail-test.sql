-- supabase/2026-10-25q-airbnb-mail-test.sql
--
-- Assertions for 2026-10-25q-airbnb-mail.sql. Rolled back; the result arrives
-- as an exception:  ERROR: ALL n ASSERTIONS PASSED (rolled back)
-- Safe on production after the migration: every row it writes goes with the
-- rollback. Codes and threads are made up (HMZZTEST0x, thread 9000000001…).

do $t$
declare
  uS uuid := '00000000-0000-4000-8000-0000000000a1';   -- admin
  uB uuid := '00000000-0000-4000-8000-0000000000a2';   -- bar login
  r jsonb; n int; fails text[] := '{}'; passes int := 0;
begin
  -- G1 nobody but the service role reaches the tables or the writer
  if not has_table_privilege('authenticated', 'public.airbnb_mail_state', 'select')
     and not has_table_privilege('authenticated', 'public.airbnb_messages', 'select')
     and not has_table_privilege('anon', 'public.airbnb_reservations', 'select')
     and not has_function_privilege('authenticated', 'public.airbnb_ingest(jsonb)', 'execute')
     and not has_function_privilege('anon', 'public.airbnb_admin_status()', 'execute')
     and has_function_privilege('authenticated', 'public.airbnb_admin_conversation(text,text)', 'execute')
  then passes := passes + 1; else fails := fails || text 'G1 grants'; end if;

  -- I1 a reminder read FIRST (newest first), then the older confirmation:
  -- the newer payout and name stand, the confirmation fills what it lacks.
  r := airbnb_ingest(jsonb_build_object(
    'reservations', jsonb_build_array(
      jsonb_build_object('code', 'HMZZTEST01', 'thread_id', '9000000001', 'guest_name', 'Ada Lovelace-King',
                         'guests', '12 adults', 'guest_count', 12, 'payout', 2300, 'at', '2026-10-01T10:00:00Z'),
      jsonb_build_object('code', 'HMZZTEST01', 'thread_id', '9000000001', 'room_id', '11112222', 'listing', 'THE HAMLET',
                         'guest_name', 'Ada Lovelace', 'check_in', '2027-04-16', 'check_out', '2027-04-18',
                         'guests', '13 adults', 'guest_count', 13, 'payout', 2193.72, 'confirmed', true, 'at', '2026-09-22T15:00:00Z')),
    'seen', jsonb_build_array(jsonb_build_object('id', 'zztest-a', 'kind', 'reminder'), jsonb_build_object('id', 'zztest-b', 'kind', 'confirmation'))));
  if (select payout_expected = 2300 and guest_name = 'Ada Lovelace-King' and guest_count = 12 and room_id = '11112222'
             and check_in = '2027-04-16' and confirmed_at = '2026-09-22T15:00:00Z' and listing = 'THE HAMLET'
        from airbnb_reservations where code = 'HMZZTEST01')
     and (select count(*) from airbnb_mail_seen where gmail_id like 'zztest-%') = 2
  then passes := passes + 1; else fails := fails || ('I1 merge ' || (select row_to_json(x)::text from airbnb_reservations x where code = 'HMZZTEST01')); end if;

  -- I2 cancellation, change, payouts, review and messages; replaying the same
  -- emails changes nothing
  for n in 1..2 loop
    r := airbnb_ingest(jsonb_build_object(
      'cancellations', jsonb_build_array(jsonb_build_object('code', 'HMZZTEST01', 'at', '2026-09-23T09:00:00Z')),
      'alterations', jsonb_build_array(jsonb_build_object('code', 'HMZZTEST01', 'at', '2026-09-22T18:00:00Z')),
      'payouts', jsonb_build_array(jsonb_build_object('gmail_id', 'zztest-p', 'code', 'HMZZTEST01', 'amount', 2100.50, 'sent_on', '2027-04-17')),
      'reviews', jsonb_build_array(jsonb_build_object('gmail_id', 'zztest-r', 'listing', 'The Hamlet', 'check_in', '2027-04-16', 'check_out', '2027-04-18', 'stars', 5)),
      'messages', jsonb_build_array(
        jsonb_build_object('gmail_id', 'zztest-m1', 'idx', 0, 'thread_id', '9000000001', 'kind', 'enquiry', 'sent_at', '2026-09-20T10:00:00Z', 'direction', 'guest', 'author', 'Ada', 'role', 'Booker', 'body', 'Is it free?'),
        jsonb_build_object('gmail_id', 'zztest-m1', 'idx', 1, 'thread_id', '9000000001', 'kind', 'enquiry', 'sent_at', '2026-09-20T10:00:00Z', 'direction', 'host', 'author', 'Rosanna', 'role', 'Co-host', 'body', 'Yes!'),
        jsonb_build_object('gmail_id', 'zztest-m2', 'idx', 0, 'code', 'HMZZTEST01', 'kind', 'request', 'sent_at', '2026-09-21T10:00:00Z', 'direction', 'guest', 'author', 'Ada', 'role', 'Guest', 'body', 'Family weekend'),
        jsonb_build_object('gmail_id', 'zztest-m3', 'idx', 0, 'thread_id', '9000000099', 'kind', 'enquiry', 'sent_at', '2026-08-01T10:00:00Z', 'direction', 'guest', 'author', 'Bob', 'role', 'Guest', 'body', 'Never booked'),
        jsonb_build_object('gmail_id', 'zztest-m4', 'idx', 0, 'thread_id', '9000000098', 'kind', 'enquiry', 'sent_at', now() - interval '2 days', 'direction', 'guest', 'author', 'Cat', 'role', 'Guest', 'body', 'Still thinking'))));
  end loop;
  if (select cancelled_at = '2026-09-23T09:00:00Z' and altered_at = '2026-09-22T18:00:00Z' from airbnb_reservations where code = 'HMZZTEST01')
     and (select count(*) from airbnb_payouts where code = 'HMZZTEST01') = 1
     and (select count(*) from airbnb_reviews where gmail_id = 'zztest-r') = 1
     and (select count(*) from airbnb_messages where gmail_id like 'zztest-%') = 5
  then passes := passes + 1; else fails := fails || text 'I2 events stored once'; end if;

  -- I3 bad codes are ignored, not stored
  r := airbnb_ingest('{"reservations":[{"code":"nope"}],"cancellations":[{"code":"HM123"}],"payouts":[{"gmail_id":"zztest-x","code":"bad","amount":5}]}');
  if not exists (select 1 from airbnb_reservations where code in ('nope', 'HM123')) and not exists (select 1 from airbnb_payouts where gmail_id = 'zztest-x')
  then passes := passes + 1; else fails := fails || text 'I3 bad codes stored'; end if;

  -- P1 purge: the old enquiry that never booked goes; the booked thread, the
  -- request on a confirmed code and the recent enquiry stay
  perform airbnb_purge_enquiries(30);
  if not exists (select 1 from airbnb_messages where gmail_id = 'zztest-m3')
     and (select count(*) from airbnb_messages where gmail_id in ('zztest-m1', 'zztest-m2', 'zztest-m4')) = 4
  then passes := passes + 1; else fails := fails || text 'P1 purge'; end if;

  -- A1 admin only (a bar login is staff, not admin)
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
    (uS, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ab-admin@test.invalid', now(), now()),
    (uB, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ab-bar@test.invalid', now(), now())
  on conflict (id) do nothing;
  insert into public.profiles (id, email, name, role, active) values
    (uS, 'ab-admin@test.invalid', 'S', 'admin', true), (uB, 'ab-bar@test.invalid', 'B', 'bar', true)
  on conflict (id) do update set role = excluded.role, active = true;
  perform set_config('request.jwt.claims', json_build_object('sub', uB)::text, true);
  if airbnb_admin_status()->>'error' = 'not_admin' and airbnb_admin_conversation('HMZZTEST01')->>'error' = 'not_admin'
  then passes := passes + 1; else fails := fails || text 'A1 bar login read Airbnb'; end if;

  -- A2 the conversation: thread messages and the request, oldest first; status
  -- never carries the token
  perform set_config('request.jwt.claims', json_build_object('sub', uS)::text, true);
  r := airbnb_admin_conversation('HMZZTEST01');
  if (r->>'ok')::boolean and jsonb_array_length(r->'messages') = 3
     and r->'messages'->0->>'body' = 'Is it free?' and r->'messages'->1->>'direction' = 'host'
     and r->'messages'->2->>'body' = 'Family weekend'
     and (r->'payouts'->0->>'amount')::numeric = 2100.50 and r->'reservation'->>'guest_name' = 'Ada Lovelace-King'
  then passes := passes + 1; else fails := fails || ('A2 conversation ' || r::text); end if;
  r := airbnb_admin_status();
  if (r->>'ok')::boolean and not (r ? 'token_enc') and r::text not like '%token%'
  then passes := passes + 1; else fails := fails || ('A3 status ' || r::text); end if;
  r := airbnb_admin_conversation('HMZZTEST99', '9000000098');
  if jsonb_array_length(r->'messages') = 1 and r->'reservation' = 'null'::jsonb
  then passes := passes + 1; else fails := fails || ('A4 thread with no booking ' || r::text); end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails, ' | ');
  end if;
end
$t$;
