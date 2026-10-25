-- supabase/2026-10-25r-airbnb-once-test.sql
--
-- Assertions for 2026-10-25r-airbnb-once.sql. Rolled back; the result arrives
-- as an exception:  ERROR: ALL n ASSERTIONS PASSED (rolled back)

do $t$
declare fails text[] := '{}'; passes int := 0; m jsonb;
begin
  -- O1 one payout read from two mailboxes is stored once
  perform airbnb_ingest('{"payouts":[{"gmail_id":"zz-a","code":"HMZZTEST01","amount":100,"sent_on":"2026-10-17","payout_id":"M-ZZTEST1"}]}');
  perform airbnb_ingest('{"payouts":[{"gmail_id":"zz-b","code":"HMZZTEST01","amount":100,"sent_on":"2026-10-17","payout_id":"M-ZZTEST1"}]}');
  if (select count(*) from airbnb_payouts where code = 'HMZZTEST01') = 1
  then passes := passes + 1; else fails := fails || text 'O1 payout doubled'; end if;

  -- O2 a second payout for the same booking (another reference) is kept
  perform airbnb_ingest('{"payouts":[{"gmail_id":"zz-c","code":"HMZZTEST01","amount":50,"sent_on":"2026-11-17","payout_id":"M-ZZTEST2"}]}');
  if (select sum(amount) from airbnb_payouts where code = 'HMZZTEST01') = 150
  then passes := passes + 1; else fails := fails || text 'O2 second payout lost'; end if;

  -- O3 one message read from two mailboxes (arrival seconds apart) shows once
  m := '{"thread_id":"9000000001","kind":"reservation","direction":"guest","author":"Ada","role":"Booker","body":"Can we bring a dog?"}';
  perform airbnb_ingest(jsonb_build_object('messages', jsonb_build_array(m || '{"gmail_id":"zz-m1","idx":0,"sent_at":"2026-10-07T09:57:46Z"}')));
  perform airbnb_ingest(jsonb_build_object('messages', jsonb_build_array(m || '{"gmail_id":"zz-m2","idx":0,"sent_at":"2026-10-07T09:58:03Z"}')));
  perform airbnb_ingest(jsonb_build_object('messages', jsonb_build_array(m || '{"gmail_id":"zz-m1","idx":0,"sent_at":"2026-10-07T09:57:46Z"}')));
  if (select count(*) from airbnb_messages where thread_id = '9000000001') = 1
  then passes := passes + 1; else fails := fails || text 'O3 message doubled'; end if;

  -- O4 the same words said again days later, or by the other side, are kept
  perform airbnb_ingest(jsonb_build_object('messages', jsonb_build_array(
    m || '{"gmail_id":"zz-m3","idx":0,"sent_at":"2026-10-12T10:00:00Z"}',
    (m || '{"gmail_id":"zz-m4","idx":0,"sent_at":"2026-10-07T10:30:00Z"}') || '{"direction":"host","author":"Rosanna"}')));
  if (select count(*) from airbnb_messages where thread_id = '9000000001') = 3
  then passes := passes + 1; else fails := fails || text 'O4 a real repeat was dropped'; end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails, ' | ');
  end if;
end
$t$;
