-- ─────────────────────────────────────────────────────────────────────────────
-- PERMISSIONS AUDIT — read-only, changes nothing
--
-- ONE query, so the SQL editor shows the whole thing. (The previous version was
-- five separate statements and the editor only ever displays the last result,
-- which is why it kept showing the functions.)
--
-- Run it and paste the whole table back. Anything with a ⚠ in `flag` is worth
-- looking at; the rest is there for context.
-- ─────────────────────────────────────────────────────────────────────────────

with rls as (
  select n.nspname as sch, c.relname as tbl, c.relrowsecurity as on_,
         (select count(*) from pg_policies p where p.schemaname=n.nspname and p.tablename=c.relname) as pols
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where c.relkind='r' and n.nspname in ('public','storage')
),
grants as (
  select table_schema sch, table_name tbl, grantee,
         string_agg(distinct privilege_type, ',' order by privilege_type) privs
  from information_schema.role_table_grants
  where table_schema in ('public','storage') and grantee in ('anon','authenticated')
  group by 1,2,3
)

-- 1. Tables: is RLS on, and how many policies
select '1 tables' as section,
       r.sch||'.'||r.tbl as item,
       case when r.on_ then 'RLS on' else 'RLS OFF' end as detail,
       r.pols::text as extra,
       case when not r.on_ and exists (select 1 from grants g where g.sch=r.sch and g.tbl=r.tbl and g.grantee='anon')
            then '⚠ no RLS, anon has grants' else '' end as flag
from rls r

union all

-- 2. Policies, anon ones first
select '2 policies',
       schemaname||'.'||tablename||' · '||policyname,
       cmd,
       roles::text,
       case when roles::text like '%anon%' then '⚠ grants anon' else '' end
from pg_policies where schemaname in ('public','storage')

union all

-- 3. Table grants held by anon / authenticated
select '3 grants',
       sch||'.'||tbl,
       grantee,
       privs,
       case when grantee='anon' and privs like '%DELETE%' then '⚠ anon can DELETE'
            when grantee='anon' and privs like '%INSERT%' then '⚠ anon can INSERT'
            else '' end
from grants

union all

-- 4. What anon can actually read: grant AND (no RLS OR a matching policy)
select '4 anon can read',
       c.relname,
       case when c.relrowsecurity then 'via policy' else 'RLS off entirely' end,
       coalesce((select string_agg(p.policyname,', ') from pg_policies p
                  where p.schemaname='public' and p.tablename=c.relname
                    and p.roles::text like '%anon%'),'—'),
       '⚠ readable with the public key'
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where c.relkind='r' and n.nspname='public'
  and has_table_privilege('anon', c.oid, 'SELECT')
  and (not c.relrowsecurity
       or exists (select 1 from pg_policies p where p.schemaname='public'
                    and p.tablename=c.relname and p.roles::text like '%anon%'))

order by 1, 5 desc, 2;
