-- supabase/portal-phase08-table-plan-test.sql
--
-- Nineteen assertions for the table plan.
--
-- The three that are the reason this file exists:
--   7   ROTATING A TABLE MOVES NOBODY. Seats keep their index; only their
--       drawn position changes.
--   8/9 TICKING "ONE SIDE ONLY" DESTROYS SEATS 3-5, AND THE THREE PEOPLE WHO
--       WERE IN THEM COME BACK TO THE LIST — reported by name, and still
--       present in the database afterwards. Silently losing three guests off
--       a plan is the same family as the four record-loss incidents.
--   18  DELETING A TABLE RETURNS ITS GUESTS rather than deleting them with it.
--
-- Note the arithmetic in 9: eight seated guests with six placed leaves two
-- unseated, so evicting three gives five. An earlier version of this test
-- expected three and failed — the test was wrong, not the code.
--
-- Rolled back at the end.  Last run 9 September 2026: all 19 passed.

do $t$
declare
  adm uuid; uA uuid := '00000000-0000-4000-8000-00000000000a'; uB uuid := '00000000-0000-4000-8000-00000000000b';
  evA int; evB int; r jsonb; tbl uuid; g uuid[]; ev_guest uuid; i int;
  fails text[] := '{}'; passes int := 0;
begin
  select min((e->>'id')::int), max((e->>'id')::int) into evA, evB
    from app_data d, lateral jsonb_array_elements(d.value) e where d.key='hawthbush_bookings_v6';
  select id into adm from public.profiles where role='admin' and active limit 1;

  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
    (uA,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','a@test.invalid',now(),now()),
    (uB,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','b@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values
    (uA,'a@test.invalid','A','client',true),(uB,'b@test.invalid','B','client',true)
  on conflict (id) do update set role='client';
  insert into public.wp_access (event_id,email,user_id) values (evA,'a@test.invalid',uA),(evB,'b@test.invalid',uB);

  -- 1 an admin draws the room
  perform set_config('request.jwt.claims', json_build_object('sub',adm,'email','a@t')::text, true);
  r := wp_admin_upsert_room(null,'The barn',12000,9000,'[{"kind":"fixed","label":"Bar","x":0,"y":0,"w":3000,"h":800}]'::jsonb);
  if (r->>'ok')::bool then passes:=passes+1; else fails:=fails||'1 room'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','a@test.invalid')::text, true);
  for i in 1..8 loop
    r := wp_add_guest('seated','Guest'||i,'Surname'||i);
    g := array_append(g, (r->>'id')::uuid);
  end loop;
  r := wp_add_guest('evening','Evening','Only');
  ev_guest := (r->>'id')::uuid;

  -- 2 a table
  r := wp_add_table(1000,1000); tbl := (r->>'id')::uuid;
  if (r->>'ok')::bool then passes:=passes+1; else fails:=fails||'2 add table'; end if;

  -- 3 the arithmetic is offered rather than left to be counted
  r := wp_get_layout();
  if (r->'counts'->>'seated_guests')::int=8 and (r->'counts'->>'tables_needed')::int=2
     and (r->'counts'->>'seats_placed')::int=6
    then passes:=passes+1; else fails:=fails||('3 counts: '||(r->'counts')::text); end if;

  -- 4 six people sit down
  for i in 0..5 loop
    r := wp_assign_seat(g[i+1], tbl, i);
    if not (r->>'ok')::bool then fails:=fails||('4 assign seat '||i); end if;
  end loop;
  if array_length(fails,1) is null then passes:=passes+1; end if;

  -- 5 an evening-only guest gets no seat at the meal
  r := wp_assign_seat(ev_guest, tbl, 0);
  if not (r->>'ok')::bool and r->>'error'='not_a_seated_guest' then passes:=passes+1;
  else fails:=fails||'5 SEATED AN EVENING GUEST'; end if;

  -- 6 there is no seventh seat
  r := wp_assign_seat(g[7], tbl, 6);
  if not (r->>'ok')::bool and r->>'error'='no_such_seat' then passes:=passes+1;
  else fails:=fails||'6 invented a seventh seat'; end if;

  -- 7 ROTATION MOVES NOBODY
  r := wp_move_table(tbl, null, null, 90);
  r := wp_get_layout();
  if (select count(*) from jsonb_array_elements(r->'tables') t,
        lateral jsonb_array_elements(t->'seats') s
       where (s->>'seat_index')::int = 3 and s->>'name' = 'Guest4 Surname4') = 1
    then passes:=passes+1; else fails:=fails||'7 ROTATION MOVED SOMEBODY'; end if;

  -- 8 one side only evicts three, and says who
  r := wp_set_table_sides(tbl, true);
  if (r->>'ok')::bool and (r->>'unseated')::int = 3 and (r->'names')::text like '%Guest4%'
    then passes:=passes+1; else fails:=fails||('8 one-side eviction: '||r::text); end if;

  -- 9 THEY ARE BACK ON THE LIST, NOT GONE
  r := wp_get_layout();
  if jsonb_array_length(r->'unseated') = 5
     and (select count(*) from wp_guests where event_id=evA and list='seated') = 8
    then passes:=passes+1; else fails:=fails||('9 GUESTS LOST: unseated='||jsonb_array_length(r->'unseated')::text); end if;

  -- 10 and the three on the remaining side kept their seats
  if (select count(*) from wp_guests where table_id=tbl) = 3 then passes:=passes+1;
  else fails:=fails||'10 wrong number left seated'; end if;

  -- 11 a destroyed seat cannot be filled
  r := wp_assign_seat(g[4], tbl, 3);
  if not (r->>'ok')::bool and r->>'error'='no_such_seat' then passes:=passes+1;
  else fails:=fails||'11 seated someone in a destroyed seat'; end if;

  -- 12 seating over someone moves the first one out cleanly
  r := wp_assign_seat(g[4], tbl, 0);
  if (r->>'ok')::bool and (select count(*) from wp_guests where table_id=tbl and seat_index=0)=1
    then passes:=passes+1; else fails:=fails||('12 swap: '||r::text); end if;

  -- 13-17 the other couple can touch none of it
  perform set_config('request.jwt.claims', json_build_object('sub',uB,'email','b@test.invalid')::text, true);
  r := wp_move_table(tbl, 5000, 5000);
  if not (r->>'ok')::bool then passes:=passes+1; else fails:=fails||'13 B MOVED A TABLE'; end if;
  r := wp_set_table_sides(tbl, false);
  if not (r->>'ok')::bool then passes:=passes+1; else fails:=fails||'14 B CHANGED A TABLE'; end if;
  r := wp_delete_table(tbl);
  if not (r->>'ok')::bool then passes:=passes+1; else fails:=fails||'15 B DELETED A TABLE'; end if;
  r := wp_assign_seat(g[1], tbl, 1);
  if not (r->>'ok')::bool then passes:=passes+1; else fails:=fails||'16 B SEATED A GUEST'; end if;
  r := wp_get_layout();
  if jsonb_array_length(r->'tables')=0 then passes:=passes+1; else fails:=fails||'17 B sees A tables'; end if;

  -- 18 DELETING A TABLE RETURNS ITS GUESTS
  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','a@test.invalid')::text, true);
  r := wp_delete_table(tbl);
  if (r->>'ok')::bool and (r->>'unseated')::int = 3
     and (select count(*) from wp_guests where event_id=evA and list='seated') = 8
    then passes:=passes+1; else fails:=fails||('18 delete lost guests: '||r::text); end if;

  -- 19 and a client cannot draw the room
  r := wp_admin_upsert_room(null,'Sneaky room');
  if not (r->>'ok')::bool and r->>'error'='not_staff' then passes:=passes+1;
  else fails:=fails||'19 client made a room'; end if;

  if array_length(fails,1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else raise exception '% passed / FAILURES: %', passes, array_to_string(fails,' | '); end if;
end $t$;
