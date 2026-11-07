-- supabase/2026-11-07a-schema-reader.sql
--
-- A login for the nightly schema snapshot (.github/workflows/schema-snapshot.yml,
-- supabase/schema/snapshot.sh), which writes the database's STRUCTURE into the
-- repo: tables, indexes, triggers, RLS policies, grants and functions.
--
-- It can see the shape of the database and not one row of it:
--   · MAINTAIN on the public tables — pg_dump must lock each table it
--     describes (ACCESS SHARE), and since PostgreSQL 17 MAINTAIN allows the
--     lock without SELECT. Structure comes from the system catalogues, which
--     every login can read. It has no SELECT, INSERT, UPDATE or DELETE on any
--     public table.
--   · SELECT on storage.buckets — the bucket settings (private or public, size
--     limit, file types). Not anyone's files.
-- The price of MAINTAIN: someone holding this password could lock a table or
-- run VACUUM/ANALYZE/REINDEX/CLUSTER on it. That could slow or stall the app
-- until the connection was ended; it could not read or change data.
--
-- It is created WITHOUT a password, so it cannot sign in. The password is set
-- by the snippet in CLAUDE.md ("Schema snapshot"), run in the Supabase SQL
-- editor, which makes it inside the database (pgcrypto) so it never appears in
-- the text of a logged statement (log_statement = ddl; pgaudit.log = none), and
-- shows it once to paste into the repository secret SUPABASE_SCHEMA_DB_PASSWORD.
-- Running that snippet again makes a new password (the old one stops working).
--
-- Applied by Toby in the Supabase SQL editor (7 Nov 2026): creating a login and
-- granting it privileges is his to approve, not a Claude session's.
--
-- Tables created later by postgres (every migration and the SQL editor) get
-- MAINTAIN by default privileges. A table created by another role would make
-- the snapshot fail loudly — re-run the grant below.

do $r$
begin
  if not exists (select 1 from pg_roles where rolname = 'schema_reader') then
    create role schema_reader login noinherit nocreatedb nocreaterole noreplication connection limit 3;
  end if;
end $r$;

comment on role schema_reader is
  'Nightly schema snapshot (GitHub Actions). Structure only: MAINTAIN on public tables, SELECT on storage.buckets. See supabase/2026-11-07a-schema-reader.sql.';

alter role schema_reader set statement_timeout = '120s';
alter role schema_reader set lock_timeout = '10s';
alter role schema_reader set idle_in_transaction_session_timeout = '60s';

grant usage on schema public to schema_reader;
grant maintain on all tables in schema public to schema_reader;
alter default privileges for role postgres in schema public grant maintain on tables to schema_reader;

-- Functions: this login is granted none. It can call only what PUBLIC may call,
-- and PUBLIC includes anon — so nothing the anonymous web key cannot already
-- call over the API. It has no JWT, so auth.uid() is null and is_staff() false.

grant usage on schema storage to schema_reader;
grant select on storage.buckets to schema_reader;
