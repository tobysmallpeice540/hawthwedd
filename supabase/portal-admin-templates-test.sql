-- supabase/portal-admin-templates-test.sql
--
-- Assertions for 2026-09-09-portal-admin-templates-and-pinterest.sql. Seventeen.
--
-- ASSERTION 13 IS THE ONE TO READ. The Pinterest URL is rendered as a link that
-- staff click from the admin side, so an unchecked one is somewhere to hang a
-- phishing page under the venue's own branding. It checks four refusals, and
-- the fourth — pinterest.com.evil.example.com — is the one a lazy regex lets
-- through.
--
-- Note the shape of the whole block: it sets the JWT claims to a REAL active
-- admin. With no claims, auth.uid() is null, is_staff() is false, and every one
-- of these correctly answers not_staff — which reads as a failure and is not.
--
-- IT WRITES TO THE LIVE TEMPLATES and rolls them back. That is deliberate:
-- validating a replace-all save without replacing anything would prove nothing.
-- After running it, confirm the real templates came back — 9 checklist rows and
-- 12 timeline rows on 9 September 2026 — because a rolled-back block that did
-- not roll back is the worst outcome this file could have.
--
--     ERROR: ALL 17 ASSERTIONS PASSED (rolled back)     <- what you want
--
-- Last run 9 September 2026: all 17 passed, templates verified intact after.

do $t$
declare
  r jsonb; fails text[] := '{}'; passes int := 0;
  uAdmin uuid; uC uuid := '00000000-0000-4000-8000-0000000000f1';
  evX int; before_n int; after_n int;
begin
  select id into uAdmin from public.profiles where active and role='admin' order by id limit 1;
  if uAdmin is null then raise exception 'no active admin to test with'; end if;
  select min((e->>'id')::int) into evX from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key='hawthbush_bookings_v6';

  perform set_config('request.jwt.claims', json_build_object('sub', uAdmin)::text, true);

  -- 1. Staff read every template in one call
  r := wp_admin_templates();
  if (r->>'ok')::bool and jsonb_array_length(r->'event_types') > 0
     and jsonb_array_length(r->'checklist') > 0 then passes:=passes+1;
  else fails := fails || 'FAIL 1: templates did not come back'; end if;

  -- 2. Saving one event type leaves the others alone. Replace-all is only safe
  --    if "all" means one type.
  select count(*) into before_n from wp_timeline_template where event_type <> 'Wedding';
  r := wp_admin_save_timeline_template('Wedding',
        '[{"day_key":"event","start_time":"14:00","title":"Ceremony","duration_min":45}]'::jsonb);
  select count(*) into after_n from wp_timeline_template where event_type <> 'Wedding';
  if (r->>'ok')::bool and (r->>'saved')::int = 1
     and (select count(*) from wp_timeline_template where event_type='Wedding') = 1
     and before_n = after_n then passes:=passes+1;
  else fails := fails || 'FAIL 2: saving one type disturbed another'; end if;

  -- 3. A line on a day this type does not get is refused rather than stored and
  --    then invisible for ever, which would look like the save having failed.
  r := wp_admin_save_timeline_template('Party',
        '[{"day_key":"before","start_time":"09:00","title":"Setting up"}]'::jsonb);
  if not (r->>'ok')::bool and r->>'error' = 'day_not_offered' then passes:=passes+1;
  else fails := fails || ('FAIL 3: a party got a day before: ' || coalesce(r::text,'null')); end if;

  -- 4. A line with no time or no name is refused
  r := wp_admin_save_timeline_template('Wedding', '[{"day_key":"event","title":"No time"}]'::jsonb);
  if not (r->>'ok')::bool and r->>'error' = 'needs_time_and_title' then passes:=passes+1;
  else fails := fails || 'FAIL 4: a timeless row was accepted'; end if;

  -- 5. ...and the refusal deleted nothing. Validation runs before the delete,
  --    so a rejected save cannot leave the template empty.
  if (select count(*) from wp_timeline_template where event_type='Wedding') = 1 then passes:=passes+1;
  else fails := fails || 'FAIL 5: a refused save still wrote'; end if;

  -- 6. An event type that does not exist is refused
  r := wp_admin_save_timeline_template('Bar Mitzvah', '[]'::jsonb);
  if not (r->>'ok')::bool and r->>'error' = 'unknown_event_type' then passes:=passes+1;
  else fails := fails || 'FAIL 6: an invented event type was accepted'; end if;

  -- 7. Day names and the venue's own times are editable
  r := wp_admin_save_event_day('Wedding','event','The big day',null,'23:30'::time,null,null,null,null,null);
  if (r->>'ok')::bool
     and (select label from wp_event_type_days where event_type='Wedding' and day_key='event') = 'The big day'
     and (select music_ends from wp_event_type_days where event_type='Wedding' and day_key='event') = '23:30'::time
  then passes:=passes+1; else fails := fails || 'FAIL 7: day label/curfew did not save'; end if;

  -- 8. The checklist saves and renumbers 1..n
  r := wp_admin_save_checklist_template(
        '[{"title":"First","days_before":100},{"title":"Second","days_before":50}]'::jsonb);
  if (r->>'ok')::bool and (select count(*) from wp_checklist_template) = 2
     and (select id from wp_checklist_template where title='First') = 1
  then passes:=passes+1; else fails := fails || 'FAIL 8: checklist template did not save'; end if;

  -- 9. days_before counts BACKWARDS, so a negative one is a typo
  r := wp_admin_save_checklist_template('[{"title":"Late","days_before":-5}]'::jsonb);
  if not (r->>'ok')::bool and r->>'error' = 'bad_days_before' then passes:=passes+1;
  else fails := fails || 'FAIL 9: a negative deadline was accepted'; end if;

  -- 10. One couple's suggested day comes back
  r := wp_admin_event_timeline(evX);
  if (r->>'ok')::bool and r ? 'days' and r ? 'blocks' then passes:=passes+1;
  else fails := fails || ('FAIL 10: event timeline: ' || coalesce(r::text,'null')); end if;

  -- 11. A wedding client can do none of it
  insert into auth.users (id,instance_id,aud,role,email,created_at,updated_at)
  values (uC,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','tpl@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values (uC,'tpl@test.invalid','C','client',true)
  on conflict (id) do update set role='client', active=true;
  perform set_config('request.jwt.claims', json_build_object('sub',uC)::text, true);

  if (wp_admin_templates() ->> 'error') = 'not_staff'
     and (wp_admin_save_checklist_template('[]'::jsonb) ->> 'error') = 'not_staff'
     and (wp_admin_save_timeline_template('Wedding','[]'::jsonb) ->> 'error') = 'not_staff'
     and (wp_admin_save_event_day('Wedding','event','x') ->> 'error') = 'not_staff'
     and (wp_admin_event_timeline(evX) ->> 'error') = 'not_staff'
  then passes:=passes+1; else fails := fails || 'FAIL 11: a client reached an admin template function'; end if;

  -- 12. A real board saves
  insert into public.wp_access (event_id,email,user_id) values (evX,'tpl@test.invalid',uC);
  r := wp_set_pinterest('https://www.pinterest.co.uk/someone/our-wedding/');
  if (r->>'ok')::bool and (wp_get_pinterest() ->> 'url') like 'https://www.pinterest.co.uk/%'
  then passes:=passes+1; else fails := fails || ('FAIL 12: a board did not save: ' || coalesce(r::text,'null')); end if;

  -- 13. ── THE ONE TO READ ── anything else is refused. Staff click this link
  --     from the admin side, so an unchecked URL is a phishing page wearing the
  --     venue's branding. The last of the four is what a lazy regex lets past.
  if (wp_set_pinterest('https://evil.example.com/steal') ->> 'error') = 'not_a_pinterest_link'
     and (wp_set_pinterest('javascript:alert(1)') ->> 'error') = 'not_a_pinterest_link'
     and (wp_set_pinterest('http://www.pinterest.com/x') ->> 'error') = 'not_a_pinterest_link'
     and (wp_set_pinterest('https://pinterest.com.evil.example.com/x') ->> 'error') = 'not_a_pinterest_link'
  then passes:=passes+1; else fails := fails || 'FAIL 13: a non-Pinterest link was accepted'; end if;

  -- 14. ...and none of those refusals overwrote the good one
  if (wp_get_pinterest() ->> 'url') like 'https://www.pinterest.co.uk/%' then passes:=passes+1;
  else fails := fails || 'FAIL 14: a refused link overwrote the saved one'; end if;

  -- 15. Empty removes it
  r := wp_set_pinterest('');
  if (r->>'ok')::bool and (wp_get_pinterest() ->> 'url') is null then passes:=passes+1;
  else fails := fails || 'FAIL 15: could not remove a board'; end if;

  perform set_config('request.jwt.claims', null, true);

  -- 16. wp_shift_after is gone. A client-facing function nothing calls is not
  --     dead code — it is dead code anyone can still call.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='wp_shift_after') = 0
  then passes:=passes+1; else fails := fails || 'FAIL 16: wp_shift_after is still callable'; end if;

  -- 17. Nothing new is callable by anon
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public'
         and p.proname in ('wp_admin_templates','wp_admin_save_timeline_template',
                           'wp_admin_save_event_day','wp_admin_save_checklist_template',
                           'wp_admin_event_timeline','wp_get_pinterest','wp_set_pinterest')
         and has_function_privilege('anon', p.oid, 'execute')) = 0
  then passes:=passes+1; else fails := fails || 'FAIL 17: anon can execute a new function'; end if;

  if array_length(fails,1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails,' | ');
  end if;
end $t$;


-- ── RUN THIS AFTERWARDS ─────────────────────────────────────────────────────
-- The block above rewrites the live templates and relies on its own exception
-- to undo that. Prove it did.
--
-- Expected on 9 September 2026: 9, 12, 'The day', 00:00:00, 0, 0.

select
  (select count(*) from wp_checklist_template) as checklist_rows,
  (select count(*) from wp_timeline_template)  as timeline_rows,
  (select label      from wp_event_type_days where event_type='Wedding' and day_key='event') as wedding_day_label,
  (select music_ends from wp_event_type_days where event_type='Wedding' and day_key='event') as wedding_music_ends,
  (select count(*) from wp_event_meta) as stray_pinterest_rows,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='wp_shift_after') as shift_after_still_there;


-- ── Checking this file against the live catalogue ───────────────────────────
-- Compare the BODY, not pg_get_functiondef — Postgres prints DEFAULT NULL::text
-- where the file says default null. Bodies on 9 September 2026:
--   wp_admin_templates                006c98124ba279d78c580955662d1033  1405
--   wp_admin_save_timeline_template   472a1bf33f17b4863f4c9ceec9fb8dd8  1900
--   wp_admin_save_event_day           c0d77dd1a272a9f276ad8cfc6754b148  1076
--   wp_admin_save_checklist_template  b1d734b5a5de11ff04f9c8173ed0a7e9  1377
--   wp_admin_event_timeline           6aec285ed84426278ad458371c3a2358  1285
--   wp_get_pinterest                  c811fa40e2570c2f7d45326670db93e3   263
--   wp_set_pinterest                  5c0086299237835450f2d98736a76b63   743
