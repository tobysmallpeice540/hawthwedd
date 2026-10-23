-- supabase/portal-bar-test.sql
--
-- Assertions for 2026-10-23c-portal-bar.sql. Rolled back; the result arrives
-- as an exception:  ERROR: ALL n ASSERTIONS PASSED (rolled back)
--
-- Deliberately removes no rows, so it can be run through tools that hold
-- destructive statements for confirmation. Nothing it writes survives the
-- closing exception.
--
--   B2   one couple's bar choices never touch another's
--   B3   each control saves only itself (NULL leaves the rest alone)
--   S1   sections: the bar follows Drinks' old standard; Drinks is off as
--        standard except for weddings
--   R1   "we're done" works on the bar, and "changed since" is about the bar

do $t$
declare
  uA uuid := '00000000-0000-4000-8000-0000000000e1';
  uB uuid := '00000000-0000-4000-8000-0000000000e2';
  uN uuid := '00000000-0000-4000-8000-0000000000e3';
  evA int; evB int; r jsonb; d wp_drinks%rowtype; keys text[]; sm jsonb; c_fizz uuid; c_toast uuid;
  fails text[] := '{}'; passes int := 0;
begin
  select (e->>'id')::int into evA from app_data x, lateral jsonb_array_elements(x.value) e
   where x.key='hawthbush_bookings_v6' and wp_event_type_label(e->>'eventType')='Wedding'
     and not exists (select 1 from wp_drinks_lines l where l.event_id = (e->>'id')::int)
     and not exists (select 1 from wp_access a where a.event_id = (e->>'id')::int)
   order by e->>'date' desc limit 1;
  select (e->>'id')::int into evB from app_data x, lateral jsonb_array_elements(x.value) e
   where x.key='hawthbush_bookings_v6' and wp_event_type_label(e->>'eventType')='Wedding' and (e->>'id')::int <> evA
   order by e->>'date' desc limit 1;

  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
    (uA,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','ba@test.invalid',now(),now()),
    (uB,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','bb@test.invalid',now(),now()),
    (uN,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','bn@test.invalid',now(),now())
  on conflict (id) do nothing;
  insert into public.profiles (id,email,name,role,active) values
    (uA,'ba@test.invalid','A','client',true),(uB,'bb@test.invalid','B','client',true),(uN,'bn@test.invalid','N','client',true)
  on conflict (id) do update set role = excluded.role;
  insert into public.wp_access (event_id,email,user_id) values (evA,'ba@test.invalid',uA),(evB,'bb@test.invalid',uB);

  -- Start both from a known state without deleting anything.
  insert into wp_drinks (event_id) values (evA), (evB) on conflict (event_id) do nothing;
  update wp_drinks set pay_bar = null, bar_usage = null, bar_rules = null where event_id in (evA, evB);
  update wp_drinks set pay_bar = false, bar_usage = 'less', bar_rules = 'B keeps this' where event_id = evB;

  -- G1  grants
  if not has_function_privilege('anon', 'public.wp_save_bar_prefs(boolean,text,text)'::regprocedure, 'execute')
     and has_function_privilege('authenticated', 'public.wp_save_bar_prefs(boolean,text,text)'::regprocedure, 'execute')
  then passes:=passes+1; else fails:=fails||text 'G1 grants'; end if;

  -- K1  the tab list has the bar straight after drinks; it has its own area
  keys := wp_section_keys();
  if array_position(keys, 'bar') = array_position(keys, 'drinks') + 1 and wp_section_area('bar') = 'bar'
     and wp_section_area('drinks') = 'drinks'
  then passes:=passes+1; else fails:=fails||('K1 keys '||keys::text); end if;

  -- S1  standards
  if (select shown from wp_section_defaults where event_type='Wedding' and section='drinks')
     and (select shown from wp_section_defaults where event_type='Wedding' and section='bar')
     and (select shown from wp_section_defaults where event_type='Party' and section='bar')
     and (select shown from wp_section_defaults where event_type='Wake' and section='bar')
     and not (select shown from wp_section_defaults where event_type='Party' and section='drinks')
     and not (select shown from wp_section_defaults where event_type='Wake' and section='drinks')
     and not (select shown from wp_section_defaults where event_type='Other' and section='bar')
  then passes:=passes+1; else fails:=fails||text 'S1 section standards'; end if;

  -- S2  a per-event Drinks tick carried onto the bar
  if not exists (select 1 from wp_event_sections a where a.section='drinks'
                  and not exists (select 1 from wp_event_sections b where b.event_id=a.event_id and b.section='bar'))
  then passes:=passes+1; else fails:=fails||text 'S2 per-event tick not copied'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','ba@test.invalid')::text, true);

  -- B1  the tick
  r := wp_save_bar_prefs(true, null, null);
  select * into d from wp_drinks where event_id = evA;
  if (r->>'ok')::bool and d.pay_bar and d.bar_usage is null then passes:=passes+1; else fails:=fails||('B1 '||r::text); end if;

  -- B3  usage saves on its own, and leaves the tick alone
  perform wp_save_bar_prefs(null, 'more', null);
  perform wp_save_bar_prefs(null, null, '  no spirits  ');
  select * into d from wp_drinks where event_id = evA;
  if d.pay_bar and d.bar_usage = 'more' and d.bar_rules = 'no spirits'
  then passes:=passes+1; else fails:=fails||('B3 '||row_to_json(d)::text); end if;

  -- B4  nonsense usage refused, nothing changed
  r := wp_save_bar_prefs(null, 'loads', null);
  if r->>'error' = 'bad_usage' and (select bar_usage from wp_drinks where event_id = evA) = 'more'
  then passes:=passes+1; else fails:=fails||('B4 '||r::text); end if;

  -- B5  empty clears
  perform wp_save_bar_prefs(null, '', '');
  select * into d from wp_drinks where event_id = evA;
  if d.bar_usage is null and d.bar_rules is null and d.pay_bar then passes:=passes+1; else fails:=fails||text 'B5 clearing'; end if;

  -- B2  B's choices untouched by anything A did
  select * into d from wp_drinks where event_id = evB;
  if d.pay_bar = false and d.bar_usage = 'less' and d.bar_rules = 'B keeps this'
  then passes:=passes+1; else fails:=fails||text 'B2 cross-couple'; end if;

  -- B6  A reads A's choices back
  perform wp_save_bar_prefs(null, 'average', null);
  r := wp_get_drinks();
  if (r->>'event_id')::int = evA and (r->'order'->>'pay_bar')::bool and r->'order'->>'bar_usage' = 'average'
  then passes:=passes+1; else fails:=fails||('B6 '||(r->'order')::text); end if;

  -- B7  logged under the bar
  if exists (select 1 from wp_change_log where event_id = evA and area = 'bar' and summary like 'expects average%')
  then passes:=passes+1; else fails:=fails||text 'B7 change log'; end if;

  -- V1  a wedding shows the bar (unless somebody has switched it off for it)
  if not exists (select 1 from wp_event_sections where event_id = evA and section = 'bar')
     and wp_visible_sections(evA) ? 'bar'
  then passes:=passes+1; else fails:=fails||('V1 '||wp_visible_sections(evA)::text); end if;

  -- R1  "we're done" on the bar, then a change shows as changed since
  r := wp_set_section_ready('bar', true);
  if (r->>'ok')::bool and not exists (select 1 from jsonb_array_elements(r->'sections') s
                                        where s->>'section'='bar' and (s->>'changed_since')::bool)
  then passes:=passes+1; else fails:=fails||('R1a '||r::text); end if;
  update wp_section_status set ready_at = now() - interval '1 minute' where event_id = evA and section = 'bar';
  perform wp_save_bar_prefs(null, 'less', null);
  r := wp_get_sections();
  if exists (select 1 from jsonb_array_elements(r->'sections') s where s->>'section'='bar' and (s->>'changed_since')::bool)
  then passes:=passes+1; else fails:=fails||('R1b '||r::text); end if;

  -- C1  corkage rounds the allowance up to a full bottle, free. 73 adults:
  --      reception 146 drinks = 24.3 bottles of fizz (6 a bottle). 25 bottles
  --      costs nothing; 26 costs one bottle. Toast 73 glasses = 9.1 bottles
  --      (8 a bottle): 10 free, 11 charges one.
  --      Numbers are set without removing anything: an update, or an insert.
  update wp_guest_numbers set seated_adults = 73, seated_children = 0, seated_babies = 0 where event_id = evA;
  if not found then
    insert into wp_guest_numbers (event_id, seated_adults, seated_children, seated_babies, evening_extras)
    values (evA, 73, 0, 0, 0);
  end if;
  update app_data set value = (select jsonb_agg(case when (e->>'id')::int = evA
                                   then jsonb_set(e, '{date}', to_jsonb((current_date + 200)::text)) else e end)
                                 from jsonb_array_elements(value) e)
   where key = 'hawthbush_bookings_v6';
  update wp_drinks set unlocked = false where event_id = evA;
  select id into c_fizz  from wp_drinks_catalogue where route='corkage' and moment='reception' and name like 'Prosecco%';
  select id into c_toast from wp_drinks_catalogue where route='corkage' and moment='toast';
  r := wp_set_drinks_route('corkage');
  perform wp_save_drinks_line(null, c_fizz, 25);
  perform wp_save_drinks_line(null, c_toast, 10);
  sm := wp_drinks_summary(evA);
  if (sm->'moments'->0->>'allowance')::numeric = 146 and (sm->'moments'->0->>'cost')::numeric = 0
     and (sm->'moments'->2->>'allowance')::numeric = 73 and (sm->'moments'->2->>'cost')::numeric = 0
     and (sm->>'unpriced')::int = 0
     and not exists (select 1 from jsonb_array_elements(sm->'invoice_lines') x where x->>'desc' like 'Additional corkage%')
  then passes:=passes+1; else fails:=fails||('C1 rounded-up bottle charged: '||sm::text); end if;

  perform wp_save_drinks_line(null, c_fizz, 1);
  perform wp_save_drinks_line(null, c_toast, 1);
  sm := wp_drinks_summary(evA);
  if (sm->'moments'->0->>'cost')::numeric = 12 and (sm->'moments'->2->>'cost')::numeric = 12
  then passes:=passes+1; else fails:=fails||('C2 whole bottle beyond not charged: '||(sm->'moments')::text); end if;

  -- N1  no booking, no write
  perform set_config('request.jwt.claims', json_build_object('sub',uN,'email','bn@test.invalid')::text, true);
  r := wp_save_bar_prefs(true, null, null);
  if r->>'error' = 'no_access' then passes:=passes+1; else fails:=fails||('N1 '||r::text); end if;

  if array_length(fails, 1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails, ' | ');
  end if;
end
$t$;
