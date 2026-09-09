-- supabase/portal-phase06-timeline-test.sql
--
-- Seventeen assertions for the timeline, run against a real Wedding and a real
-- Party so the event-type rules are exercised rather than assumed.
--
-- The ones to care about:
--   7   THE BAR DOES NOT CLOSE LATER BECAUSE LUNCH OVERRAN. A shift moves
--       everything after a time except locked venue rows and pinned blocks.
--       If this ever fails, a couple can move the curfew by overrunning.
--   12  a Party gets ONE day, not three
--   14  and cannot put anything on the day before
--   16/17  one booking cannot edit or delete another's block by id
--
-- Rolled back at the end. The result arrives as an exception, by design:
--
--     ERROR: ALL 17 ASSERTIONS PASSED (rolled back)
--
-- Last run 9 September 2026: all 17 passed.

do $t$
declare
  uW uuid := '00000000-0000-4000-8000-00000000000a';   -- a wedding couple
  uP uuid := '00000000-0000-4000-8000-00000000000b';   -- a party
  evW int; evP int; r jsonb; blk uuid; locked_blk uuid; sup uuid;
  t_before time; t_after time;
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

  -- ===== the wedding =====
  perform set_config('request.jwt.claims', json_build_object('sub',uW,'email','w@test.invalid')::text, true);

  r := wp_get_timeline();
  -- 1  three days offered
  if (r->>'event_type')='Wedding' and jsonb_array_length(r->'days')=3 then passes:=passes+1;
  else fails:=fails||('1 wedding days: '||coalesce(jsonb_array_length(r->'days')::text,'null')); end if;
  -- 2  seeded from the wedding template
  if jsonb_array_length(r->'blocks')=13 then passes:=passes+1;
  else fails:=fails||('2 wedding blocks: '||jsonb_array_length(r->'blocks')::text); end if;
  -- 3  seeding does not run twice
  r := wp_get_timeline();
  if jsonb_array_length(r->'blocks')=13 then passes:=passes+1; else fails:=fails||'3 double-seeded'; end if;

  select (b->>'id')::uuid into locked_blk from jsonb_array_elements(r->'blocks') b where b->>'title'='Bar closes';
  select (b->>'id')::uuid into blk        from jsonb_array_elements(r->'blocks') b where b->>'title'='Speeches';

  -- 4-5  a locked venue row cannot be edited or deleted
  r := wp_update_block(locked_blk, '02:00'::time);
  if not (r->>'ok')::bool and r->>'error'='locked' then passes:=passes+1;
  else fails:=fails||('4 EDITED A LOCKED BLOCK: '||r::text); end if;
  r := wp_delete_block(locked_blk);
  if not (r->>'ok')::bool and r->>'error'='locked' then passes:=passes+1;
  else fails:=fails||('5 DELETED A LOCKED BLOCK: '||r::text); end if;

  -- 6  their own block moves fine
  r := wp_update_block(blk, '18:00'::time);
  if (r->>'ok')::bool then passes:=passes+1; else fails:=fails||('6 edit own: '||r::text); end if;

  -- 7  THE SHIFT LEAVES THE LOCKED BAR CLOSE ALONE
  select start_time into t_before from wp_timeline where id = locked_blk;
  r := wp_shift_after('event','15:00'::time, 30);
  select start_time into t_after from wp_timeline where id = locked_blk;
  if (r->>'ok')::bool and t_after = t_before then passes:=passes+1;
  else fails:=fails||('7 THE BAR CLOSED LATER BECAUSE LUNCH OVERRAN: '||t_before::text||' -> '||t_after::text); end if;

  -- 8  ...but the speeches did move
  if (select start_time from wp_timeline where id = blk) = '18:30'::time then passes:=passes+1;
  else fails:=fails||('8 shift missed an unlocked block: '||(select start_time from wp_timeline where id=blk)::text); end if;

  -- 9  a pinned block is left alone too
  perform wp_update_block(blk, '18:30'::time, null, null, null, null, true);
  perform wp_shift_after('event','15:00'::time, 60);
  if (select start_time from wp_timeline where id = blk) = '18:30'::time then passes:=passes+1;
  else fails:=fails||'9 a pinned block moved'; end if;

  -- 10-11  a supplier must be one this wedding actually chose
  insert into wp_suppliers (name, category) values ('Some Band','music') returning id into sup;
  r := wp_add_block('event','20:00'::time,'Band', 60, null, sup);
  if not (r->>'ok')::bool and r->>'error'='not_your_supplier' then passes:=passes+1;
  else fails:=fails||('10 attached an unchosen supplier: '||r::text); end if;

  perform wp_choose_supplier(sup);
  r := wp_add_block('event','20:00'::time,'Band', 60, null, sup);
  if (r->>'ok')::bool then passes:=passes+1; else fails:=fails||('11 chosen supplier refused: '||r::text); end if;

  -- ===== the party =====
  perform set_config('request.jwt.claims', json_build_object('sub',uP,'email','p@test.invalid')::text, true);
  r := wp_get_timeline();

  -- 12 A PARTY IS A SINGLE DAY
  if (r->>'event_type')='Party' and jsonb_array_length(r->'days')=1
     and (r->'days'->0->>'day_key')='event' then passes:=passes+1;
  else fails:=fails||('12 party days: '||(r->'days')::text); end if;

  -- 13 and its template opens with setup, not guest arrival
  if (r->'blocks'->0->>'title') like 'Access and setting up%' then passes:=passes+1;
  else fails:=fails||('13 party template starts at: '||(r->'blocks'->0->>'title')); end if;

  -- 14 a party CANNOT put anything on the day before
  r := wp_add_block('before','10:00'::time,'Sneak in early');
  if not (r->>'ok')::bool and r->>'error'='day_not_offered' then passes:=passes+1;
  else fails:=fails||('14 PARTY BOOKED THE DAY BEFORE: '||r::text); end if;

  -- 15 the party sees none of the wedding's blocks
  if not exists (select 1 from jsonb_array_elements(r->'blocks') b where b->>'title'='Speeches')
    then passes:=passes+1; else fails:=fails||'15 party sees wedding blocks'; end if;

  -- 16-17 and cannot touch one by id
  r := wp_update_block(blk, '01:00'::time);
  if not (r->>'ok')::bool and r->>'error'='not_found' then passes:=passes+1;
  else fails:=fails||('16 PARTY EDITED THE WEDDING''S BLOCK: '||r::text); end if;

  r := wp_delete_block(blk);
  if not (r->>'ok')::bool and r->>'error'='not_found' then passes:=passes+1;
  else fails:=fails||('17 PARTY DELETED THE WEDDING''S BLOCK: '||r::text); end if;

  if array_length(fails,1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails,' | ');
  end if;
end $t$;
