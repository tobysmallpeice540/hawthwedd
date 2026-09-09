-- supabase/portal-form-builder-test.sql
--
-- Assertions for 2026-09-09-portal-form-builder-and-sharing.sql. Fourteen.
--
-- ASSERTION 3 IS THE ONE TO READ. qkey is what each couple's answer is filed
-- under, so a save that rewrote it would orphan every answer already given —
-- still in the database, invisible for ever, nothing anywhere saying so.
-- Renaming a question is the commonest edit there is and the one somebody does
-- without thinking, so it has to be safe.
--
-- Assertion 11 is the other: a couple can offer their own supplier and cannot
-- touch the venue's, because a venue supplier's owner_event_id is null and the
-- update matches on `owner_event_id = v_event`.
--
-- TWO THINGS THAT COST ME TIME AND ARE WORTH KNOWING:
--
--   · wp_add_own_supplier() returns 'supplier_id', not 'id'.
--   · A supplier's category is a SLUG from wp_supplier_categories ('flowers'),
--     not a label ('Flowers'). Passing the label is rejected.
--
--   · And a PL/pgSQL trap: `fails := fails || 'FAIL n: ...'` with a bare quoted
--     literal resolves as ARRAY concatenation and raises "malformed array
--     literal" — but only when that branch actually runs, so it hides until
--     something fails. Cast it, or concatenate with another text value.
--
-- IT WRITES TO THE LIVE FORM and rolls it back. Validating a replace-all save
-- without replacing anything would prove nothing. Run the query at the foot
-- afterwards: 14 questions across 4 sections on 9 September 2026.
--
--     ERROR: ALL 14 ASSERTIONS PASSED (rolled back)     <- what you want
--
-- Last run 9 September 2026: all 14 passed, form verified intact after.

do $t$
declare
  r jsonb; fails text[] := '{}'; passes int := 0;
  uAdmin uuid; uX uuid := '00000000-0000-4000-8000-0000000000c1'; uY uuid := '00000000-0000-4000-8000-0000000000c2';
  evX int; evY int; sid uuid; venueSid uuid; theirSid uuid; keep_key text; off timestamptz;
begin
  select id into uAdmin from public.profiles where active and role='admin' order by id limit 1;
  if uAdmin is null then raise exception 'no active admin to test with'; end if;
  select min((e->>'id')::int), max((e->>'id')::int) into evX, evY
    from app_data d, lateral jsonb_array_elements(d.value) e where d.key='hawthbush_bookings_v6';

  insert into auth.users (id,instance_id,aud,role,email,created_at,updated_at) values
    (uX,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','fx@test.invalid',now(),now()),
    (uY,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','fy@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values
    (uX,'fx@test.invalid','X','client',true),(uY,'fy@test.invalid','Y','client',true)
  on conflict (id) do update set role='client', active=true;
  insert into public.wp_access (event_id,email,user_id) values (evX,'fx@test.invalid',uX),(evY,'fy@test.invalid',uY);

  perform set_config('request.jwt.claims', json_build_object('sub', uAdmin)::text, true);

  -- 1. The form reads back, and says how many couples have answered each one
  r := wp_admin_form_questions();
  if (r->>'ok')::bool and jsonb_array_length(r->'questions') > 0 and (r->'questions'->0) ? 'answered'
  then passes:=passes+1; else fails := fails || 'FAIL 1: could not read the form'::text; end if;
  select qkey into keep_key from wp_venue_form_questions order by sort limit 1;

  -- 2. Headings are just text on the row, so inventing one is typing a name
  r := wp_admin_save_form_questions(jsonb_build_array(
        jsonb_build_object('qkey', keep_key, 'section','Before the day','label','Renamed question','kind','text'),
        jsonb_build_object('section','Before the day','label','A new note','kind','longtext'),
        jsonb_build_object('section','My own heading','label','Pick one','kind','radio',
                           'options', jsonb_build_array('A','B','C'))));
  if (r->>'ok')::bool and (r->>'saved')::int = 3
     and (select count(distinct section) from wp_venue_form_questions) = 2
  then passes:=passes+1; else fails := fails || ('FAIL 2: ' || coalesce(r::text,'null')); end if;

  -- 3. ── THE ONE THAT MATTERS ── a renamed question KEEPS its key, so every
  --    answer already given to it is still findable.
  if (select label from wp_venue_form_questions where qkey = keep_key) = 'Renamed question'
  then passes:=passes+1; else fails := fails || 'FAIL 3: renaming changed the key'::text; end if;

  -- 4. A new question gets a key made from its wording
  if exists (select 1 from wp_venue_form_questions where qkey = 'a_new_note')
  then passes:=passes+1; else fails := fails || ('FAIL 4: keys are ' ||
        (select string_agg(qkey, ',') from wp_venue_form_questions)); end if;

  -- 5. Two questions can be worded the same; their keys cannot
  r := wp_admin_save_form_questions(jsonb_build_array(
        jsonb_build_object('section','S','label','Same wording','kind','text'),
        jsonb_build_object('section','S','label','Same wording','kind','text')));
  if (r->>'ok')::bool and (select count(distinct qkey) from wp_venue_form_questions) = 2
  then passes:=passes+1; else fails := fails || ('FAIL 5: ' || coalesce(r::text,'null')); end if;

  -- 6. A dropdown with one option is a dead end on the couple's screen
  r := wp_admin_save_form_questions(jsonb_build_array(
        jsonb_build_object('section','S','label','Broken','kind','select','options', jsonb_build_array('only'))));
  if not (r->>'ok')::bool and r->>'error' = 'needs_two_options'
  then passes:=passes+1; else fails := fails || 'FAIL 6: one-option dropdown accepted'::text; end if;

  -- 7. ...and that refusal deleted nothing. Validation runs before the delete.
  if (select count(*) from wp_venue_form_questions) = 2
  then passes:=passes+1; else fails := fails || 'FAIL 7: refused save still wrote'::text; end if;

  -- 8. An unknown kind, a blank question and a blank heading are all refused
  if (wp_admin_save_form_questions(jsonb_build_array(jsonb_build_object('section','S','label','X','kind','signature'))) ->> 'error') = 'bad_kind'
     and (wp_admin_save_form_questions(jsonb_build_array(jsonb_build_object('section','S','label','','kind','text'))) ->> 'error') = 'needs_label'
     and (wp_admin_save_form_questions(jsonb_build_array(jsonb_build_object('section','','label','X','kind','text'))) ->> 'error') = 'needs_section'
  then passes:=passes+1; else fails := fails || 'FAIL 8: bad rows accepted'::text; end if;

  -- ── suppliers ────────────────────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub',uX,'email','fx@test.invalid')::text, true);
  -- 'flowers' is the SLUG. The label 'Flowers' is rejected.
  r := wp_add_own_supplier('Their florist', 'flowers');
  sid := (r->>'supplier_id')::uuid;          -- NOT 'id'
  if sid is null then fails := fails || ('SETUP: ' || coalesce(r::text,'null')); end if;

  -- 9. Offering marks it — and does NOT publish it
  r := wp_offer_supplier(sid, true);
  select share_offered_at into off from wp_suppliers where id = sid;
  if (r->>'ok')::bool and off is not null
     and (select not public_listed and promoted_at is null from wp_suppliers where id = sid)
  then passes:=passes+1; else fails := fails || ('FAIL 9: ' || coalesce(r::text,'null')); end if;

  -- 10. ...and can be taken back
  r := wp_offer_supplier(sid, false);
  select share_offered_at into off from wp_suppliers where id = sid;
  if off is null then passes:=passes+1; else fails := fails || 'FAIL 10: still shared'::text; end if;

  -- 11. ── THE OTHER ONE ── a couple cannot offer the VENUE's supplier. Its
  --     owner_event_id is null, so the update matches nothing.
  select id into venueSid from wp_suppliers where owner_event_id is null limit 1;
  if venueSid is null then
    insert into wp_suppliers (name, category) values ('Venue florist','flowers') returning id into venueSid;
  end if;
  if (wp_offer_supplier(venueSid, true) ->> 'error') = 'not_found'
  then passes:=passes+1; else fails := fails || 'FAIL 11: touched a venue supplier'::text; end if;

  -- 12. ...nor another wedding's
  perform set_config('request.jwt.claims', json_build_object('sub',uY,'email','fy@test.invalid')::text, true);
  r := wp_add_own_supplier('Theirs', 'cake'); theirSid := (r->>'supplier_id')::uuid;
  perform set_config('request.jwt.claims', json_build_object('sub',uX,'email','fx@test.invalid')::text, true);
  if (wp_offer_supplier(theirSid, true) ->> 'error') = 'not_found'
  then passes:=passes+1; else fails := fails || 'FAIL 12: offered another wedding''s supplier'::text; end if;

  -- 13. A couple cannot edit the form
  if (wp_admin_form_questions() ->> 'error') = 'not_staff'
     and (wp_admin_save_form_questions('[]'::jsonb) ->> 'error') = 'not_staff'
  then passes:=passes+1; else fails := fails || 'FAIL 13: client reached the builder'::text; end if;

  perform set_config('request.jwt.claims', null, true);

  -- 14. Nothing new is callable by anon
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname in ('wp_admin_form_questions','wp_admin_save_form_questions','wp_offer_supplier')
         and has_function_privilege('anon', p.oid, 'execute')) = 0
  then passes:=passes+1; else fails := fails || 'FAIL 14: anon grant'::text; end if;

  if array_length(fails,1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails,' | ');
  end if;
end $t$;


-- ── RUN THIS AFTERWARDS ─────────────────────────────────────────────────────
-- The block rewrites the live form and relies on its own exception to undo it.
-- Prove it did. Expected on 9 September 2026: 14 questions, 4 sections, 0 offers.

select (select count(*) from wp_venue_form_questions)                        as questions,
       (select count(distinct section) from wp_venue_form_questions)         as sections,
       (select count(*) from wp_suppliers where share_offered_at is not null) as stray_offers;


-- ── Checking this file against the live catalogue ───────────────────────────
-- Compare the BODY, not pg_get_functiondef. Bodies on 9 September 2026:
--   wp_admin_form_questions       4b0f351b2454a178a44960340f8ee25f   732
--   wp_admin_save_form_questions  15ce17c03fc7061baa1c4b68d4e0d1fd  2659
--   wp_offer_supplier             5ee8c7fc4d2b4f65e5e231d3dea7cfc9   782
