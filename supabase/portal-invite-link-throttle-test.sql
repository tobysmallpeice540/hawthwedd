-- supabase/portal-invite-link-throttle-test.sql
--
-- Assertions for wp_may_send_link. Five of them, all about the one question
-- that matters: can this function be made to send email to an address that has
-- no business receiving one, or to send it over and over?
--
-- Everything runs inside a block that raises at the end, so the fake access row
-- it creates is rolled back. Run it after any change to wp_may_send_link or to
-- netlify/functions/portal-auth.js.
--
--     ERROR: ALL 5 ASSERTIONS PASSED (rolled back)     <- what you want
--     ERROR: 3 passed / FAILURES: FAIL 2: ...          <- what you don't
--
-- Last run 9 September 2026: all 5 passed.

do $t$
declare
  ev int;
  r jsonb; fails text[] := '{}'; passes int := 0;
  test_email text := 'throttle-test@example.invalid';
begin
  select min((e->>'id')::int) into ev
    from app_data d, lateral jsonb_array_elements(d.value) e
   where d.key = 'hawthbush_bookings_v6';

  -- 1. An address nobody invited gets nothing. This is the assertion that
  --    stops the public sign-in form being an open email relay.
  r := wp_may_send_link(test_email, 60);
  if not (r->>'ok')::bool and r->>'reason' = 'not_invited' then passes:=passes+1;
  else fails := fails || ('FAIL 1: uninvited address got ' || coalesce(r::text,'null')); end if;

  insert into public.wp_access (event_id, email) values (ev, test_email);

  -- 2. An invited address gets a link, and is told which wedding it belongs to
  --    so the email can be logged against it.
  r := wp_may_send_link(test_email, 60);
  if (r->>'ok')::bool and (r->>'event_id')::int = ev then passes:=passes+1;
  else fails := fails || ('FAIL 2: invited address got ' || coalesce(r::text,'null')); end if;

  -- 3. ...and immediately asking again is refused. Two links in quick
  --    succession is worse than none: the second invalidates the first, so a
  --    couple opening the earlier email gets a dead link and no explanation.
  r := wp_may_send_link(test_email, 60);
  if not (r->>'ok')::bool and r->>'reason' = 'too_soon' then passes:=passes+1;
  else fails := fails || ('FAIL 3: throttle did not hold: ' || coalesce(r::text,'null')); end if;

  -- 4. The staff invite path uses a short window, and must still get through
  --    right after the grant that precedes it.
  update public.wp_access set last_link_sent_at = now() - interval '10 seconds'
   where email = test_email;
  r := wp_may_send_link(test_email, 5);
  if (r->>'ok')::bool then passes:=passes+1;
  else fails := fails || ('FAIL 4: staff invite refused after 10s: ' || coalesce(r::text,'null')); end if;

  -- 5. Revoking access stops the links, not just the reading. Otherwise a
  --    revoked address would carry on receiving sign-in emails for a wedding
  --    it can no longer see.
  update public.wp_access set revoked_at = now(), last_link_sent_at = null
   where email = test_email;
  r := wp_may_send_link(test_email, 60);
  if not (r->>'ok')::bool and r->>'reason' = 'not_invited' then passes:=passes+1;
  else fails := fails || ('FAIL 5: a revoked address still gets links: ' || coalesce(r::text,'null')); end if;

  if array_length(fails,1) is null then
    raise exception 'ALL % ASSERTIONS PASSED (rolled back)', passes;
  else
    raise exception '% passed / FAILURES: %', passes, array_to_string(fails,' | ');
  end if;
end $t$;


-- ── Grant surface, checked separately ───────────────────────────────────────
--
-- Expected: anon false, authenticated false, service_role true. Supabase grants
-- EXECUTE to anon and authenticated by default on every new function in
-- `public`, so this is the assertion that catches a re-create that forgot to
-- revoke — which would put an unthrottled, unauthenticated email trigger on the
-- public API.

select p.proname,
       has_function_privilege('anon',          p.oid, 'execute') as anon_expected_false,
       has_function_privilege('authenticated', p.oid, 'execute') as authed_expected_false,
       has_function_privilege('service_role',  p.oid, 'execute') as svc_expected_true
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'wp_may_send_link';
