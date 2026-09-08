-- supabase/portal-phase00-access-test.sql
--
-- Assertions for the portal access layer. Seven of them, all about the one
-- question that matters: can a signed-in wedding client reach anything that is
-- not their own wedding?
--
-- Everything runs inside a block that raises at the end, so the fake accounts
-- and invitations it creates are rolled back. Run it after any change to
-- wp_my_event_id(), wp_my_event() or the wp_access table.
--
-- Result arrives as an exception, by design — that is how the block guarantees
-- its own rollback:
--
--     ERROR: ALL 7 ASSERTIONS PASSED (rolled back)          <- what you want
--     ERROR: 5 passed / FAILURES: FAIL C: ...               <- what you don't
--
-- Last run 8 September 2026: all 7 passed.

do $t$
declare
  uA uuid := '00000000-0000-4000-8000-00000000000a';
  uB uuid := '00000000-0000-4000-8000-00000000000b';
  uC uuid := '00000000-0000-4000-8000-00000000000c';
  evA int; evB int;
  r jsonb; fails text[] := '{}'; passes int := 0;
  leaked text; k text;

  -- Anything on the booking record that a client must never receive. The
  -- payload is built as an allowlist, so this is a belt-and-braces check that
  -- the allowlist has not quietly grown.
  banned text[] := array['venueFee','deposit','payment2','finalPayment','corkage','notes',
                         'extras','nonStandard','xeroContactId','barTakeGross','circaCommission',
                         'dayStaff','setup','phone','email','invoiceEmails','files','contacts'];
begin
  select min((e->>'id')::int), max((e->>'id')::int) into evA, evB
    from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key = 'hawthbush_bookings_v6';

  -- Two invited couples on two different weddings, and one account with no
  -- invitation at all.
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at) values
    (uA,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','a@test.invalid',now(),now()),
    (uB,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','b@test.invalid',now(),now()),
    (uC,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','c@test.invalid',now(),now())
  on conflict (id) do nothing;

  insert into public.profiles (id,email,name,role,active) values
    (uA,'a@test.invalid','A','client',true),
    (uB,'b@test.invalid','B','client',true),
    (uC,'c@test.invalid','C','client',true)
  on conflict (id) do update set role='client';

  insert into public.wp_access (event_id,email,user_id) values
    (evA,'a@test.invalid',uA),
    (evB,'b@test.invalid',uB);

  -- 1. A sees A's wedding
  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','a@test.invalid')::text, true);
  r := wp_my_event();
  if (r->>'ok')::bool and (r->>'event_id')::int = evA then passes:=passes+1;
  else fails := fails || ('FAIL 1: A got ' || coalesce(r::text,'null')); end if;

  -- 2. ...and nothing sensitive rides along in the payload
  leaked := '';
  foreach k in array banned loop
    if r ? k or r::text ilike '%"'||k||'"%' then leaked := leaked || k || ' '; end if;
  end loop;
  if leaked = '' then passes:=passes+1;
  else fails := fails || ('FAIL 2: allowlist leaked: ' || leaked); end if;

  -- 3. B sees B's wedding
  perform set_config('request.jwt.claims', json_build_object('sub',uB,'email','b@test.invalid')::text, true);
  r := wp_my_event();
  if (r->>'ok')::bool and (r->>'event_id')::int = evB then passes:=passes+1;
  else fails := fails || 'FAIL 3: B got the wrong event or none'; end if;

  -- 4. B cannot see A's wedding. Structurally impossible — no client function
  --    takes an event id — but assert it anyway, because that is the property
  --    the whole design rests on.
  if (r->>'event_id')::int <> evA then passes:=passes+1;
  else fails := fails || 'FAIL 4: B can see A''s event'; end if;

  -- 5. An account with no invitation gets nothing
  perform set_config('request.jwt.claims', json_build_object('sub',uC,'email','c@test.invalid')::text, true);
  r := wp_my_event();
  if not (r->>'ok')::bool and r->>'error' = 'no_access' then passes:=passes+1;
  else fails := fails || 'FAIL 5: uninvited account got an event'; end if;

  -- 6. A client cannot grant themselves access to another wedding
  perform set_config('request.jwt.claims', json_build_object('sub',uA,'email','a@test.invalid')::text, true);
  r := wp_grant_access(evB,'a@test.invalid');
  if not (r->>'ok')::bool and r->>'error' = 'not_staff' then passes:=passes+1;
  else fails := fails || 'FAIL 6: a client could grant access'; end if;

  -- 7. ...nor list who has access to one
  r := wp_list_access(evB);
  if not (r->>'ok')::bool and r->>'error' = 'not_staff' then passes:=passes+1;
  else fails := fails || 'FAIL 7: a client could list access'; end if;

  if array_length(fails,1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails,' | ');
  end if;
end $t$;


-- ── Grant surface, checked separately ───────────────────────────────────────
--
-- Supabase's default privileges grant EXECUTE on every new function in `public`
-- to anon AND authenticated. Every wp_ function must therefore revoke
-- explicitly. Expected: nothing callable by anon; five callable by a signed-in
-- user (wp_touch_access, wp_my_event, wp_grant_access, wp_revoke_access,
-- wp_list_access); the two internal helpers callable by neither.

select p.proname,
       has_function_privilege('anon',          p.oid, 'execute') as anon_expected_false,
       has_function_privilege('authenticated', p.oid, 'execute') as authed
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'wp\_%'
order by p.proname;
