-- supabase/portal-guest-merge-test.sql
--
-- Assertions for 2026-10-25m-guest-merge.sql. Rolled back; the result arrives
-- as an exception:  ERROR: ALL n ASSERTIONS PASSED (rolled back)
-- Removes no rows.

do $t$
declare
  uA uuid := '00000000-0000-4000-8000-0000000000e1';
  uX uuid := '00000000-0000-4000-8000-0000000000e2';
  ev int; r jsonb; n0 int; fails text[] := '{}'; passes int := 0;
  f1 jsonb := '[
    {"first_name":"Ada","last_name":"Lovelace","rsvp":"yes","access_needs":"Vegan"},
    {"first_name":"tom","last_name":"THUMB","rsvp":"no"},
    {"first_name":"John","last_name":"Smith"},
    {"first_name":"New","last_name":"Person","rsvp":"yes","side":"Bride","role":"Usher"},
    {"first_name":"Declined","last_name":"Person","rsvp":"no"}
  ]';
begin
  select (e->>'id')::int into ev from app_data x, lateral jsonb_array_elements(x.value) e
   where x.key='hawthbush_bookings_v6' and (e->>'id') ~ '^\d+$'
     and not exists (select 1 from wp_access a where a.event_id = (e->>'id')::int)
     and not exists (select 1 from wp_guests g where g.event_id = (e->>'id')::int)
   order by e->>'date' desc limit 1;
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
    (uA,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','gm@test.invalid',now(),now()),
    (uX,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','gx@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values
    (uA,'gm@test.invalid','A','client',true),(uX,'gx@test.invalid','X','client',true)
  on conflict (id) do update set role = excluded.role;
  insert into public.wp_access (event_id,email,user_id) values (ev,'gm@test.invalid',uA);

  -- G1 grants
  if has_function_privilege('authenticated', 'public.wp_merge_guests(text,jsonb,boolean)'::regprocedure, 'execute')
     and not has_function_privilege('anon', 'public.wp_merge_guests(text,jsonb,boolean)'::regprocedure, 'execute')
  then passes:=passes+1; else fails:=fails||text 'G1 grants'; end if;

  -- G2 somebody with no event is refused
  perform set_config('request.jwt.claims', json_build_object('sub',uX,'email','gx@test.invalid')::text, true);
  r := wp_merge_guests('seated', f1, false);
  if r->>'error' = 'no_access' then passes:=passes+1; else fails:=fails||('G2 '||r::text); end if;

  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','gm@test.invalid')::text, true);
  perform wp_import_guests('seated', '[{"first_name":"Ada","last_name":"Lovelace"},{"first_name":"John","last_name":"Smith"},{"first_name":"John","last_name":"Smith"}]');
  perform wp_import_guests('evening', '[{"first_name":"Tom","last_name":"Thumb"}]');
  select count(*) into n0 from wp_guests where event_id = ev;

  -- M1 preview writes nothing and counts right
  r := wp_merge_guests('seated', f1, false);
  if (r->>'new')::int = 1 and (r->>'updated')::int = 2 and (r->>'unchanged')::int = 1
     and (r->>'declined')::int = 1 and (r->>'missing')::int = 1
     and (select count(*) from wp_guests where event_id = ev) = n0
     and (select rsvp from wp_guests where event_id = ev and first_name = 'Ada') is null
  then passes:=passes+1; else fails:=fails||('M1 preview '||r::text); end if;

  -- M2 the preview says what will change
  if r->'updated_lines' @> '["Ada Lovelace — reply: coming; notes: Vegan"]'::jsonb
     and r->'new_names' @> '["New Person"]'::jsonb and r->'declined_names' @> '["Declined Person"]'::jsonb
     and r->'missing_names' @> '["John Smith"]'::jsonb
  then passes:=passes+1; else fails:=fails||('M2 lines '||r::text); end if;

  -- M3 apply
  r := wp_merge_guests('seated', f1, true);
  if (r->>'new')::int = 1 and (r->>'updated')::int = 2
     and (select count(*) from wp_guests where event_id = ev) = n0 + 1
     and (select rsvp || '|' || access_needs from wp_guests where event_id = ev and first_name = 'Ada') = 'yes|Vegan'
     and (select list || '|' || rsvp from wp_guests where event_id = ev and first_name = 'Tom') = 'evening|no'
     and (select side || '|' || role || '|' || rsvp || '|' || list from wp_guests where event_id = ev and first_name = 'New') = 'Bride|Usher|yes|seated'
     and not exists (select 1 from wp_guests where event_id = ev and first_name = 'Declined')
     and exists (select 1 from wp_change_log where event_id = ev and summary like 'imported a list: 1 new, 2 updated%')
  then passes:=passes+1; else fails:=fails||('M3 apply '||r::text); end if;

  -- M4 the same file again changes nothing and adds nobody
  r := wp_merge_guests('seated', f1, true);
  if (r->>'new')::int = 0 and (r->>'updated')::int = 0 and (r->>'unchanged')::int = 4
     and (select count(*) from wp_guests where event_id = ev) = n0 + 1
  then passes:=passes+1; else fails:=fails||('M4 repeat '||r::text); end if;

  -- M5 notes are added to, never replaced, and never repeated
  r := wp_merge_guests('seated', '[{"first_name":"Ada","last_name":"Lovelace","access_needs":"Nut allergy"}]', true);
  r := wp_merge_guests('seated', '[{"first_name":"Ada","last_name":"Lovelace","access_needs":"vegan"}]', true);
  if (select access_needs from wp_guests where event_id = ev and first_name = 'Ada') = 'Vegan · Nut allergy'
  then passes:=passes+1; else fails:=fails||('M5 notes '||(select access_needs from wp_guests where event_id = ev and first_name = 'Ada')); end if;

  -- M6 a file with no reply leaves the reply alone; age only when the file has an age column
  r := wp_merge_guests('seated', '[{"first_name":"Ada","last_name":"Lovelace","rsvp":null,"age_band":"child","age_given":false}]', true);
  if (select rsvp || '|' || age_band from wp_guests where event_id = ev and first_name = 'Ada') = 'yes|adult'
  then passes:=passes+1; else fails:=fails||text 'M6 no reply / no age column'; end if;
  r := wp_merge_guests('seated', '[{"first_name":"Ada","last_name":"Lovelace","age_band":"child","age_given":true}]', true);
  if (select age_band from wp_guests where event_id = ev and first_name = 'Ada') = 'child'
  then passes:=passes+1; else fails:=fails||text 'M6b age from an age column'; end if;

  -- M7 the second John Smith in a file pairs with the second one on the list
  r := wp_merge_guests('seated', '[{"first_name":"John","last_name":"Smith","rsvp":"yes"},{"first_name":"John","last_name":"Smith","rsvp":"no"}]', false);
  if (r->>'new')::int = 0 and (r->>'updated')::int = 2
  then passes:=passes+1; else fails:=fails||('M7 duplicates '||r::text); end if;

  -- M8 bad input refused
  if wp_merge_guests('nope', f1, false)->>'error' = 'bad_list'
     and wp_merge_guests('seated', '{}'::jsonb, false)->>'error' = 'rows_not_an_array'
  then passes:=passes+1; else fails:=fails||text 'M8 bad input'; end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails, ' | ');
  end if;
end
$t$;
