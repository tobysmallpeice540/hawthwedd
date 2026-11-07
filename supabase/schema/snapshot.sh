#!/usr/bin/env bash
# supabase/schema/snapshot.sh — writes the database's STRUCTURE into the repo.
#
# Run every night by .github/workflows/schema-snapshot.yml (which commits only
# when something changed). Can be run by hand from the repo root with Docker
# and PGPASSWORD set to the schema_reader password.
#
#   supabase/schema/public.sql   pg_dump --schema-only of the public schema:
#                                tables, columns, indexes, triggers, RLS, the
#                                policies, grants, sequences, views, functions
#   supabase/functions.sql       every public function, alphabetical, from
#                                pg_get_functiondef — the quick reference
#   supabase/schema/storage.sql  storage bucket settings and storage policies
#
# The login is schema_reader (migration 2026-11-07a): it can see the structure
# and cannot read a row. Nothing here is ever hand-edited; change the database
# with a dated migration and let the next run pick it up.
set -euo pipefail

REF=rkqbyisfmvwulsyxzwjz
REGION=eu-central-1
DB_USER="schema_reader.$REF"
IMAGE="${PG_IMAGE:-postgres:17}"   # pg_dump must be at least the server's major version
: "${PGPASSWORD:?PGPASSWORD is empty: add the repository secret SUPABASE_SCHEMA_DB_PASSWORD (the schema_reader password).}"
export PGPASSWORD

pg() {   # a PostgreSQL 17 client, run in Docker
  docker run --rm -i -e PGPASSWORD -e PGSSLMODE=require -e PGCONNECT_TIMEOUT=15 \
    -e PGAPPNAME=schema-snapshot "$IMAGE" "$@"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The session pooler (the direct database address is IPv6-only, which GitHub's
# runners cannot reach). Newer projects are on aws-1, older on aws-0.
HOST=""
for h in "aws-1-$REGION.pooler.supabase.com" "aws-0-$REGION.pooler.supabase.com"; do
  if pg psql -h "$h" -p 5432 -U "$DB_USER" -d postgres -Atc "select 1" >/dev/null 2>"$TMP/err"; then
    HOST="$h"; break
  fi
  echo "Could not sign in via $h: $(tr '\n' ' ' < "$TMP/err" | head -c 300)"
done
[ -n "$HOST" ] || { echo "::error::No pooler address accepted the schema_reader login."; exit 1; }
echo "Connected via $HOST"
C=(-h "$HOST" -p 5432 -U "$DB_USER" -d postgres)

# ── public.sql ──────────────────────────────────────────────────────────────
pg pg_dump "${C[@]}" --schema-only --schema=public --no-owner \
  --no-publications --no-subscriptions --no-security-labels > "$TMP/public.sql"
# Lines that change on every run or with the client, not the database:
# \restrict / \unrestrict carry a random key (pg_dump 17.6+).
sed -i -e '/^\\restrict /d' -e '/^\\unrestrict /d' -e '/^-- Dumped by pg_dump version/d' "$TMP/public.sql"

# ── functions.sql ───────────────────────────────────────────────────────────
FN_QUERY="
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  left join pg_depend dep on dep.objid = p.oid and dep.deptype = 'e'
  where n.nspname = 'public' and p.prokind = 'f' and dep.objid is null"
FN_COUNT="$(pg psql "${C[@]}" -Atc "select count(*) $FN_QUERY")"
pg psql "${C[@]}" -Atc "select string_agg(pg_get_functiondef(p.oid) || E';\n', E'\n'
  order by p.proname, pg_get_function_identity_arguments(p.oid)) $FN_QUERY" > "$TMP/functions.body"
FN_MD5="$(md5sum < "$TMP/functions.body" | cut -c1-32)"
{
  cat <<EOF
-- supabase/functions.sql
--
-- Every function in the public schema of the Booking App database
-- ($REF), straight out of the catalogue with pg_get_functiondef(),
-- alphabetical. GENERATED nightly by supabase/schema/snapshot.sh — never edit
-- by hand; change a function with a dated migration and the next run updates
-- this file. The full structure (tables, RLS, policies, grants) is in
-- supabase/schema/public.sql.
--
-- A REFERENCE COPY, not a migration: running it whole would recreate every
-- function, which is almost never what you want.
--
-- $FN_COUNT functions · md5 of the definitions below $FN_MD5
--
-- To check one function against the live database, compare BODIES, not
-- pg_get_functiondef (see CLAUDE.md):
--   select md5(trim(regexp_replace(prosrc, '\s+', ' ', 'g'))), pg_get_function_arguments(oid)
--     from pg_proc where proname = '<name>';

EOF
  cat "$TMP/functions.body"
} > "$TMP/functions.sql"

# ── storage.sql ─────────────────────────────────────────────────────────────
{
  cat <<'EOF'
-- supabase/schema/storage.sql — storage buckets and the policies on storage.objects.
-- GENERATED nightly by supabase/schema/snapshot.sh; never edit by hand.

-- Buckets
EOF
  pg psql "${C[@]}" -Atc "select string_agg(format('-- %s: %s, size limit %s, file types %s', id,
      case when public then 'PUBLIC' else 'private' end,
      coalesce(file_size_limit::text || ' bytes', 'none'),
      coalesce(array_to_string(allowed_mime_types, ', '), 'any')), E'\n' order by id)
    from storage.buckets"
  printf '\n-- Policies\n'
  pg psql "${C[@]}" -Atc "select string_agg(format('create policy %I on %I.%I as %s for %s to %s%s%s;',
      policyname, schemaname, tablename, lower(permissive), lower(cmd), array_to_string(roles, ', '),
      coalesce(E'\n  using (' || qual || ')', ''), coalesce(E'\n  with check (' || with_check || ')', '')),
      E'\n\n' order by tablename, policyname)
    from pg_policies where schemaname = 'storage'"
} > "$TMP/storage.sql"

# ── Never write a short or empty copy over a good one ───────────────────────
fail() { echo "::error::$1 — nothing written."; exit 1; }
grep -q '^CREATE TABLE public.app_data ' "$TMP/public.sql" || fail "public.sql has no app_data table"
grep -q '^CREATE TABLE public.todo_items ' "$TMP/public.sql" || fail "public.sql has no todo_items table"
[ "$(grep -c '^CREATE POLICY ' "$TMP/public.sql")" -ge 3 ] || fail "public.sql has almost no policies"
[ "$(grep -c '^CREATE FUNCTION public\.' "$TMP/public.sql")" -ge 100 ] || fail "public.sql has too few functions"
[ "$FN_COUNT" -ge 100 ] || fail "only $FN_COUNT functions read"
[ "$(grep -c '^CREATE OR REPLACE FUNCTION' "$TMP/functions.sql")" -ge "$FN_COUNT" ] || fail "functions.sql does not hold all $FN_COUNT"
grep -q 'booking_files_read' "$TMP/storage.sql" || fail "storage.sql is missing the booking-files policies"

mkdir -p supabase/schema
cp "$TMP/public.sql" supabase/schema/public.sql
cp "$TMP/functions.sql" supabase/functions.sql
cp "$TMP/storage.sql" supabase/schema/storage.sql
echo "Written: $FN_COUNT functions, $(grep -c '^CREATE TABLE ' supabase/schema/public.sql) tables, $(grep -c '^CREATE POLICY ' supabase/schema/public.sql) public policies."
