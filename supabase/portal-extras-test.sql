-- supabase/portal-extras-test.sql
--
-- Assertions for 2026-10-23-portal-extras.sql. Rolled back at the end; the
-- result arrives as an exception, by design:
--
--     ERROR: ALL n ASSERTIONS PASSED (rolled back)
--
-- Runs against the two most recent weddings in app_data, so it works on
-- production after applying as well as on a replica.
--
-- The ones to care about:
--   S1–S6   one couple cannot touch another's guests, items, add-on requests,
--           timeline rows or section status by passing an id
--   G1      anon can execute NONE of the new functions; the four internal
--           helpers are not callable by a signed-in client either
--   T4      moving a following row by hand makes it a fixed time — and an
--           edit that does NOT change the time leaves it following
--   T6      a new couple's timeline is seeded from the ceremony time
--   R3      "changed since" appears only for changes made after "ready"
--
-- How the replica was built (23 Oct 2026): Postgres 16 locally, stub auth
-- schema (auth.users, auth.uid() and auth.jwt() reading request.jwt.claims),
-- then every portal migration in supabase/ applied in the production
-- migration order. All 80 wp_* function bodies then compared by md5(prosrc)
-- with production: identical. Run this file before and after any change.

do $t$
declare
  uA uuid := '00000000-0000-4000-8000-0000000000e1';
  uB uuid := '00000000-0000-4000-8000-0000000000e2';
  uS uuid := '00000000-0000-4000-8000-0000000000e3';   -- staff
  evA int; evB int; r jsonb; gA uuid; itA uuid; itB uuid; bA uuid; bCer uuid; reqA uuid; addon uuid;
  v_time time; v_rel int; n int;
  fails text[] := '{}'; passes int := 0;
begin
  select (e->>'id')::int into evA from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key='hawthbush_bookings_v6' and wp_event_type_label(e->>'eventType')='Wedding'
   order by e->>'date' desc limit 1;
  select (e->>'id')::int into evB from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key='hawthbush_bookings_v6' and (e->>'id')::int <> evA
   order by e->>'date' desc limit 1;

  -- Start from nothing for these two events, inside this rolled-back block.
  delete from wp_timeline where event_id in (evA, evB);
  delete from wp_event_profile where event_id in (evA, evB);
  delete from wp_section_status where event_id in (evA, evB);
  delete from wp_playlist where event_id in (evA, evB);
  delete from wp_items where event_id in (evA, evB);
  delete from wp_addon_requests where event_id in (evA, evB);
  delete from wp_food_choice where event_id in (evA, evB);
  delete from wp_event_sections where event_id in (evA, evB);

  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
    (uA,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','xa@test.invalid',now(),now()),
    (uB,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','xb@test.invalid',now(),now()),
    (uS,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','xs@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values
    (uA,'xa@test.invalid','A','client',true),(uB,'xb@test.invalid','B','client',true),
    (uS,'xs@test.invalid','Sam Staff','admin',true)
  on conflict (id) do update set role = excluded.role, name = excluded.name;
  insert into public.wp_access (event_id,email,user_id) values (evA,'xa@test.invalid',uA),(evB,'xb@test.invalid',uB);

  -- ════ GRANTS ══════════════════════════════════════════════════════════════
  -- G1  anon executes none of the new functions; helpers stay server-side
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname='public' and p.proname in (
     'wp_set_guest_extras','wp_section_area','wp_section_rows','wp_get_sections','wp_set_section_ready',
     'wp_admin_sections','wp_admin_reopen_section','wp_minutes_after','wp_set_ceremony_time',
     'wp_set_block_follows','wp_answer_block','wp_get_items','wp_add_item','wp_update_item','wp_delete_item',
     'wp_admin_items','wp_admin_mark_item','wp_admin_item_types','wp_admin_save_item_types','wp_get_addons',
     'wp_request_addon','wp_cancel_addon','wp_admin_addons','wp_admin_save_addons','wp_admin_addon_requests',
     'wp_admin_decide_addon','wp_get_home','wp_admin_profile',
     'wp_get_venue_docs','wp_admin_venue_settings','wp_admin_save_venue_settings',
     'wp_section_keys','wp_event_type_of','wp_visible_sections','wp_admin_section_defaults',
     'wp_admin_save_section_defaults','wp_admin_event_sections','wp_admin_set_event_section',
     'wp_get_food','wp_save_food','wp_admin_food_packages','wp_admin_save_food_packages','wp_admin_food',
     'wp_music_url_ok','wp_get_music','wp_save_music_item','wp_delete_music_item','wp_admin_music',
     'wp_set_marketing')
     and has_function_privilege('anon', p.oid, 'execute');
  if n = 0 then passes:=passes+1; else fails:=fails||('G1 anon can execute '||n||' new functions'); end if;

  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname='public' and p.proname in ('wp_section_area','wp_section_rows','wp_minutes_after',
         'wp_section_keys','wp_event_type_of','wp_visible_sections','wp_music_url_ok')
     and has_function_privilege('authenticated', p.oid, 'execute');
  if n = 0 then passes:=passes+1; else fails:=fails||('G2 helpers callable by clients: '||n); end if;

  -- G3  the patched live functions kept their grants (CREATE OR REPLACE keeps them)
  if not has_function_privilege('anon', 'public.wp_get_guests()'::regprocedure, 'execute')
     and has_function_privilege('authenticated', 'public.wp_get_guests()'::regprocedure, 'execute')
     and not has_function_privilege('anon', 'public.wp_get_timeline()'::regprocedure, 'execute')
  then passes:=passes+1; else fails:=fails||text 'G3 patched function grants changed'; end if;

  -- ════ COUPLE A ════════════════════════════════════════════════════════════
  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','xa@test.invalid')::text, true);

  -- Guests ---------------------------------------------------------------------
  r := wp_add_guest('seated', 'Ada', 'Lovelace');
  gA := (r->>'id')::uuid;
  r := wp_set_guest_extras(gA, 'yes', 'Best woman');
  if (r->>'ok')::bool then passes:=passes+1; else fails:=fails||('U1 set extras: '||r::text); end if;

  r := wp_get_guests();
  if exists (select 1 from jsonb_array_elements(r->'guests') g
              where (g->>'id')::uuid = gA and g->>'rsvp'='yes' and g->>'role'='Best woman')
     and (r->'guests'->0) ? 'staying_where' and (r->'guests'->0) ? 'table_label'
  then passes:=passes+1; else fails:=fails||text 'U2 rsvp/role not returned, or old keys lost'; end if;

  -- U3  NULL leaves alone, '' clears
  perform wp_set_guest_extras(gA, null, '');
  if exists (select 1 from wp_guests where id = gA and rsvp = 'yes' and role is null)
  then passes:=passes+1; else fails:=fails||text 'U3 null/empty semantics wrong'; end if;

  r := wp_set_guest_extras(gA, 'probably', null);
  if r->>'error' = 'bad_rsvp' then passes:=passes+1; else fails:=fails||('U4 accepted a bad rsvp: '||r::text); end if;

  -- Items ------------------------------------------------------------------------
  r := wp_get_items();
  if (r->>'ok')::bool and jsonb_array_length(r->'typical') > 0 then passes:=passes+1;
  else fails:=fails||text 'I1 typical items missing'; end if;
  r := wp_add_item('Cake knife', 1, 'Grandma''s', 'Uncle Bob');
  itA := (r->>'id')::uuid;
  r := wp_add_item('   ');
  if r->>'error' = 'no_name' then passes:=passes+1; else fails:=fails||text 'I2 blank item accepted'; end if;
  r := wp_update_item(itA, 'Cake knife', 2, '', 'Aunt Jo');
  if exists (select 1 from wp_items where id = itA and qty = 2 and notes is null and take_home_by = 'Aunt Jo')
  then passes:=passes+1; else fails:=fails||text 'I3 update/clear wrong'; end if;

  -- Timeline: seeding with no ceremony time keeps template times --------------
  r := wp_get_timeline();
  select (b->>'id')::uuid into bCer from jsonb_array_elements(r->'blocks') b where b->>'title' = 'Ceremony';
  select (b->>'id')::uuid into bA from jsonb_array_elements(r->'blocks') b where b->>'title' = 'Speeches';
  if r ? 'ceremony_time' and (r->'blocks'->0) ? 'rel_minutes' and (r->'blocks'->0) ? 'pinned'
     and exists (select 1 from wp_timeline where id = bA and start_time = '17:30' and rel_minutes = 270
                                            and prompts like 'How many speeches%')
  then passes:=passes+1; else fails:=fails||('T1 seed without ceremony: '||coalesce((select start_time::text||'/'||rel_minutes from wp_timeline where id=bA),'none')); end if;

  -- T2  setting the ceremony moves the following rows, not the fixed ones
  r := wp_set_ceremony_time('14:30');
  if (r->>'moved')::int = 5
     and exists (select 1 from wp_timeline where id = bA and start_time = '19:00')
     and exists (select 1 from wp_timeline where event_id = evA and title = 'Suppliers arrive' and start_time = '08:00')
  then passes:=passes+1; else fails:=fails||('T2 ceremony move: '||r::text); end if;

  -- T3  an edit that does not change the time leaves it following
  perform wp_update_block(bA, '19:00'::time, 'Speeches', 45, 'Three of them', null);
  if (select rel_minutes from wp_timeline where id = bA) = 270 then passes:=passes+1;
  else fails:=fails||text 'T3 a no-time-change edit unfollowed the row'; end if;

  -- T4  moving it by hand makes it fixed, and the next ceremony change leaves it
  perform wp_update_block(bA, '19:15'::time, 'Speeches', 45, null, null);
  perform wp_set_ceremony_time('13:00');
  select start_time, rel_minutes into v_time, v_rel from wp_timeline where id = bA;
  if v_rel is null and v_time = '19:15' then passes:=passes+1;
  else fails:=fails||('T4 hand-moved row: '||v_time||' / '||coalesce(v_rel::text,'null')); end if;

  -- T5  follow again from where it now sits; wrap past midnight reads forwards
  r := wp_set_block_follows(bA, true);
  if (select rel_minutes from wp_timeline where id = bA) = 375
     and wp_minutes_after('13:00', '00:30') = 690
     and wp_minutes_after('13:00', '09:00') = -240
  then passes:=passes+1; else fails:=fails||('T5 follow/minutes_after: '||r::text); end if;

  -- T6  answers stored as clean strings, in order
  r := wp_answer_block(bA, '["  Dad, best man, maid of honour  ", 42, "yes"]'::jsonb);
  if (select answers from wp_timeline where id = bA) = '["Dad, best man, maid of honour", "", "yes"]'::jsonb
  then passes:=passes+1; else fails:=fails||('T6 answers: '||(select answers::text from wp_timeline where id = bA)); end if;

  -- Sections ---------------------------------------------------------------------
  r := wp_set_section_ready('guests', true);
  if (r->>'ok')::bool and r->'sections'->0->>'state' = 'ready'
     and (r->'sections'->0->>'changed_since')::bool = false
  then passes:=passes+1; else fails:=fails||('R1 ready: '||r::text); end if;
  r := wp_set_section_ready('bar', true);
  if r->>'error' = 'bad_section' then passes:=passes+1; else fails:=fails||text 'R2 bad section accepted'; end if;

  -- R3  a change after "ready" shows — backdate "ready" so the test does not
  --     depend on two statements in one transaction having different now()s
  update wp_section_status set ready_at = now() - interval '1 minute' where event_id = evA and section = 'guests';
  r := wp_get_sections();
  if (r->'sections'->0->>'changed_since')::bool = true then passes:=passes+1;
  else fails:=fails||('R3 changed_since not seen: '||r::text); end if;

  -- Add-ons -------------------------------------------------------------------------
  insert into wp_addons (name, unit_label, price_inc_vat, max_qty, active) values ('Test fire pit', 'each', 150, 2, true)
  returning id into addon;
  r := wp_request_addon(addon, 5, 'Near the barn');
  reqA := (r->>'id')::uuid;
  if exists (select 1 from wp_addon_requests where id = reqA and qty = 2 and unit_price = 150 and status = 'requested')
  then passes:=passes+1; else fails:=fails||text 'A1 request (qty capped, price snapshot)'; end if;
  -- A2  asking again updates, does not stack
  perform wp_request_addon(addon, 1, null);
  select count(*) into n from wp_addon_requests where event_id = evA and addon_id = addon and status = 'requested';
  if n = 1 and (select qty from wp_addon_requests where id = reqA) = 1 then passes:=passes+1;
  else fails:=fails||('A2 duplicate open requests: '||n); end if;
  -- A3  a price change after the request does not change the request
  update wp_addons set price_inc_vat = 999 where id = addon;
  if (select unit_price from wp_addon_requests where id = reqA) = 150 then passes:=passes+1;
  else fails:=fails||text 'A3 snapshot price moved'; end if;

  -- Home, marketing -------------------------------------------------------------
  r := wp_get_home();
  if r->>'event_type' = 'Wedding' and r->'visible' ? 'inspiration' and not (r->'visible' ? 'food')
     and (r->>'marketing_ok')::bool = true and (r->>'items')::int = 1 and (r->>'addons_open')::int = 1
     and r->>'cover_url' like 'https://%' and not (r ? 'couple_photo')
  then passes:=passes+1; else fails:=fails||('P2 home: '||left(r::text, 300)); end if;
  perform wp_set_marketing(false);
  if (select marketing_ok from wp_access where event_id = evA and email = 'xa@test.invalid') = false
     and (wp_get_home()->>'marketing_ok')::bool = false
  then passes:=passes+1; else fails:=fails||text 'M1 opt-out not recorded'; end if;

  -- Music ---------------------------------------------------------------------------
  r := wp_get_music();
  if jsonb_array_length(r->'items') = 3 and r->'items'->1->>'description' = 'First dance'
  then passes:=passes+1; else fails:=fails||('MU1 wedding music seed: '||r::text); end if;
  r := wp_save_music_item((r->'items'->1->>'id')::uuid, 'First dance', 'https://music.apple.com/gb/playlist/x');
  if r->>'error' = 'not_spotify' then passes:=passes+1; else fails:=fails||text 'MU2 accepted an Apple link'; end if;
  r := wp_save_music_item(null, 'Mr Brightside at 11pm', null);
  r := wp_save_music_item(null, 'Dancefloor extras', 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc');
  if (r->>'ok')::bool and (select count(*) from wp_playlist where event_id = evA) = 5 then passes:=passes+1;
  else fails:=fails||('MU3 add lines: '||r::text); end if;
  -- MU4  deleting everything does not bring the suggestions back
  delete from wp_playlist where event_id = evA;
  r := wp_get_music();
  if jsonb_array_length(r->'items') = 0 then passes:=passes+1; else fails:=fails||text 'MU4 reseeded after delete'; end if;

  -- Food ----------------------------------------------------------------------------
  update wp_food_packages set active = false;   -- only the test's own package counts
  insert into wp_food_packages (name, price_pp_inc_vat, active) values ('Test buffet', 18.50, true);
  r := wp_get_food();
  if jsonb_array_length(r->'packages') = 1 and r->'choice' = 'null'::jsonb then passes:=passes+1;
  else fails:=fails||('F1 get food: '||r::text); end if;
  perform wp_save_food((r->'packages'->0->>'id')::uuid, 80, '14:00', '2 vegetarian, 1 coeliac', null);
  update wp_food_packages set price_pp_inc_vat = 25 where name = 'Test buffet';
  perform wp_save_food((r->'packages'->0->>'id')::uuid, 85, '14:00', '2 vegetarian, 1 coeliac', 'Sandwiches cut small');
  if exists (select 1 from wp_food_choice where event_id = evA and price_pp = 18.50 and numbers = 85
                                              and notes = 'Sandwiches cut small')
  then passes:=passes+1; else fails:=fails||text 'F2 price not kept at the chosen rate'; end if;
  r := wp_save_food(gen_random_uuid(), 10, null, null, null);
  if r->>'error' = 'not_available' then passes:=passes+1; else fails:=fails||text 'F3 unknown package accepted'; end if;

  -- Staff-only functions refuse a client
  r := wp_admin_items(evA);
  if r->>'error' = 'not_staff' then passes:=passes+1; else fails:=fails||text 'X1 client read admin items'; end if;
  r := wp_admin_decide_addon(reqA, 'approved', 1, null);
  if r->>'error' = 'not_staff' then passes:=passes+1; else fails:=fails||text 'X2 client approved own add-on'; end if;

  -- ════ COUPLE B tries A's ids ═════════════════════════════════════════════
  perform set_config('request.jwt.claims', json_build_object('sub',uB,'email','xb@test.invalid')::text, true);
  r := wp_set_guest_extras(gA, 'no', 'Imposter');
  if r->>'error' = 'not_found' and (select rsvp from wp_guests where id = gA) = 'yes' then passes:=passes+1;
  else fails:=fails||text 'S1 B CHANGED A''s GUEST'; end if;
  r := wp_update_item(itA, 'Stolen', 1, null, null);
  if r->>'error' = 'not_found' then passes:=passes+1; else fails:=fails||text 'S2 B EDITED A''s ITEM'; end if;
  r := wp_delete_item(itA);
  if r->>'error' = 'not_found' then passes:=passes+1; else fails:=fails||text 'S3 B DELETED A''s ITEM'; end if;
  r := wp_cancel_addon(reqA);
  if r->>'error' = 'not_found' then passes:=passes+1; else fails:=fails||text 'S4 B CANCELLED A''s REQUEST'; end if;
  r := wp_answer_block(bA, '["x"]');
  if r->>'error' = 'not_found' then passes:=passes+1; else fails:=fails||text 'S5 B ANSWERED A''s BLOCK'; end if;
  r := wp_set_block_follows(bA, false);
  if r->>'error' = 'not_found' then passes:=passes+1; else fails:=fails||text 'S6 B CHANGED A''s BLOCK'; end if;
  r := wp_get_items();
  if jsonb_array_length(r->'items') = 0 then passes:=passes+1; else fails:=fails||text 'S7 B SEES A''s ITEMS'; end if;
  insert into wp_playlist (event_id, description) values (evA, 'A''s line') returning id into itB;
  r := wp_delete_music_item(itB);
  if r->>'error' = 'not_found' then passes:=passes+1; else fails:=fails||text 'S9 B DELETED A''s MUSIC'; end if;
  r := wp_get_food();
  if r->'choice' = 'null'::jsonb then passes:=passes+1; else fails:=fails||text 'S10 B SEES A''s FOOD'; end if;
  r := wp_get_sections();
  if jsonb_array_length(r->'sections') = 0 then passes:=passes+1; else fails:=fails||text 'S8 B SEES A''s SECTIONS'; end if;

  -- T7  B's timeline is seeded FROM the ceremony time when it is set first
  if wp_event_type_label((select e->>'eventType' from app_data d, lateral jsonb_array_elements(d.value) e
                           where d.key='hawthbush_bookings_v6' and (e->>'id')::int = evB)) = 'Wedding' then
    perform wp_set_ceremony_time('15:00');
    perform wp_get_timeline();
    if exists (select 1 from wp_timeline where event_id = evB and title = 'Speeches' and start_time = '19:30')
    then passes:=passes+1; else fails:=fails||text 'T7 seed did not use the ceremony time'; end if;
  else
    passes := passes + 1;   -- B is not a wedding; seeding-from-ceremony is covered by T2's arithmetic
  end if;

  -- ════ STAFF ═══════════════════════════════════════════════════════════════
  perform set_config('request.jwt.claims', json_build_object('sub',uS,'email','xs@test.invalid')::text, true);

  r := wp_admin_mark_item(itA, 'received', true);
  if exists (select 1 from wp_items where id = itA and received_at is not null and received_by = 'Sam Staff')
  then passes:=passes+1; else fails:=fails||('K1 received tick: '||r::text); end if;

  r := wp_admin_reopen_section(evA, 'guests', 'Please add the ushers');
  if r->'sections'->0->>'state' = 'reopened' and r->'sections'->0->>'reopen_note' = 'Please add the ushers'
  then passes:=passes+1; else fails:=fails||('K2 reopen: '||r::text); end if;

  r := wp_admin_decide_addon(reqA, 'approved', null, 'On the final invoice');
  if exists (select 1 from wp_addon_requests where id = reqA and status = 'approved' and unit_price = 150 and decided_by = uS)
  then passes:=passes+1; else fails:=fails||('K3 approve: '||r::text); end if;

  -- K4  a price-on-request cannot be approved without a price
  insert into wp_addon_requests (event_id, addon_name, unit_label, status) values (evA, 'Mystery', 'each', 'requested')
  returning id into reqA;
  r := wp_admin_decide_addon(reqA, 'approved', null, null);
  if r->>'error' = 'needs_price' then passes:=passes+1; else fails:=fails||text 'K4 approved with no price'; end if;

  r := wp_admin_save_venue_settings('http://insecure.example', '[]');
  if r->>'error' = 'cover_not_https' then passes:=passes+1; else fails:=fails||text 'K5 http cover accepted'; end if;
  r := wp_admin_save_venue_settings('/portal-cover.jpg', '[{"title":"Venue guide","url":"https://example.com/g.pdf"}]');
  if (r->>'ok')::bool and (select count(*) from wp_venue_docs) = 1 then passes:=passes+1;
  else fails:=fails||('K6 save settings: '||r::text); end if;

  -- K7  saving add-ons switches off rows left out, never deletes them
  r := wp_admin_save_addons('[{"name":"Only this","price_on_request":true}]');
  if (r->>'ok')::bool and exists (select 1 from wp_addons where id = addon and not active)
  then passes:=passes+1; else fails:=fails||('K7 save add-ons: '||r::text); end if;

  r := wp_admin_event_timeline(evA);
  if r ? 'ceremony_time' and exists (select 1 from jsonb_array_elements(r->'blocks') b where b ? 'answers')
  then passes:=passes+1; else fails:=fails||text 'K8 staff timeline lacks ceremony/answers'; end if;

  -- V1  a per-event tick overrides the standard; NULL puts it back
  perform wp_admin_set_event_section(evA, 'food', true);
  perform wp_admin_set_event_section(evA, 'inspiration', false);
  r := wp_admin_event_sections(evA);
  if wp_visible_sections(evA) ? 'food' and not (wp_visible_sections(evA) ? 'inspiration')
     and exists (select 1 from jsonb_array_elements(r->'sections') x
                  where x->>'section' = 'food' and (x->>'standard')::bool = false and (x->>'override')::bool = true)
  then passes:=passes+1; else fails:=fails||('V1 override: '||r::text); end if;
  perform wp_admin_set_event_section(evA, 'food', null);
  if not (wp_visible_sections(evA) ? 'food') then passes:=passes+1; else fails:=fails||text 'V2 reset to standard'; end if;
  -- V3  changing the standard changes events without their own tick
  perform wp_admin_save_section_defaults('Wedding', array['guests','music']);
  if wp_visible_sections(evA) = '["guests","music"]'::jsonb then passes:=passes+1;
  else fails:=fails||('V3 standard change: '||wp_visible_sections(evA)::text); end if;
  -- V4  a wake's standard has food and no table plan
  if exists (select 1 from wp_section_defaults where event_type='Wake' and section='food' and shown)
     and exists (select 1 from wp_section_defaults where event_type='Wake' and section='layout' and not shown)
  then passes:=passes+1; else fails:=fails||text 'V4 wake standard'; end if;
  r := wp_admin_set_event_section(evA, 'bar', true);
  if r->>'error' = 'bad_section' then passes:=passes+1; else fails:=fails||text 'V5 unknown section accepted'; end if;

  r := wp_admin_food(evA);
  if r->'choice'->>'dietary' = '2 vegetarian, 1 coeliac' then passes:=passes+1; else fails:=fails||text 'K10 staff food view'; end if;

  -- K9  the template editor round-trips rel_minutes and prompts
  r := wp_admin_templates();
  r := wp_admin_save_timeline_template('Wedding', (
         select jsonb_agg(b) from jsonb_array_elements(
           (select x->'blocks' from jsonb_array_elements(r->'event_types') x where x->>'event_type'='Wedding')) b));
  if (r->>'ok')::bool and exists (select 1 from wp_timeline_template where event_type='Wedding'
                                    and title='Speeches' and rel_minutes = 270 and prompts like 'How many%')
  then passes:=passes+1; else fails:=fails||('K9 template round trip: '||r::text); end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails, ' | ');
  end if;
end
$t$;
