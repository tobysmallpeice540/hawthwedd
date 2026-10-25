-- supabase/portal-nudges-progress-test.sql
--
-- Assertions for 2026-10-25n-nudges-progress.sql. Rolled back; the result
-- arrives as an exception:  ERROR: ALL n ASSERTIONS PASSED (rolled back)
-- Removes no rows.

do $t$
declare
  uA uuid := '00000000-0000-4000-8000-0000000000f1';   -- couple
  uS uuid := '00000000-0000-4000-8000-0000000000f2';   -- admin
  ev int; d date; today date; r jsonb; e jsonb; fails text[] := '{}'; passes int := 0;
  labels text; t0 timestamptz;
begin
  -- a coming wedding with a published statement and nobody signed up yet
  select (x.e->>'id')::int, (x.e->>'date')::date into ev, d
    from (select jsonb_array_elements(value) e from app_data where key='hawthbush_bookings_v6') x
   where (x.e->>'id') ~ '^\d+$' and wp_event_type_label(x.e->>'eventType') = 'Wedding'
     and coalesce(x.e->>'status','') = 'Confirmed' and (x.e->>'date')::date > current_date + 60
     and exists (select 1 from wp_payment_schedule s where s.event_id = (x.e->>'id')::int)
     and not exists (select 1 from wp_access a where a.event_id = (x.e->>'id')::int)
     and not exists (select 1 from wp_checklist c where c.event_id = (x.e->>'id')::int)
   order by x.e->>'date' limit 1;
  -- six weeks before the day: final numbers, final balance and the drinks
  -- order are all due within three weeks; pages still open are listed.
  today := d - 42;

  -- G1 grants
  if not has_function_privilege('authenticated', 'public.wp_nudge_plan(date)'::regprocedure, 'execute')
     and not has_function_privilege('anon', 'public.wp_nudge_plan(date)'::regprocedure, 'execute')
     and not has_function_privilege('authenticated', 'public.wp_nudge_mark(integer,date,text[],integer)'::regprocedure, 'execute')
     and not has_function_privilege('authenticated', 'public.wp_nudge_unmark(integer,date)'::regprocedure, 'execute')
     and has_function_privilege('authenticated', 'public.wp_admin_portal_progress()'::regprocedure, 'execute')
     and not has_function_privilege('anon', 'public.wp_admin_portal_progress()'::regprocedure, 'execute')
     and not has_table_privilege('authenticated', 'public.wp_nudges_sent', 'select')
  then passes:=passes+1; else fails:=fails||text 'G1 grants'; end if;

  -- V1 the pages each event shows are exactly what the old rule gave
  -- (wp_visible_sections now delegates to wp_visible_sections_typed)
  if not exists (
    select 1 from (select (x.e->>'id')::int as id from (select jsonb_array_elements(value) e from app_data where key='hawthbush_bookings_v6') x
                    where (x.e->>'id') ~ '^\d+$') evs
     where wp_visible_sections(evs.id) is distinct from (
       select coalesce(jsonb_agg(k.section order by k.ord), '[]'::jsonb)
         from unnest(wp_section_keys()) with ordinality as k(section, ord)
        where coalesce(
          (select es.shown from wp_event_sections es where es.event_id = evs.id and es.section = k.section),
          (select true where exists (select 1 from wp_addon_requests r join wp_addons a on a.id = r.addon_id
                                      where r.event_id = evs.id and r.status = 'approved' and a.unlocks = k.section)),
          (select sd.shown from wp_section_defaults sd where sd.event_type = wp_event_type_of(evs.id) and sd.section = k.section),
          false)))
  then passes:=passes+1; else fails:=fails||text 'V1 visible sections changed'; end if;

  -- N1 no portal login, no reminder
  r := wp_nudge_plan(today);
  if not exists (select 1 from jsonb_array_elements(r) x where (x->>'event_id')::int = ev)
  then passes:=passes+1; else fails:=fails||text 'N1 no login still planned'; end if;

  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
    (uA,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','np@test.invalid',now(),now()),
    (uS,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','ns@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values
    (uA,'np@test.invalid','A','client',true),(uS,'ns@test.invalid','S','admin',true)
  on conflict (id) do update set role = excluded.role, active = true;
  insert into public.wp_access (event_id,email,user_id) values (ev,'np@test.invalid',uA);

  -- N2 with a login: planned, one address, items from the template,
  -- the statement and the open pages
  r := wp_nudge_plan(today);
  select x into e from jsonb_array_elements(r) x where (x->>'event_id')::int = ev;
  select string_agg(coalesce(i->>'label', i->>'section'), ' | ') into labels from jsonb_array_elements(e->'items') i;
  if e is not null and e->'emails' = '["np@test.invalid"]'::jsonb
     and exists (select 1 from jsonb_array_elements(e->'items') i where i->>'kind' = 'payment' and i->>'label' = 'Final balance')
     and exists (select 1 from jsonb_array_elements(e->'items') i where i->>'kind' = 'task' and i->>'label' = 'Confirm your final numbers')
     and exists (select 1 from jsonb_array_elements(e->'items') i where i->>'kind' = 'section' and i->>'section' = 'timeline')
  then passes:=passes+1; else fails:=fails||('N2 plan '||coalesce(labels, e::text, 'not planned')); end if;

  -- N3 with a statement, the checklist's own payment lines are not repeated
  if not exists (select 1 from jsonb_array_elements(e->'items') i where i->>'kind' = 'task' and i->>'label' ~* '(payment|balance)')
  then passes:=passes+1; else fails:=fails||('N3 duplicate payment line: '||labels); end if;

  -- N4 nothing far in the future, nothing long overdue, and never a payment
  -- before today (the statement does not record payment)
  if not exists (select 1 from jsonb_array_elements(e->'items') i where i ? 'due' and ((i->>'due')::date > today + 21 or (i->>'due')::date < today - 42))
     and not exists (select 1 from jsonb_array_elements(e->'items') i where i->>'kind' = 'payment' and (i->>'due')::date < today)
  then passes:=passes+1; else fails:=fails||('N4 window: '||labels); end if;

  -- N5 a seeded checklist is read instead of the template, and ticked items drop out
  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','np@test.invalid')::text, true);
  perform wp_get_checklist();
  update wp_checklist set done_at = now() where event_id = ev and title = 'Confirm your final numbers';
  r := wp_nudge_plan(today);
  select x into e from jsonb_array_elements(r) x where (x->>'event_id')::int = ev;
  if not exists (select 1 from jsonb_array_elements(e->'items') i where i->>'label' = 'Confirm your final numbers')
     and exists (select 1 from jsonb_array_elements(e->'items') i where i->>'kind' = 'task')
  then passes:=passes+1; else fails:=fails||text 'N5 ticked item still planned'; end if;

  -- N6 a page marked done drops out of the open-pages list
  insert into wp_section_status (event_id, section, state, ready_at) values (ev, 'timeline', 'ready', now())
  on conflict do nothing;
  r := wp_nudge_plan(today);
  select x into e from jsonb_array_elements(r) x where (x->>'event_id')::int = ev;
  if not exists (select 1 from jsonb_array_elements(e->'items') i where i->>'section' = 'timeline')
  then passes:=passes+1; else fails:=fails||text 'N6 ready page still listed'; end if;

  -- N7 a week is marked once; a failed send frees it
  if wp_nudge_mark(ev, today, array['np@test.invalid'], 3) and not wp_nudge_mark(ev, today, array['np@test.invalid'], 3)
  then passes:=passes+1; else fails:=fails||text 'N7 mark twice'; end if;
  perform wp_nudge_unmark(ev, today);
  if wp_nudge_mark(ev, today, array['np@test.invalid'], 3) and not wp_nudge_mark(ev, today, array['np@test.invalid'], 3)
  then passes:=passes+1; else fails:=fails||text 'N7b unmark frees the week'; end if;

  -- N8 a day after the event, nothing
  r := wp_nudge_plan(d + 1);
  if not exists (select 1 from jsonb_array_elements(r) x where (x->>'event_id')::int = ev)
  then passes:=passes+1; else fails:=fails||text 'N8 past event planned'; end if;

  -- P1 the board: admin only
  r := wp_admin_portal_progress();
  if r->>'error' = 'not_admin' then passes:=passes+1; else fails:=fails||text 'P1 client saw the board'; end if;

  -- P2 the board for an admin, in reasonable time
  perform set_config('request.jwt.claims', json_build_object('sub',uS,'email','ns@test.invalid')::text, true);
  t0 := clock_timestamp();
  r := wp_admin_portal_progress();
  if clock_timestamp() - t0 < interval '2 seconds' then passes:=passes+1; else fails:=fails||('P3 board took '||(clock_timestamp() - t0)::text); end if;
  select x into e from jsonb_array_elements(r->'events') x where (x->>'event_id')::int = ev;
  if (r->>'ok')::bool and e is not null and (e->>'logins')::int = 1 and e->'ready' @> '["timeline"]'::jsonb
     and (e->>'checklist_done')::int = 1 and (e->>'checklist_total')::int >= 5
     and e->'next_payment'->>'label' is not null and e->>'last_reminder' is not null
     and not exists (select 1 from jsonb_array_elements(r->'events') x where (x->>'date')::date < current_date)
     and not exists (select 1 from jsonb_array_elements(r->'events') x where (x->'next_payment'->>'due')::date < current_date)
  then passes:=passes+1; else fails:=fails||('P2 board '||coalesce(e::text,'missing')); end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails, ' | ');
  end if;
end
$t$;
