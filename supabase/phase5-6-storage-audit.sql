-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 5 — close the file bucket
-- PHASE 6 — an append-only audit log
--
-- Run this whole file in a NEW Supabase SQL editor tab. Safe to re-run.
-- Deploy the matching src/App.jsx FIRST — it needs to be asking for files the
-- authenticated way before the bucket stops answering the public way.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── PHASE 5: booking-files becomes private ───────────────────────────────────
-- Signed contracts, passports, supplier paperwork. They have been on public
-- URLs — no login, no expiry, readable by anyone who has or guesses the link.
update storage.buckets set public = false where id = 'booking-files';

-- With the bucket private, access is decided by policies on storage.objects.
-- Signed in is the whole test: this is staff paperwork, and the roles do not
-- divide it usefully.
drop policy if exists booking_files_read   on storage.objects;
drop policy if exists booking_files_write  on storage.objects;
drop policy if exists booking_files_update on storage.objects;
drop policy if exists booking_files_delete on storage.objects;

create policy booking_files_read on storage.objects
  for select to authenticated using (bucket_id = 'booking-files');

create policy booking_files_write on storage.objects
  for insert to authenticated with check (bucket_id = 'booking-files');

create policy booking_files_update on storage.objects
  for update to authenticated using (bucket_id = 'booking-files');

create policy booking_files_delete on storage.objects
  for delete to authenticated using (bucket_id = 'booking-files');


-- ── PHASE 6: the audit log ───────────────────────────────────────────────────
-- What was actually wanted the day data disappeared: who changed what, and when.
--
-- Deliberately records the key, the person and the moment — not the contents.
-- The daily backup already keeps thirty days of full snapshots, so between the
-- two you can answer both "who touched this" and "what did it look like
-- before". Storing every version here as well would put hundreds of megabytes
-- of duplicated booking data in the database to no purpose.
create table if not exists audit_log (
  id           bigserial primary key,
  at           timestamptz not null default now(),
  actor_id     uuid,
  actor_email  text,
  key          text not null,
  action       text not null,
  bytes        int
);
create index if not exists audit_log_at  on audit_log(at desc);
create index if not exists audit_log_key on audit_log(key, at desc);

alter table audit_log enable row level security;

-- Readable by anyone signed in, writable by nobody. The only thing that adds a
-- row is the trigger below, which runs as the owner.
drop policy if exists audit_log_read on audit_log;
create policy audit_log_read on audit_log for select to authenticated using (true);
grant select on audit_log to authenticated;

-- Append-only, enforced rather than merely intended. An audit log that can be
-- tidied up is not an audit log.
create or replace function audit_log_no_edits()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only';
end;
$$;

drop trigger if exists audit_log_immutable on audit_log;
create trigger audit_log_immutable
  before update or delete on audit_log
  for each row execute function audit_log_no_edits();

-- The recorder. On app_data rather than in the app, so it cannot be forgotten
-- at a call site or skipped by a script — every write is caught wherever it
-- came from.
--
-- auth.uid() is null for the service key, which is how the scheduled jobs and
-- the Netlify functions appear. That distinction is worth keeping: "the nightly
-- backup wrote this" and "a person wrote this" are different answers.
create or replace function audit_app_data()
returns trigger
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  uid uuid := auth.uid();
  em  text;
begin
  if uid is not null then
    select email into em from profiles where id = uid;
  end if;

  insert into audit_log (actor_id, actor_email, key, action, bytes)
  values (
    uid,
    coalesce(em, case when uid is null then 'server' else 'unknown' end),
    coalesce(new.key, old.key),
    lower(tg_op),
    length(coalesce(new.value, old.value)::text)
  );
  return new;
end;
$$;

drop trigger if exists app_data_audit on app_data;
create trigger app_data_audit
  after insert or update or delete on app_data
  for each row execute function audit_app_data();

select 'audit_log ready' as status, count(*) as rows from audit_log;
