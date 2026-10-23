-- supabase/2026-10-23e-revoke-table-grants.sql
--
-- Belt and braces on the portal and box office tables. Each already has row
-- level security on with no policies, so a request with the public (anon) key
-- or a signed-in (authenticated) key gets nothing back. But the older ones
-- still carry Supabase's default table privileges for those two roles, which
-- means that protection rests on RLS alone. This takes the privileges away,
-- so a table whose RLS were ever switched off by mistake would still refuse.
--
-- Covered: every table in public named wp_* or box_* that has RLS on and NO
-- policies — the tables only ever reached through SECURITY DEFINER functions —
-- plus the sequences those tables own. Nothing that has policies is touched:
-- app_data, profiles and audit_log are read directly by the staff app under
-- their policies and keep their grants.
--
-- Not affected: the database functions (they run as their owner), the Netlify
-- functions and scheduled jobs (they use the service key, which keeps its
-- privileges), and the staff app and portal (they reach these tables only
-- through functions — checked: no direct REST call to a wp_/box_ table exists
-- in src/ or netlify/ except calendar-feed.js, which uses the service key).
--
-- Safe to run twice. Future tables: every portal migration already ends its
-- CREATE TABLE with "revoke all on table … from anon, authenticated"; keep
-- doing that.

begin;

do $revoke$
declare t record; n int := 0; s int := 0;
begin
  for t in
    select c.oid, c.relname
      from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relkind = 'r'
       and c.relname ~ '^(wp|box)_'
       and c.relrowsecurity
       and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
  loop
    execute format('revoke all on table public.%I from anon, authenticated', t.relname);
    n := n + 1;
  end loop;

  for t in
    select q.relname
      from pg_class q
      join pg_namespace ns on ns.oid = q.relnamespace
      join pg_depend d on d.objid = q.oid and d.deptype = 'a'
      join pg_class c on c.oid = d.refobjid
     where ns.nspname = 'public' and q.relkind = 'S'
       and c.relname ~ '^(wp|box)_'
       and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
  loop
    execute format('revoke all on sequence public.%I from anon, authenticated', t.relname);
    s := s + 1;
  end loop;

  raise notice 'revoked anon/authenticated privileges on % tables and % sequences', n, s;
end $revoke$;

commit;

-- Check afterwards (should return no rows):
--   select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public' and c.relkind in ('r','S') and c.relname ~ '^(wp|box)_'
--      and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select'));
