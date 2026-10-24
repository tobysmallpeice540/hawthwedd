-- supabase/2026-10-24i-security-tightening.sql
--
-- From the 24 October code review. Run in the SQL editor, then
-- supabase/security-tightening-test.sql (expect "ALL n ASSERTIONS PASSED").
--
--   1. Booking files (contracts, booking forms) were readable, writable and
--      deletable by ANY signed-in user. The four storage policies predate the
--      client portal; every couple now holds a signed-in session. They now
--      also require is_staff().
--   2. A new account's role was taken from the sign-up metadata, so if public
--      sign-up is ever on, anyone could register as admin. New accounts are
--      always 'client'; user-admin.js already sets a staff role afterwards.
--   3. Granting and revoking portal access, the invoice mirror and the money
--      functions behind the bar and drinks were open to every staff login,
--      bar and cleaner included. They are admin only now. (A bar login could
--      grant itself any wedding and read guests' dietary/access notes through
--      the client functions.) The invoice mirror also refuses any link that is
--      not a Xero online-invoice link, since the portal renders it as a link.
--   4. app_data, audit_log and profiles still carried every table privilege
--      (TRUNCATE included, which ignores RLS) for anon and authenticated.
--      Trimmed to what the policies actually serve.
--
-- Functions are patched IN PLACE from the live catalogue (pg_get_functiondef),
-- each anchor asserted to appear exactly once — the house rule. CREATE OR
-- REPLACE keeps each function's existing grants. Safe to run twice: a
-- function already carrying its replacement is skipped with a notice.

begin;

create or replace function pg_temp.patch_fn(p_sig regprocedure, p_find text, p_repl text)
returns void language plpgsql as $$
declare d text := pg_get_functiondef(p_sig); n integer; m integer;
begin
  n := (length(d) - length(replace(d, p_find, ''))) / length(p_find);
  m := (length(d) - length(replace(d, p_repl, ''))) / length(p_repl);
  -- Already patched (a second run): the anchor is gone and the replacement
  -- is there. Skip it, so the file is safe to run again.
  if n = 0 and m >= 1 then
    raise notice 'patch of % already applied — skipped', p_sig;
    return;
  end if;
  if n <> 1 then
    raise exception 'patch of % expected the anchor exactly once, found % times: %', p_sig, n, p_find;
  end if;
  execute replace(d, p_find, p_repl);
end $$;

-- ── 1. Booking files: staff only ───────────────────────────────────────────
drop policy if exists booking_files_read   on storage.objects;
drop policy if exists booking_files_write  on storage.objects;
drop policy if exists booking_files_update on storage.objects;
drop policy if exists booking_files_delete on storage.objects;
create policy booking_files_read   on storage.objects for select to authenticated
  using (bucket_id = 'booking-files' and public.is_staff());
create policy booking_files_write  on storage.objects for insert to authenticated
  with check (bucket_id = 'booking-files' and public.is_staff());
create policy booking_files_update on storage.objects for update to authenticated
  using (bucket_id = 'booking-files' and public.is_staff())
  with check (bucket_id = 'booking-files' and public.is_staff());
create policy booking_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'booking-files' and public.is_staff());

-- ── 2. New accounts are clients ────────────────────────────────────────────
select pg_temp.patch_fn('public.handle_new_user()'::regprocedure,
  $a$coalesce(new.raw_user_meta_data->>'role', 'client')$a$, $a$'client'$a$);

-- ── 3. Admin only ──────────────────────────────────────────────────────────
select pg_temp.patch_fn(f::regprocedure, 'not is_staff()', 'not wp_is_admin()')
  from unnest(array[
    'public.wp_grant_access(integer,text)',
    'public.wp_revoke_access(uuid)',
    'public.wp_list_access(integer)',
    'public.wp_admin_access(integer)',
    'public.wp_admin_sync_invoices(integer,jsonb)',
    'public.wp_admin_add_bar_payment(integer,numeric,text)',
    'public.wp_admin_remove_bar_payment(uuid)',
    'public.wp_admin_set_drinks(integer,numeric,numeric,boolean,text,numeric,text)',
    'public.wp_admin_decide_addon(uuid,text,numeric,text)',
    'public.wp_admin_price_drinks_line(uuid,numeric)',
    'public.wp_admin_mark_drinks_invoiced(integer,text,text)'
  ]) f;

-- Only a Xero online-invoice link is ever stored; anything else is kept as
-- no link (the invoice still shows, with "Link coming").
select pg_temp.patch_fn('public.wp_admin_sync_invoices(integer,jsonb)'::regprocedure,
  'cur, url, now()',
  $a$cur, case when url ~ '^https://in\.xero\.com/' then url end, now()$a$);

-- ── 4. Table privileges ────────────────────────────────────────────────────
-- app_data: authenticated keeps select/insert/update/delete (the staff app
-- reads and writes it under the app_data_staff policy); anon keeps select
-- (the public terms policy).
revoke truncate, references, trigger on public.app_data, public.audit_log, public.profiles from anon, authenticated;
revoke insert, update, delete on public.app_data from anon;
-- audit_log is written only by the SECURITY DEFINER trigger; profiles only
-- by the service key (user-admin.js) and the sign-up trigger.
revoke insert, update, delete on public.audit_log, public.profiles from anon, authenticated;
revoke select on public.audit_log, public.profiles from anon;
do $$ begin
  if to_regclass('public.audit_log_id_seq') is not null then
    execute 'revoke all on sequence public.audit_log_id_seq from anon, authenticated';
  end if;
end $$;

commit;
