-- supabase/portal-phase02b-form-documents-test.sql
--
-- Thirteen assertions for the venue form and the document allowlist.
--
-- The ones to care about:
--   3, 4  an unknown key sent to the form is dropped, not stored
--   9     a couple cannot read another couple's document by pasting its path
--   10    nor a timesheet or untyped file on their OWN event
--   13    and the same from the other side
--
-- 9 and 10 are what netlify/functions/portal-file.js leans on: it asks
-- wp_may_read_file() with the client's own JWT before the service key signs
-- anything. If either ever fails, the signer is handing out other people's
-- paperwork — stop and fix it before shipping.
--
-- Rolled back at the end. The result arrives as an exception, by design:
--
--     ERROR: ALL 13 ASSERTIONS PASSED (rolled back)
--
-- Last run 8 September 2026: all 13 passed.

do $t$
declare
  uA uuid := '00000000-0000-4000-8000-00000000000a';
  uB uuid := '00000000-0000-4000-8000-00000000000b';
  evA int; evB int; r jsonb; a_path text; b_path text;
  fails text[] := '{}'; passes int := 0;
begin
  select (e->>'id')::int, f->>'path' into evA, a_path
    from app_data d, lateral jsonb_array_elements(d.value) e,
         lateral jsonb_array_elements(coalesce(e->'files','[]'::jsonb)) f
   where d.key='hawthbush_bookings_v6' and f->>'docType'='Event Booking Form' limit 1;
  select (e->>'id')::int, f->>'path' into evB, b_path
    from app_data d, lateral jsonb_array_elements(d.value) e,
         lateral jsonb_array_elements(coalesce(e->'files','[]'::jsonb)) f
   where d.key='hawthbush_bookings_v6' and f->>'docType'='Event Booking Form'
     and (e->>'id')::int <> evA limit 1;

  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
    (uA,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','a@test.invalid',now(),now()),
    (uB,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','b@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values
    (uA,'a@test.invalid','A','client',true),(uB,'b@test.invalid','B','client',true)
  on conflict (id) do update set role='client';
  insert into public.wp_access (event_id,email,user_id) values (evA,'a@test.invalid',uA),(evB,'b@test.invalid',uB);

  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','a@test.invalid')::text, true);

  -- 1  the form loads with every question and nothing answered
  r := wp_get_venue_form();
  if (r->>'ok')::bool and jsonb_array_length(r->'questions')=14 and (r->'progress'->>'answered')::int=0
    then passes:=passes+1; else fails:=fails||('1 form load: '||coalesce(r::text,'null')); end if;

  -- 2  a partial save works
  r := wp_save_venue_form('{"confetti":"yes","first_dance":"At Last - Etta James"}'::jsonb);
  if (r->>'ok')::bool and (r->>'saved')::int=2 then passes:=passes+1; else fails:=fails||('2 save: '||r::text); end if;

  -- 3  ALLOWLIST: unknown keys are ignored, known ones still save
  r := wp_save_venue_form('{"high_chairs":"3","is_admin":"true","__proto__":"x"}'::jsonb);
  if (r->>'ok')::bool and (r->>'saved')::int=1 and (r->>'ignored')::int=2 then passes:=passes+1;
  else fails:=fails||('3 allowlist: '||r::text); end if;

  -- 4  and nothing junk was actually stored
  r := wp_get_venue_form();
  if not (r->'answers' ? 'is_admin') then passes:=passes+1; else fails:=fails||'4 junk key stored'; end if;

  -- 5  merging, not replacing: earlier answers survive a later partial save
  if r->'answers'->>'confetti'='yes' and r->'answers'->>'high_chairs'='3'
    then passes:=passes+1; else fails:=fails||('5 merge lost data: '||(r->'answers')::text); end if;

  -- 6  progress counts real answers
  if (r->'progress'->>'answered')::int=3 then passes:=passes+1; else fails:=fails||'6 progress'; end if;

  -- 7  only allowlisted docTypes are listed
  r := wp_my_documents();
  if (r->>'ok')::bool and not exists (
       select 1 from jsonb_array_elements(r->'documents') d
        where d->>'doc_type' not in ('Event Booking Form','Accommodation Booking Form'))
    then passes:=passes+1; else fails:=fails||('7 doc allowlist: '||(r->'documents')::text); end if;

  -- 8  A may read A's own booking form
  if wp_may_read_file(a_path) then passes:=passes+1; else fails:=fails||'8 cannot read own file'; end if;

  -- 9  A MAY NOT READ B'S FILE
  if not wp_may_read_file(b_path) then passes:=passes+1; else fails:=fails||'9 READ ANOTHER COUPLE''S FILE'; end if;

  -- 10 nor a timesheet or untyped file on their own event
  if not wp_may_read_file((select f->>'path' from app_data d,
        lateral jsonb_array_elements(d.value) e, lateral jsonb_array_elements(coalesce(e->'files','[]'::jsonb)) f
        where d.key='hawthbush_bookings_v6' and (e->>'id')::int=evA
          and coalesce(f->>'docType','') not in ('Event Booking Form','Accommodation Booking Form') limit 1))
    then passes:=passes+1; else fails:=fails||'10 READ A NON-ALLOWLISTED FILE'; end if;

  -- 11 traversal and empty paths refused
  if not wp_may_read_file('bookings/../../etc/passwd') and not wp_may_read_file('') and not wp_may_read_file(null)
    then passes:=passes+1; else fails:=fails||'11 bad path accepted'; end if;

  -- ===== the other couple =====
  perform set_config('request.jwt.claims', json_build_object('sub',uB,'email','b@test.invalid')::text, true);

  -- 12 B's form is empty and A's answers are invisible
  r := wp_get_venue_form();
  if (r->'progress'->>'answered')::int=0 and not (r->'answers' ? 'confetti')
    then passes:=passes+1; else fails:=fails||'12 B sees A answers'; end if;

  -- 13 B cannot read A's file either
  if not wp_may_read_file(a_path) then passes:=passes+1; else fails:=fails||'13 B READ A''S FILE'; end if;

  if array_length(fails,1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails,' | ');
  end if;
end $t$;
