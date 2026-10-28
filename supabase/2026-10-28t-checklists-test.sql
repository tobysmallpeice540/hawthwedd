-- supabase/2026-10-28t-checklists-test.sql
--
-- Assertions for 2026-10-28t-checklists.sql. Run against a SCRATCH database
-- AFTER the migration, with stand-ins for auth.uid() (request.jwt.claim.sub),
-- the roles (anon, authenticated, service_role), profiles, is_staff(),
-- wp_is_admin(), wp_drinks and box_events, and these profiles:
--   …0a Toby Smallpeice admin · …0b Lisa admin · …0c '' bar ·
--   …0d Toby Cleaner cleaner · …0e Toby Jones admin · …0f client
-- Each block raises on failure; all passing prints "checklists: all assertions passed".

create or replace function pg_temp.as_user(p text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(p, ''), false); $$;

do $t$
declare
  toby  text := '00000000-0000-0000-0000-00000000000a';
  lisa  text := '00000000-0000-0000-0000-00000000000b';
  bar   text := '00000000-0000-0000-0000-00000000000c';
  hk    text := '00000000-0000-0000-0000-00000000000d';
  cli   text := '00000000-0000-0000-0000-00000000000f';
  v jsonb; tid uuid; tid2 uuid; rid uuid; rid2 uuid; iid uuid; n int; its jsonb;
begin
  delete from chk_runs; delete from chk_templates; delete from wp_drinks;

  -- 1. Names on a list.
  if chk_person_label(toby::uuid) <> 'Toby S' then raise exception '1a clash initial: %', chk_person_label(toby::uuid); end if;
  if chk_person_label(lisa::uuid) <> 'Lisa' then raise exception '1b first name'; end if;
  if chk_person_label(bar::uuid) <> 'Bar' or chk_person_label(hk::uuid) <> 'Housekeeping' then raise exception '1c shared logins'; end if;
  if chk_who_label('role:admin') <> 'Office' or chk_who_label('anyone') <> 'Anyone' then raise exception '1d groups'; end if;

  -- 2. Templates: admin only, checked.
  its := jsonb_build_array(
    jsonb_build_object('title', 'Beds made', 'who', 'role:cleaner', 'due_min', -120),
    jsonb_build_object('title', 'Float in till', 'detail', '£150 in coins', 'who', 'role:bar'),
    jsonb_build_object('title', 'Check heating', 'who', 'person:' || lisa, 'due_min', 30));
  perform pg_temp.as_user(bar);
  v := chk_template_save(jsonb_build_object('title', 'X', 'trig', jsonb_build_object('kind', 'manual'), 'items', its));
  if (v->>'ok')::boolean then raise exception '2a bar saved a template'; end if;
  perform pg_temp.as_user(toby);
  v := chk_template_save(jsonb_build_object('title', 'X', 'trig', jsonb_build_object('kind', 'weekly', 'weekday', 8, 'time', '09:00'), 'items', its));
  if (v->>'ok')::boolean then raise exception '2b weekday 8 accepted'; end if;
  v := chk_template_save(jsonb_build_object('title', 'X', 'trig', jsonb_build_object('kind', 'manual'), 'items', '[]'::jsonb));
  if (v->>'ok')::boolean then raise exception '2c no items accepted'; end if;
  v := chk_template_save(jsonb_build_object('title', 'X', 'trig', jsonb_build_object('kind', 'manual'),
         'items', jsonb_build_array(jsonb_build_object('title', 'a', 'who', 'person:' || cli))));
  if (v->>'ok')::boolean then raise exception '2d a client assigned'; end if;
  v := chk_template_save(jsonb_build_object('title', 'Arrival', 'trig', jsonb_build_object('kind', 'checkin', 'property', null, 'offset_min', -720),
         'items', its, 'default_due_min', -60));
  if not (v->>'ok')::boolean then raise exception '2e good save refused: %', v; end if;
  tid := (v->>'id')::uuid;
  if (select jsonb_array_length(items) from chk_templates where id = tid) <> 3
     or (select items->1->>'due_min' from chk_templates where id = tid) is not null
     or (select items->0->>'id' from chk_templates where id = tid) is null then raise exception '2f items not normalised'; end if;

  -- 3. Start now: a list with its items due from now.
  v := chk_start_now(tid);
  rid := (v->>'run_id')::uuid;
  if (select count(*) from chk_run_items where run_id = rid) <> 3 then raise exception '3a items not copied'; end if;
  if abs(extract(epoch from (select due_at - now() from chk_run_items where run_id = rid and position = 2))) > 60*60 + 5
     or abs(extract(epoch from (select due_at - now() from chk_run_items where run_id = rid and position = 2))) < 60*60 - 5
    then raise exception '3b default due not applied'; end if;
  if (select who_label from chk_run_items where run_id = rid and position = 3) <> 'Lisa' then raise exception '3c label'; end if;

  -- 4. Who sees what.
  perform pg_temp.as_user(bar);
  v := chk_live();
  if jsonb_array_length(v->'runs') <> 1 then raise exception '4a bar cannot see a list with a bar item'; end if;
  if (v->'runs'->0->'items'->1->>'mine')::boolean is not true or (v->'runs'->0->'items'->0->>'mine')::boolean then raise exception '4b mine flags'; end if;
  if jsonb_array_length(v->'notes') <> 0 then raise exception '4c bar given notes'; end if;
  perform pg_temp.as_user(toby);
  tid2 := ((chk_template_save(jsonb_build_object('title', 'Office only', 'trig', jsonb_build_object('kind', 'manual'),
            'items', jsonb_build_array(jsonb_build_object('title', 'Invoices', 'who', 'role:admin')))))->>'id')::uuid;
  rid2 := ((chk_start_now(tid2))->>'run_id')::uuid;
  perform pg_temp.as_user(bar);
  if jsonb_array_length((chk_live())->'runs') <> 1 then raise exception '4d bar sees an office-only list'; end if;
  if (chk_run_get(rid2))->>'error' <> 'not_yours' then raise exception '4e bar opened an office-only list'; end if;
  perform pg_temp.as_user(cli);
  if (chk_live())->>'error' <> 'not_staff' then raise exception '4f a client read lists'; end if;
  perform pg_temp.as_user(toby);
  if jsonb_array_length((chk_live())->'runs') <> 2 then raise exception '4g admin sees all'; end if;

  -- 5. Ticking.
  perform pg_temp.as_user(bar);
  iid := (select id from chk_run_items where run_id = rid and position = 2);
  v := chk_tick(iid, 'done');
  if not (v->>'ok')::boolean or (select done_by_name from chk_run_items where id = iid) <> 'Bar' then raise exception '5a tick by bar: %', v; end if;
  v := chk_tick((select id from chk_run_items where run_id = rid and position = 1), 'note', '  ');
  if v->>'error' <> 'comment_needed' then raise exception '5b note with no comment'; end if;
  v := chk_tick((select id from chk_run_items where run_id = rid and position = 1), 'na');
  if not (v->>'ok')::boolean then raise exception '5c n/a refused'; end if;
  perform pg_temp.as_user(hk);
  if (chk_tick(iid, 'open'))->>'error' <> 'not_your_tick' then raise exception '5d someone else unticked'; end if;
  perform pg_temp.as_user(bar);
  v := chk_tick((select id from chk_run_items where run_id = rid and position = 3), 'note', 'Boiler pressure low');
  if (select status from chk_runs where id = rid) <> 'done' then raise exception '5e last tick did not finish the list'; end if;
  if (select comment from chk_run_items where run_id = rid and position = 3) <> 'Boiler pressure low' then raise exception '5f comment'; end if;
  perform pg_temp.as_user(toby);
  v := chk_live();
  if jsonb_array_length(v->'notes') <> 1 or v->'notes'->0->>'by' <> 'Bar' then raise exception '5g note not on the admin home: %', v->'notes'; end if;
  if (select count(*) from jsonb_array_elements(v->'runs') r where r->>'id' = rid::text) <> 0 then raise exception '5h finished list still live'; end if;
  v := chk_tick(iid, 'open');
  if not (v->>'ok')::boolean or (select status from chk_runs where id = rid) <> 'open' then raise exception '5i admin untick did not reopen'; end if;
  perform chk_seen(array[(select id from chk_run_items where run_id = rid and position = 3)], '{}');
  if jsonb_array_length((chk_live())->'notes') <> 0 then raise exception '5j note still unread after Read'; end if;

  -- 6. Ignore and restore.
  perform pg_temp.as_user(bar);
  v := chk_ignore(rid, 'Event cancelled');
  if not (v->>'ok')::boolean or (select closed_by_name from chk_runs where id = rid) <> 'Bar' then raise exception '6a ignore'; end if;
  if (chk_tick(iid, 'done'))->>'error' <> 'closed' then raise exception '6b ticked an ignored list'; end if;
  if (chk_restore(rid))->>'error' <> 'not_admin' then raise exception '6c bar restored'; end if;
  perform pg_temp.as_user(toby);
  if jsonb_array_length((chk_live())->'closed') <> 1 then raise exception '6d ignored list not shown to admin'; end if;
  v := chk_restore(rid);
  if not (v->>'ok')::boolean or (select status from chk_runs where id = rid) <> 'open' then raise exception '6e restore'; end if;
  if jsonb_array_length((chk_past(30))->'runs') <> 0 then raise exception '6f past should be empty now'; end if;

  -- 7. The worker.
  update chk_templates set fire_from = now() - interval '10 days' where id = tid;
  v := chk_worker_apply(jsonb_build_object('fire', jsonb_build_array(
         jsonb_build_object('template_id', tid, 'anchor_key', 'in:A1:hamlet', 'anchor_at', now() + interval '6 hours',
                            'opens_at', now() - interval '6 hours', 'context', 'Hamlet · Smith', 'link', jsonb_build_object('kind', 'accom', 'id', 'A1')),
         jsonb_build_object('template_id', tid, 'anchor_key', 'in:A1:hamlet', 'anchor_at', now() + interval '6 hours', 'opens_at', now() - interval '6 hours'),
         jsonb_build_object('template_id', tid, 'anchor_key', 'in:A0:hamlet', 'anchor_at', now() - interval '20 days', 'opens_at', now() - interval '20 days'),
         jsonb_build_object('template_id', tid, 'anchor_key', 'in:A2:hamlet', 'anchor_at', now() + interval '3 days', 'opens_at', now() + interval '2 days'))));
  if (v->>'fired')::int <> 1 or (v->>'skipped')::int <> 2 then raise exception '7a fire once, skip early/old: %', v; end if;
  rid2 := (select id from chk_runs where anchor_key = 'in:A1:hamlet');
  if abs(extract(epoch from (select due_at - (now() + interval '6 hours') from chk_run_items where run_id = rid2 and position = 1)) + 7200) > 5
    then raise exception '7b item due from the anchor'; end if;
  -- moved
  v := chk_worker_apply(jsonb_build_object('retime', jsonb_build_array(jsonb_build_object('run_id', rid2,
         'anchor_at', now() + interval '30 hours', 'opens_at', now() + interval '18 hours', 'context', 'Hamlet · Smith (moved)'))));
  if (v->>'retimed')::int <> 1 or (select context from chk_runs where id = rid2) <> 'Hamlet · Smith (moved)' then raise exception '7c retime'; end if;
  perform pg_temp.as_user(toby);
  if (select count(*) from jsonb_array_elements((chk_live())->'runs') r where r->>'id' = rid2::text) <> 0 then raise exception '7d moved list still showing before it opens'; end if;
  -- cancelled, then back
  v := chk_worker_apply(jsonb_build_object('cancel', jsonb_build_array(rid2)));
  if (v->>'cancelled')::int <> 1 then raise exception '7e cancel'; end if;
  v := chk_worker_apply(jsonb_build_object('fire', jsonb_build_array(jsonb_build_object('template_id', tid, 'anchor_key', 'in:A1:hamlet',
         'anchor_at', now() + interval '2 hours', 'opens_at', now() - interval '10 hours', 'context', 'back'))));
  if (v->>'reopened')::int <> 1 or (select status from chk_runs where id = rid2) <> 'open' then raise exception '7f vanished-and-back did not reopen: %', v; end if;
  -- touched lists stay put
  perform pg_temp.as_user(hk);
  perform chk_tick((select id from chk_run_items where run_id = rid2 and position = 1), 'done');
  v := chk_worker_apply(jsonb_build_object('cancel', jsonb_build_array(rid2),
         'retime', jsonb_build_array(jsonb_build_object('run_id', rid2, 'anchor_at', now(), 'opens_at', now()))));
  if (v->>'cancelled')::int <> 0 or (v->>'retimed')::int <> 0 then raise exception '7g a ticked list was moved or cancelled'; end if;
  -- weekly: the next one marks the last Missed
  perform pg_temp.as_user(toby);
  tid2 := ((chk_template_save(jsonb_build_object('title', 'Monday walk-round', 'trig', jsonb_build_object('kind', 'weekly', 'weekday', 1, 'time', '09:00'),
            'items', jsonb_build_array(jsonb_build_object('title', 'Fire doors', 'who', 'anyone')))))->>'id')::uuid;
  update chk_templates set fire_from = now() - interval '30 days' where id = tid2;
  perform chk_worker_apply(jsonb_build_object('fire', jsonb_build_array(jsonb_build_object('template_id', tid2, 'anchor_key', 'weekly:2026-10-19',
          'anchor_at', now() - interval '8 days', 'opens_at', now() - interval '8 days'))));
  v := chk_worker_apply(jsonb_build_object('fire', jsonb_build_array(jsonb_build_object('template_id', tid2, 'anchor_key', 'weekly:2026-10-26',
          'anchor_at', now() - interval '1 day', 'opens_at', now() - interval '1 day'))));
  if (v->>'missed')::int <> 1 or (select status from chk_runs where anchor_key = 'weekly:2026-10-19') <> 'missed' then raise exception '7h missed'; end if;
  -- an inactive template does not fire
  update chk_templates set active = false where id = tid2;
  v := chk_worker_apply(jsonb_build_object('fire', jsonb_build_array(jsonb_build_object('template_id', tid2, 'anchor_key', 'weekly:2026-11-02',
          'anchor_at', now(), 'opens_at', now()))));
  if (v->>'fired')::int <> 0 then raise exception '7i inactive fired'; end if;
  -- state for the worker
  v := chk_worker_state();
  if (select count(*) from jsonb_array_elements(v->'templates') x where x->>'id' = tid2::text) <> 0 then raise exception '7j inactive in state'; end if;
  if (select (x->>'touched')::boolean from jsonb_array_elements(v->'open_runs') x where x->>'id' = rid2::text) is not true then raise exception '7k touched'; end if;

  -- 8. Editing: a changed trigger moves fire_from; the same trigger keeps it.
  perform pg_temp.as_user(toby);
  update chk_templates set fire_from = '2026-01-01' where id = tid;
  perform chk_template_save(jsonb_build_object('id', tid, 'title', 'Arrival prep', 'trig', jsonb_build_object('kind', 'checkin', 'property', null, 'offset_min', -720), 'items', its, 'default_due_min', -60));
  if (select fire_from from chk_templates where id = tid) <> '2026-01-01'::timestamptz then raise exception '8a fire_from moved without a trigger change'; end if;
  perform chk_template_save(jsonb_build_object('id', tid, 'title', 'Arrival prep', 'trig', jsonb_build_object('kind', 'checkin', 'property', 'hamlet', 'offset_min', -720), 'items', its));
  if (select fire_from from chk_templates where id = tid) < now() - interval '1 minute' then raise exception '8b trigger change kept fire_from'; end if;
  perform chk_template_delete(tid);
  if jsonb_array_length((chk_templates_list())->'templates') <> 2 then raise exception '8c deleted template listed'; end if;
  if not exists (select 1 from chk_runs where template_id = tid) then raise exception '8d delete removed lists'; end if;

  -- 9. Pay bar.
  perform pg_temp.as_user(bar);
  if (wp_admin_set_pay_bar(7, true))->>'error' <> 'not_admin' then raise exception '9a bar set pay bar'; end if;
  perform pg_temp.as_user(toby);
  perform wp_admin_set_pay_bar(7, true);
  if (select staff_pay_bar from wp_drinks where event_id = 7) is not true then raise exception '9b staff pay bar'; end if;
  perform wp_admin_set_pay_bar(7, null);
  if (select staff_pay_bar from wp_drinks where event_id = 7) is not null then raise exception '9c cleared'; end if;

  -- 10. Grants.
  if has_function_privilege('authenticated', 'public.chk_worker_apply(jsonb)', 'execute') then raise exception '10a worker callable by users'; end if;
  if has_function_privilege('anon', 'public.chk_live()', 'execute') then raise exception '10b anon'; end if;
  if has_function_privilege('authenticated', 'public.chk_make_items(uuid, chk_templates, timestamptz)', 'execute') then raise exception '10c helper exposed'; end if;
  if has_table_privilege('authenticated', 'public.chk_run_items', 'select') then raise exception '10d table readable'; end if;
  if not has_function_privilege('authenticated', 'public.chk_tick(uuid, text, text)', 'execute') then raise exception '10e tick not granted'; end if;

  perform pg_temp.as_user(null);
  raise notice 'checklists: all assertions passed';
end $t$;
