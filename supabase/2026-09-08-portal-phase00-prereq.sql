-- supabase/2026-09-08-portal-phase00-prereq.sql
--
-- PREREQUISITE for the wedding client portal. No part of the portal can be
-- built until this is applied, and it is worth applying even if the portal is
-- never built.
--
-- WHAT IS WRONG TODAY
--
-- `app_data` carries one policy for signed-in users:
--
--     app_data_authenticated   FOR ALL   TO authenticated   USING (true)
--
-- with SELECT, INSERT, UPDATE and DELETE granted to `authenticated`. So any
-- account that can sign in can read and write every row of that table: all 45
-- weddings with names, emails, phone numbers and fees, plus staff records,
-- enquiries, the email log, viewing requests and the invoice list. `audit_log`
-- is the same for reads — 743 rows, USING (true).
--
-- That has been harmless up to now, and the phase 5-7 work was not wrong: the
-- only accounts that exist are three staff accounts, so "authenticated" and
-- "staff" have meant the same thing. The portal is what breaks the assumption.
-- The moment a wedding client can sign in, that client can read every other
-- couple's booking and delete it.
--
-- Two smaller problems sit alongside it:
--
--   · `profiles.role` is CHECKed against ('admin','bar','cleaner') only, so an
--     account created with role 'client' is REJECTED and the signup fails.
--   · `handle_new_user()` defaults a new account to 'bar'. With no role passed,
--     a wedding client would arrive as bar staff — stock-take and door check-in.
--
-- So a client signing in today either fails outright or becomes bar staff.
-- There is no third outcome.
--
-- WHAT THIS DOES
--
--   1. Adds a `client` role and makes it the default for new accounts. Least
--      privilege on arrival: nobody should become staff by signing up.
--   2. Narrows `app_data` and `audit_log` from "any authenticated user" to
--      "active staff", via a SECURITY DEFINER predicate.
--   3. Verifies itself and raises if anything did not take.
--
-- It is re-runnable. Each part checks whether it has already been applied.
--
-- BEFORE APPLYING
--
-- Confirm every staff account will still pass the new predicate. Checked on
-- 8 September 2026: 2 admin + 1 bar, all active. If a staff profile were
-- inactive or held an unexpected role, that person's app would go blank and
-- fall back to seed data — the failure this project has already had once. Run:
--
--     select role, active, count(*) from public.profiles group by 1,2;
--
-- AFTER APPLYING
--
-- Sign in to the app as admin and confirm the wedding diary still loads. If it
-- shows the red seed-data banner, roll back with the block at the foot of this
-- file and say so before going further.

begin;

-- ── 1. A client role, and least privilege by default ────────────────────────

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin', 'bar', 'cleaner', 'client'));

alter table public.profiles alter column role set default 'client';

-- ── 2. Patch handle_new_user() in place ─────────────────────────────────────
--
-- Read out of the catalogue and string-patched, never retyped: the house rule
-- after a copy through a chat window arrived 24 characters short. The anchor
-- must appear exactly once or this raises and changes nothing.

do $patch$
declare
  def     text;
  anchor  text := '''bar''';
  hits    int;
begin
  select pg_get_functiondef(p.oid) into def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'handle_new_user';

  if def is null then
    raise exception 'handle_new_user() not found';
  end if;

  if position('''client''' in def) > 0 then
    raise notice 'handle_new_user() already defaults to client - skipped';
    return;
  end if;

  hits := (length(def) - length(replace(def, anchor, ''))) / length(anchor);
  if hits <> 1 then
    raise exception
      'expected exactly 1 occurrence of % in handle_new_user(), found % - not patching',
      anchor, hits;
  end if;

  execute replace(def, anchor, '''client''');
  raise notice 'handle_new_user() patched: new accounts now default to client';
end
$patch$;

-- ── 3. One predicate for "is this caller staff?" ────────────────────────────
--
-- SECURITY DEFINER so it reads profiles without tripping that table's own RLS,
-- and so the answer cannot be influenced by the caller.

create or replace function public.is_staff()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists (
    select 1 from profiles
     where id = auth.uid()
       and active
       and role in ('admin', 'bar', 'cleaner')
  );
$function$;

revoke all on function public.is_staff() from public;
revoke all on function public.is_staff() from anon;
grant execute on function public.is_staff() to authenticated, service_role;

-- ── 4. Close app_data and audit_log to non-staff accounts ───────────────────

drop policy if exists app_data_authenticated on public.app_data;
drop policy if exists app_data_staff         on public.app_data;

create policy app_data_staff on public.app_data
  for all to authenticated
  using       (public.is_staff())
  with check  (public.is_staff());

-- The two public terms documents stay readable by anon. Unchanged, listed here
-- so it is obvious it was considered and kept.
--   app_data_public_terms  FOR SELECT  TO anon
--     USING (key in ('hbf_terms_v1', 'hbf_ticket_terms_v1'))

drop policy if exists audit_log_read       on public.audit_log;
drop policy if exists audit_log_staff_read on public.audit_log;

create policy audit_log_staff_read on public.audit_log
  for select to authenticated
  using (public.is_staff());

-- ── 5. Verify, and refuse to commit if anything did not take ────────────────

do $verify$
declare
  n int;
begin
  select count(*) into n from pg_policy
   where polrelid = 'public.app_data'::regclass and polname = 'app_data_authenticated';
  if n > 0 then raise exception 'app_data_authenticated still present'; end if;

  select count(*) into n from pg_policy
   where polrelid = 'public.app_data'::regclass and polname = 'app_data_staff';
  if n <> 1 then raise exception 'app_data_staff policy missing'; end if;

  select count(*) into n from pg_policy
   where polrelid = 'public.audit_log'::regclass and polname = 'audit_log_staff_read';
  if n <> 1 then raise exception 'audit_log_staff_read policy missing'; end if;

  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'is_staff';
  if n <> 1 then raise exception 'is_staff() missing'; end if;

  select count(*) into n from pg_constraint
   where conrelid = 'public.profiles'::regclass
     and conname  = 'profiles_role_check'
     and pg_get_constraintdef(oid) ilike '%client%';
  if n <> 1 then raise exception 'profiles_role_check does not allow client'; end if;

  -- Every existing staff account must still pass, or the app goes blank.
  select count(*) into n from public.profiles
   where active and role in ('admin', 'bar', 'cleaner');
  if n = 0 then raise exception 'no active staff would pass is_staff() - refusing'; end if;

  raise notice 'verified: % active staff accounts still pass', n;
end
$verify$;

commit;

-- ── Rollback, if the app misbehaves after applying ──────────────────────────
--
-- begin;
--   drop policy if exists app_data_staff on public.app_data;
--   create policy app_data_authenticated on public.app_data
--     for all to authenticated using (true) with check (true);
--   drop policy if exists audit_log_staff_read on public.audit_log;
--   create policy audit_log_read on public.audit_log
--     for select to authenticated using (true);
-- commit;
--
-- Note this restores the wide-open behaviour. It is a way to get the app back,
-- not a place to stop.
