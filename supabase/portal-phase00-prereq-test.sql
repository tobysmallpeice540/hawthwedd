-- supabase/portal-phase00-prereq-test.sql
--
-- Assertions for 2026-09-08-portal-phase00-prereq.sql.
--
-- Run BEFORE applying to see it fail, and AFTER to see it pass. The exposure
-- assertions (1-3) are the ones that matter: they are the reason the migration
-- exists, and they should fail loudly on an unpatched database.
--
-- Everything here is read-only apart from the simulated-client block at the
-- end, which creates and removes its own profile row inside a transaction that
-- is rolled back. No production row is changed.

do $t$
declare
  failures text[] := '{}';
  passes   int := 0;
  n        int;
  txt      text;

  procedure_note text;
begin
  -- ── 1. app_data is not readable by every authenticated account ────────────
  select count(*) into n from pg_policy
   where polrelid = 'public.app_data'::regclass
     and 'authenticated' = any (select pg_get_userbyid(r) from unnest(polroles) r)
     and pg_get_expr(polqual, polrelid) = 'true';
  if n > 0 then
    failures := failures || 'FAIL 1: app_data has an authenticated policy with USING (true)';
  else passes := passes + 1; end if;

  -- ── 2. app_data is gated on staff specifically ────────────────────────────
  select pg_get_expr(polqual, polrelid) into txt from pg_policy
   where polrelid = 'public.app_data'::regclass and polname = 'app_data_staff';
  if txt is null then
    failures := failures || 'FAIL 2: app_data_staff policy does not exist';
  elsif txt not ilike '%is_staff%' then
    failures := failures || ('FAIL 2: app_data_staff does not use is_staff(): ' || txt);
  else passes := passes + 1; end if;

  -- ── 3. audit_log likewise ─────────────────────────────────────────────────
  select pg_get_expr(polqual, polrelid) into txt from pg_policy
   where polrelid = 'public.audit_log'::regclass and polname = 'audit_log_staff_read';
  if txt is null or txt not ilike '%is_staff%' then
    failures := failures || 'FAIL 3: audit_log is not gated on is_staff()';
  else passes := passes + 1; end if;

  -- ── 4. is_staff() exists, is SECURITY DEFINER, and is not callable by anon ─
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'is_staff' and p.prosecdef;
  if n <> 1 then
    failures := failures || 'FAIL 4a: is_staff() missing or not SECURITY DEFINER';
  else passes := passes + 1; end if;

  if has_function_privilege('anon', 'public.is_staff()', 'execute') then
    failures := failures || 'FAIL 4b: anon can execute is_staff()';
  else passes := passes + 1; end if;

  if not has_function_privilege('authenticated', 'public.is_staff()', 'execute') then
    failures := failures || 'FAIL 4c: authenticated cannot execute is_staff()';
  else passes := passes + 1; end if;

  -- ── 5. A client role is permitted ─────────────────────────────────────────
  select count(*) into n from pg_constraint
   where conrelid = 'public.profiles'::regclass and conname = 'profiles_role_check'
     and pg_get_constraintdef(oid) ilike '%client%';
  if n <> 1 then
    failures := failures || 'FAIL 5: profiles_role_check does not allow client';
  else passes := passes + 1; end if;

  -- ── 6. New accounts default to client, not bar ────────────────────────────
  select column_default into txt from information_schema.columns
   where table_schema = 'public' and table_name = 'profiles' and column_name = 'role';
  if txt is null or txt not ilike '%client%' then
    failures := failures || ('FAIL 6a: profiles.role default is ' || coalesce(txt, 'null'));
  else passes := passes + 1; end if;

  select prosrc into txt from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'handle_new_user';
  if txt is null then
    failures := failures || 'FAIL 6b: handle_new_user() not found';
  elsif position('''bar''' in txt) > 0 then
    failures := failures || 'FAIL 6b: handle_new_user() still falls back to bar';
  elsif position('''client''' in txt) = 0 then
    failures := failures || 'FAIL 6b: handle_new_user() does not mention client';
  else passes := passes + 1; end if;

  -- ── 7. The box office tables stay closed (regression guard) ───────────────
  -- RLS on with no policies at all is what denies them; this asserts nobody
  -- has since added a permissive one.
  select count(*) into n from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relname like 'box\_%';
  if n > 0 then
    failures := failures || ('FAIL 7: ' || n || ' policy/policies appeared on box_* tables');
  else passes := passes + 1; end if;

  -- ── 8. Existing staff still pass ──────────────────────────────────────────
  select count(*) into n from public.profiles
   where active and role in ('admin', 'bar', 'cleaner');
  if n = 0 then
    failures := failures || 'FAIL 8: no active staff account would pass is_staff()';
  else passes := passes + 1; end if;

  -- ── Report ────────────────────────────────────────────────────────────────
  if array_length(failures, 1) is null then
    raise notice '----------------------------------------';
    raise notice 'ALL % ASSERTIONS PASSED', passes;
    raise notice '----------------------------------------';
  else
    raise notice '----------------------------------------';
    raise notice '% passed, % FAILED:', passes, array_length(failures, 1);
    foreach txt in array failures loop
      raise notice '  %', txt;
    end loop;
    raise notice '----------------------------------------';
    raise exception 'prereq assertions failed - see notices above';
  end if;
end
$t$;


-- ── 9. The behaviour that actually matters, proved end to end ───────────────
--
-- Simulates a wedding client: an active profile with role 'client', asking the
-- same question the policy asks. Rolled back, so nothing persists.
--
-- On an UNPATCHED database this cannot even be set up — the role CHECK rejects
-- 'client' — which is itself the finding.

begin;

do $sim$
declare
  fake_id uuid := '00000000-0000-4000-8000-0000000c11e7';
  answer  boolean;
begin
  -- profiles.id references auth.users, so insert a matching auth row first.
  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  values (fake_id, '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'portal-test@example.invalid', now(), now())
  on conflict (id) do nothing;

  insert into public.profiles (id, email, name, role, active)
  values (fake_id, 'portal-test@example.invalid', 'Prereq test', 'client', true)
  on conflict (id) do update set role = 'client', active = true;

  select exists (
    select 1 from profiles
     where id = fake_id and active and role in ('admin', 'bar', 'cleaner')
  ) into answer;

  if answer then
    raise exception 'FAIL 9: a client profile satisfies the staff predicate';
  end if;

  raise notice 'PASS 9: a client account does not satisfy the staff predicate';
end
$sim$;

rollback;
