-- supabase/portal-phase06b-curfews-test.sql
--
-- Twelve assertions for the corrected curfew model.
--
-- The ones to care about:
--   5   an after-midnight time sorts to the END of the night. The first
--       version added interval '24 hours' to a time, which WRAPS in Postgres,
--       so 00:30 stayed 00:30 and would have sorted before the 23:45 bar close.
--   7   the contract's access wording comes through verbatim. It is prose
--       ("10am to Midnight") and is never parsed — the corkage-note rule.
--   8   a Party with no structured access end shows NO finishing times at all,
--       rather than inventing them.
--  10-11 once an admin sets the access end, music, bar and carriages land 30
--       minutes before it and the site closes when access ends.
--
-- Rolled back at the end. The result arrives as an exception, by design:
--
--     ERROR: ALL 12 ASSERTIONS PASSED (rolled back)
--
-- Last run 9 September 2026: all 12 passed.

do $t$
declare
  uW uuid := '00000000-0000-4000-8000-00000000000a';
  uP uuid := '00000000-0000-4000-8000-00000000000b';
  evW int; evP int; r jsonb; fx jsonb;
  fails text[] := '{}'; passes int := 0;
begin
  select min((e->>'id')::int) into evW from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key='hawthbush_bookings_v6' and wp_event_type_label(e->>'eventType')='Wedding';
  select min((e->>'id')::int) into evP from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key='hawthbush_bookings_v6' and wp_event_type_label(e->>'eventType')='Party';

  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
    (uW,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','w@test.invalid',now(),now()),
    (uP,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','p@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values
    (uW,'w@test.invalid','W','client',true),(uP,'p@test.invalid','P','client',true)
  on conflict (id) do update set role='client';
  insert into public.wp_access (event_id,email,user_id) values (evW,'w@test.invalid',uW),(evP,'p@test.invalid',uP);

  -- ===== a wedding: absolute times, exactly as given =====
  perform set_config('request.jwt.claims', json_build_object('sub',uW,'email','w@test.invalid')::text, true);
  r := wp_get_timeline();
  select d->'fixed' into fx from jsonb_array_elements(r->'days') d where d->>'day_key'='event';

  -- 1  the evening starts with the bar at 23:45
  if (fx->0->>'time')='23:45:00' and (fx->0->>'title')='Bar closes' then passes:=passes+1;
  else fails:=fails||('1 first fixed point: '||coalesce(fx::text,'null')); end if;
  -- 2-4  and the rest are as Toby stated them
  if exists (select 1 from jsonb_array_elements(fx) f where f->>'title'='Music ends' and f->>'time'='00:00:00')
    then passes:=passes+1; else fails:=fails||'2 music midnight'; end if;
  if exists (select 1 from jsonb_array_elements(fx) f where f->>'title'='Carriages' and f->>'time'='00:00:00')
    then passes:=passes+1; else fails:=fails||'3 carriages midnight'; end if;
  if exists (select 1 from jsonb_array_elements(fx) f where f->>'title' like 'Site closed%' and f->>'time'='00:30:00')
    then passes:=passes+1; else fails:=fails||'4 site closed 00:30'; end if;

  -- 5  AFTER MIDNIGHT SORTS TO THE END OF THE NIGHT
  if (fx->(jsonb_array_length(fx)-1)->>'time')='00:30:00' then passes:=passes+1;
  else fails:=fails||('5 ordering, last is '||(fx->(jsonb_array_length(fx)-1)->>'time')); end if;

  -- 6  fixed points are computed, not stored, so no locked rows exist
  if not exists (select 1 from wp_timeline where event_id=evW and locked) then passes:=passes+1;
  else fails:=fails||'6 locked rows still seeded'; end if;

  -- 7  the contract's own wording passes through untouched
  if (select d->>'access_text' from jsonb_array_elements(r->'days') d where d->>'day_key'='event')
       is not distinct from
     (select e->'contract'->'values'->>'Access Event Day' from app_data dd,
        lateral jsonb_array_elements(dd.value) e
       where dd.key='hawthbush_bookings_v6' and (e->>'id')::int=evW)
    then passes:=passes+1; else fails:=fails||'7 access text not passed through'; end if;

  -- ===== a party: nothing is invented =====
  perform set_config('request.jwt.claims', json_build_object('sub',uP,'email','p@test.invalid')::text, true);
  r := wp_get_timeline();
  select d->'fixed' into fx from jsonb_array_elements(r->'days') d where d->>'day_key'='event';

  -- 8  NO ACCESS END SET, SO NO TIMES SHOWN
  if jsonb_array_length(fx)=0 then passes:=passes+1;
  else fails:=fails||('8 INVENTED PARTY TIMES WITHOUT AN ACCESS END: '||fx::text); end if;

  -- 9  and a client cannot set them
  r := wp_admin_set_access(evP,'event',null,'23:30'::time);
  if not (r->>'ok')::bool and r->>'error'='not_staff' then passes:=passes+1;
  else fails:=fails||'9 client set access times'; end if;

  -- an admin sets access ending 23:30
  perform set_config('request.jwt.claims', '{}', true);
  insert into wp_event_access (event_id, day_key, access_from, access_to)
  values (evP,'event','09:00','23:30')
  on conflict (event_id, day_key) do update set access_to = excluded.access_to;

  perform set_config('request.jwt.claims', json_build_object('sub',uP,'email','p@test.invalid')::text, true);
  r := wp_get_timeline();
  select d->'fixed' into fx from jsonb_array_elements(r->'days') d where d->>'day_key'='event';

  -- 10 music, bar and carriages land 30 minutes before access ends
  if (select count(*) from jsonb_array_elements(fx) f
       where f->>'time'='23:00:00' and f->>'title' in ('Music ends','Bar closes','Carriages')) = 3
    then passes:=passes+1; else fails:=fails||('10 party curfew: '||fx::text); end if;

  -- 11 the site closes when access ends — the last half hour is clearing up
  if exists (select 1 from jsonb_array_elements(fx) f where f->>'title' like 'Site closed%' and f->>'time'='23:30:00')
    then passes:=passes+1; else fails:=fails||'11 party site close'; end if;

  -- 12 a per-event override beats the type rule
  perform set_config('request.jwt.claims', '{}', true);
  update wp_event_access set bar_closes='22:15' where event_id=evP and day_key='event';
  perform set_config('request.jwt.claims', json_build_object('sub',uP,'email','p@test.invalid')::text, true);
  r := wp_get_timeline();
  select d->'fixed' into fx from jsonb_array_elements(r->'days') d where d->>'day_key'='event';
  if exists (select 1 from jsonb_array_elements(fx) f where f->>'title'='Bar closes' and f->>'time'='22:15:00')
    then passes:=passes+1; else fails:=fails||('12 override ignored: '||fx::text); end if;

  if array_length(fails,1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails,' | ');
  end if;
end $t$;
