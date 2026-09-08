-- ─────────────────────────────────────────────────────────────────────────────
-- URGENT — let signed-in users read and write app_data again
--
-- Run this whole file in a NEW Supabase SQL editor tab, now.
--
-- Symptom: since real accounts went in, the app reads with a session instead of
-- the anon key. app_data has row level security with policies written for anon
-- only, so a session matches nothing and every read comes back as an empty
-- list — a 200 with [], not an error. The app then falls back to its hardcoded
-- INITIAL_BOOKINGS seed list, which looks like the farm's data with everything
-- recent missing.
--
-- Nothing has been lost: the real rows are intact and untouched. But a Save
-- from a session in that state would write the seed data over them, so this
-- goes in before anyone saves anything.
-- ─────────────────────────────────────────────────────────────────────────────

-- What is actually there right now, for the record.
select relname,
       relrowsecurity as rls_enabled
from pg_class where relname = 'app_data';

select policyname, roles, cmd
from pg_policies
where schemaname = 'public' and tablename = 'app_data'
order by policyname;

-- The fix: a signed-in user gets the same access the anon key has had all
-- along. No wider — app_data is the whole business, and every role that can
-- sign in has always been able to reach it.
drop policy if exists app_data_authenticated on app_data;
create policy app_data_authenticated on app_data
  for all to authenticated
  using (true) with check (true);

grant select, insert, update, delete on app_data to authenticated;

-- Prove it: this must return one row with a large value.
select key, length(value::text) as bytes, updated_at
from app_data where key = 'hawthbush_bookings_v6';
