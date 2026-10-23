-- supabase/portal-uploads-webcast-test.sql
--
-- Photos & films, the webcast page, and music suggestions by event type
-- (2026-10-23-portal-extras.sql §9 and §11). Rolled back; the result arrives
-- as an exception:  ERROR: ALL n ASSERTIONS PASSED (rolled back)
--
-- The ones to care about:
--   U2  the database decides the storage path, under the caller's own event
--   U5  a client cannot mark an upload ready — only the service key can
--   U6  one client cannot find another's upload by id
--   W2  the webcast page appears only once the webcast add-on is CONFIRMED

do $t$
declare
  uA uuid := '00000000-0000-4000-8000-0000000000f1';
  uB uuid := '00000000-0000-4000-8000-0000000000f2';
  uS uuid := '00000000-0000-4000-8000-0000000000f3';
  evA int; evB int; r jsonb; upl uuid; wc uuid; req uuid; v_type text;
  fails text[] := '{}'; passes int := 0;
begin
  select (e->>'id')::int into evA from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key='hawthbush_bookings_v6' order by e->>'date' desc limit 1;
  select (e->>'id')::int into evB from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key='hawthbush_bookings_v6' and (e->>'id')::int <> evA order by e->>'date' desc limit 1;
  delete from wp_event_sections where event_id in (evA, evB);
  delete from wp_uploads where event_id in (evA, evB);
  delete from wp_addon_requests where event_id in (evA, evB);
  delete from wp_playlist where event_id in (evA, evB);
  delete from wp_event_profile where event_id in (evA, evB);

  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
    (uA,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','ua@test.invalid',now(),now()),
    (uB,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','ub@test.invalid',now(),now()),
    (uS,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','us@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values
    (uA,'ua@test.invalid','A','client',true),(uB,'ub@test.invalid','B','client',true),(uS,'us@test.invalid','S','admin',true)
  on conflict (id) do update set role = excluded.role;
  insert into public.wp_access (event_id,email,user_id) values (evA,'ua@test.invalid',uA),(evB,'ub@test.invalid',uB);

  -- ── music suggestions ──
  perform set_config('request.jwt.claims', json_build_object('sub',uS,'email','us@test.invalid')::text, true);
  v_type := wp_event_type_of(evB);
  r := wp_admin_save_music_defaults(v_type, array['Arrival — background music', 'Procession', 'Song 1', 'Song 1', ' ', 'Song 2']);
  r := wp_admin_music_defaults();
  if exists (select 1 from jsonb_array_elements(r->'types') x where x->>'event_type' = v_type
               and x->'lines' = '["Arrival — background music","Procession","Song 1","Song 2"]'::jsonb)
  then passes:=passes+1; else fails:=fails||text 'M1 defaults saved wrong'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub',uB,'email','ub@test.invalid')::text, true);
  r := wp_get_music();
  if jsonb_array_length(r->'items') = 4 and r->'items'->1->>'description' = 'Procession' then passes:=passes+1;
  else fails:=fails||('M2 seed from defaults: '||r::text); end if;

  -- ── uploads ──
  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','ua@test.invalid')::text, true);
  -- U1  refused while the section is not shown for this event
  update wp_section_defaults set shown = false where section = 'uploads';
  r := wp_upload_slot('mum.jpg', 1000, 'image/jpeg');
  if r->>'error' = 'not_available' then passes:=passes+1; else fails:=fails||('U1 '||r::text); end if;
  insert into wp_event_sections (event_id, section, shown) values (evA, 'uploads', true);
  r := wp_upload_slot('../../etc/passwd.jpg', 2000000, 'image/jpeg');
  upl := (r->>'id')::uuid;
  -- U2  the path is the database's, under the caller's event
  if r->>'path' = evA || '/' || upl || '.jpg' then passes:=passes+1; else fails:=fails||('U2 path: '||r::text); end if;
  r := wp_upload_slot('x.exe', 10, 'application/x-msdownload');
  if r->>'error' = 'bad_type' then passes:=passes+1; else fails:=fails||text 'U3 bad type accepted'; end if;
  r := wp_upload_slot('huge.mov', 10::bigint * 1024 * 1024 * 1024, 'video/quicktime');
  if r->>'error' = 'too_big' then passes:=passes+1; else fails:=fails||text 'U4 too big accepted'; end if;
  -- U5  not visible until confirmed, and a client cannot confirm
  r := wp_get_uploads();
  if jsonb_array_length(r->'uploads') = 0
     and not has_function_privilege('authenticated', 'public.wp_upload_confirm(uuid,bigint)'::regprocedure, 'execute')
     and not has_function_privilege('authenticated', 'public.wp_upload_forget(uuid)'::regprocedure, 'execute')
  then passes:=passes+1; else fails:=fails||text 'U5 pending visible, or confirm callable'; end if;
  r := wp_upload_path(upl, 'view');
  if r->>'error' = 'not_ready' then passes:=passes+1; else fails:=fails||text 'U5b viewable before confirm'; end if;
  perform wp_upload_confirm(upl, 1999999);    -- as the function would, with the service key
  r := wp_get_uploads();
  if jsonb_array_length(r->'uploads') = 1 and (r->'uploads'->0->>'size_bytes')::bigint = 1999999 then passes:=passes+1;
  else fails:=fails||('U5c after confirm: '||r::text); end if;
  if exists (select 1 from wp_change_log where event_id = evA and area = 'uploads' and summary like 'sent %')
  then passes:=passes+1; else fails:=fails||text 'U5d confirm not in the change log (changed-since would miss it)'; end if;
  perform wp_set_upload_caption(upl, 'Mum at Brighton, 1972');
  -- U6  B cannot find A's upload
  perform set_config('request.jwt.claims', json_build_object('sub',uB,'email','ub@test.invalid')::text, true);
  r := wp_upload_path(upl, 'delete');
  if r->>'error' = 'not_found' then passes:=passes+1; else fails:=fails||text 'U6 B FOUND A''s UPLOAD'; end if;
  r := wp_set_upload_caption(upl, 'x');
  if r->>'error' = 'not_found' then passes:=passes+1; else fails:=fails||text 'U7 B CAPTIONED A''s UPLOAD'; end if;
  -- U8  staff can see it
  perform set_config('request.jwt.claims', json_build_object('sub',uS,'email','us@test.invalid')::text, true);
  r := wp_upload_path(upl, 'view');
  if (r->>'ok')::bool and r->>'path' like evA || '/%' then passes:=passes+1; else fails:=fails||text 'U8 staff view'; end if;
  r := wp_admin_uploads(evA);
  if r->'uploads'->0->>'caption' = 'Mum at Brighton, 1972' then passes:=passes+1; else fails:=fails||text 'U9 staff list'; end if;

  -- ── webcast ──
  r := wp_admin_save_webcast(evA, 'http://insecure.example', 'pw', null);
  if r->>'error' = 'url_not_https' then passes:=passes+1; else fails:=fails||text 'W0 http accepted'; end if;
  perform wp_admin_save_webcast(evA, 'https://stream.example/abc', 'lilies', 'Starts 11:45');
  insert into wp_addons (name, unlocks, price_inc_vat, active) values ('Test webcast', 'webcast', 150, true) returning id into wc;
  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','ua@test.invalid')::text, true);
  r := wp_get_webcast();
  if r->>'error' = 'not_available' then passes:=passes+1; else fails:=fails||text 'W1 webcast shown before booked'; end if;
  r := wp_request_addon(wc, 1, null);
  req := (r->>'id')::uuid;
  r := wp_get_webcast();
  if r->>'error' = 'not_available' then passes:=passes+1; else fails:=fails||text 'W2 shown on request, before confirmed'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub',uS,'email','us@test.invalid')::text, true);
  perform wp_admin_decide_addon(req, 'approved', null, null);
  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','ua@test.invalid')::text, true);
  r := wp_get_webcast();
  if r->>'stream_url' = 'https://stream.example/abc' and r->>'password' = 'lilies'
     and wp_get_home()->'visible' ? 'webcast'
  then passes:=passes+1; else fails:=fails||('W3 after confirm: '||r::text); end if;
  -- W4  a per-event untick still hides it
  insert into wp_event_sections (event_id, section, shown) values (evA, 'webcast', false);
  r := wp_get_webcast();
  if r->>'error' = 'not_available' then passes:=passes+1; else fails:=fails||text 'W4 override ignored'; end if;
  -- W5  B never sees A's stream
  perform set_config('request.jwt.claims', json_build_object('sub',uB,'email','ub@test.invalid')::text, true);
  r := wp_get_webcast();
  if coalesce(r->>'stream_url', '') <> 'https://stream.example/abc' then passes:=passes+1; else fails:=fails||text 'W5 B SAW A''s STREAM'; end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails, ' | ');
  end if;
end
$t$;
