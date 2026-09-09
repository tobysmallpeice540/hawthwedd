-- supabase/portal-access-parser-test.sql
--
-- Twenty-five assertions for reading the contract's access wording.
--
-- 1-10   the phrases that must read correctly, including all three that appear
--        verbatim in live contracts
-- 11-16  the phrases that must be REFUSED rather than guessed. "10 to 6" has no
--        am/pm; reading it as 10:00-18:00 would be the corkage mistake again
-- 17     THE WORD "proposed" NEVER APPEARS IN WHAT A COUPLE RECEIVES
-- 18     and with nothing confirmed, no finishing times are shown at all
-- 24-25  once a human confirms, the derivation turns on
--
-- This test does NOT write to app_data. An earlier version did, inside a
-- rolled-back block, and it rolled back cleanly — but mutating the live events
-- array to set up a test is not a habit worth keeping, and nothing here needs
-- it. Everything it creates is in wp_ tables and auth.users.
--
-- Rolled back at the end. The result arrives as an exception, by design:
--
--     ERROR: ALL 25 ASSERTIONS PASSED (rolled back, app_data untouched)
--
-- Last run 9 September 2026: all 25 passed.

do $t$
declare
  uA uuid := '00000000-0000-4000-8000-00000000000a';
  adm uuid; evP int; r jsonb; fx jsonb;
  fails text[] := '{}'; passes int := 0;
  cases text[][] := array[
    ['Midday to 4.30pm','12:00:00','16:30:00'], ['10am to Midnight','10:00:00','00:00:00'],
    ['10am to 11.30am','10:00:00','11:30:00'],  ['10:30am to 11pm','10:30:00','23:00:00'],
    ['12pm to 12am','12:00:00','00:00:00'],     ['9am – midnight','09:00:00','00:00:00'],
    ['noon until 6pm','12:00:00','18:00:00'],   ['10am-4pm','10:00:00','16:00:00'],
    ['  10AM  TO  MIDNIGHT  ','10:00:00','00:00:00'], ['12 midnight to 6am','00:00:00','06:00:00']];
  refusals text[] := array['10 to 6','all day','from 10am','10am to whenever','','13pm to 4pm'];
  i int; p jsonb;
begin
  -- 1-10  read correctly
  for i in 1 .. array_length(cases,1) loop
    p := wp_parse_access_range(cases[i][1]);
    if (p->>'ok')::bool and p->>'from'=cases[i][2] and p->>'to'=cases[i][3] then passes:=passes+1;
    else fails:=fails||(cases[i][1]||' -> '||p::text); end if;
  end loop;

  -- 11-16  refused, not guessed
  for i in 1 .. array_length(refusals,1) loop
    p := wp_parse_access_range(refusals[i]);
    if (p->>'ok')::bool = false and nullif(p->>'reason','') is not null then passes:=passes+1;
    else fails:=fails||('guessed at "'||refusals[i]||'" -> '||p::text); end if;
  end loop;

  select min((e->>'id')::int) into evP from app_data dd, lateral jsonb_array_elements(dd.value) e
   where dd.key='hawthbush_bookings_v6' and wp_event_type_label(e->>'eventType')='Party';

  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
    (uA,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','a@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active)
  values (uA,'a@test.invalid','A','client',true) on conflict (id) do update set role='client';
  insert into public.wp_access (event_id,email,user_id) values (evP,'a@test.invalid',uA);

  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','a@test.invalid')::text, true);

  -- 17 no proposal ever reaches a couple
  r := wp_get_timeline();
  if r::text not like '%proposed%' then passes:=passes+1;
  else fails:=fails||'17 A PROPOSAL REACHED THE COUPLE'; end if;

  -- 18 nothing confirmed, so nothing shown
  select dd->'fixed' into fx from jsonb_array_elements(r->'days') dd where dd->>'day_key'='event';
  if jsonb_array_length(fx)=0 then passes:=passes+1;
  else fails:=fails||('18 invented times: '||fx::text); end if;

  -- 19-20 a client cannot reach either admin function
  r := wp_admin_access(evP);
  if not (r->>'ok')::bool and r->>'error'='not_staff' then passes:=passes+1; else fails:=fails||'19 admin leak'; end if;
  r := wp_admin_access_queue();
  if not (r->>'ok')::bool and r->>'error'='not_staff' then passes:=passes+1; else fails:=fails||'20 queue leak'; end if;

  -- ===== staff: the queue reads the real contracts, read-only =====
  select id into adm from public.profiles where role='admin' and active limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub',adm,'email','admin@test.invalid')::text, true);
  r := wp_admin_access_queue();

  -- 21 every phrase in a live contract parses
  if not exists (select 1 from jsonb_array_elements(r->'events') e where (e->'proposed'->>'ok')::bool is not true)
    then passes:=passes+1;
  else fails:=fails||('21 a real contract phrase failed to parse: '||r::text); end if;

  -- 22 and nothing is marked confirmed until a human does it
  if not exists (select 1 from jsonb_array_elements(r->'events') e where (e->>'confirmed')::bool)
    then passes:=passes+1; else fails:=fails||'22 something already confirmed'; end if;

  -- 23 a human confirms
  r := wp_admin_set_access(evP,'event','09:00'::time,'23:30'::time);
  if (r->>'ok')::bool then passes:=passes+1; else fails:=fails||('23 confirm: '||r::text); end if;

  -- ===== and only now does the derivation appear =====
  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','a@test.invalid')::text, true);
  r := wp_get_timeline();
  select dd->'fixed' into fx from jsonb_array_elements(r->'days') dd where dd->>'day_key'='event';

  -- 24 music, bar and carriages 30 minutes before access ends
  if (select count(*) from jsonb_array_elements(fx) f
       where f->>'time'='23:00:00' and f->>'title' in ('Music ends','Bar closes','Carriages'))=3
    then passes:=passes+1; else fails:=fails||('24 curfew: '||fx::text); end if;

  -- 25 site closes when access ends
  if exists (select 1 from jsonb_array_elements(fx) f where f->>'title' like 'Site closed%' and f->>'time'='23:30:00')
    then passes:=passes+1; else fails:=fails||'25 site close'; end if;

  if array_length(fails,1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back, app_data untouched)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails,' | ');
  end if;
end $t$;
