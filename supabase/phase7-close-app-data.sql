-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 7 — close app_data to the anon key
--
-- This is the one that finishes the job. Everything before it reduced what was
-- exposed; this removes the exposure.
--
-- DEPLOY public/book-accom.html FIRST, then run this. The page has to be asking
-- for properties the new way before the old way stops working.
--
-- What is there now:
--   app_data · "Allow all for anon" · ALL commands · {anon}
-- Anyone holding the key from the JavaScript bundle can read, write and delete
-- the entire business: every wedding, every guest, every phone number.
--
-- What the public pages genuinely still need from app_data:
--   hbf_terms_v1         the letting terms       — public by design
--   hbf_ticket_terms_v1  the ticket terms        — public by design
--   hbf_properties_v1    pricing and availability rules — NOT public: it also
--                        holds the Airbnb iCal import URLs, which are secret
--                        by virtue of being unguessable. Served through a
--                        function below that leaves them behind.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── The properties projection ────────────────────────────────────────────────
-- An allowlist, not a denylist. A field added later will simply not reach the
-- public page until it is named here — which is the safe direction to fail in
-- for something served to the whole internet.
create or replace function public_properties()
returns jsonb
language sql
security definer
set search_path = public, extensions
stable
as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id',                   p->>'id',
    'name',                 p->>'name',
    'sleeps',               p->'sleeps',
    'colour',               p->>'colour',
    'colourBg',             p->>'colourBg',
    'publicBookable',       p->'publicBookable',
    'baseRate',             p->'baseRate',
    'seasons',              p->'seasons',
    'depositPct',           p->'depositPct',
    'balanceWeeks',         p->'balanceWeeks',
    'minNights',            p->'minNights',
    'maxNights',            p->'maxNights',
    'checkInDays',          p->'checkInDays',
    'checkOutDays',         p->'checkOutDays',
    'checkInFrom',          p->>'checkInFrom',
    'checkOutBy',           p->>'checkOutBy',
    'checkInFromWedding',   p->>'checkInFromWedding',
    'checkOutByWedding',    p->>'checkOutByWedding',
    'bookingHorizonMonths', p->'bookingHorizonMonths',
    'longStayDiscount',     p->'longStayDiscount',
    'longStayDiscountPct',  p->'longStayDiscountPct',
    'longStayThreshold',    p->'longStayThreshold',
    'breakageDefault',      p->'breakageDefault',
    'blockedByFarmEvents',  p->'blockedByFarmEvents'
    -- deliberately absent: airbnbImportUrl, lastSyncedAt, bookaletName
  ))), '[]'::jsonb)
  from jsonb_array_elements(
    coalesce((select value from app_data where key = 'hbf_properties_v1'), '[]'::jsonb)
  ) p;
$$;

grant execute on function public_properties() to anon, authenticated;

-- ── Close app_data ───────────────────────────────────────────────────────────
drop policy if exists "Allow all for anon" on app_data;

-- Anon keeps exactly two keys, read-only, and both are published text meant for
-- the public to read.
drop policy if exists app_data_public_terms on app_data;
create policy app_data_public_terms on app_data
  for select to anon
  using (key in ('hbf_terms_v1', 'hbf_ticket_terms_v1'));

-- Signed-in users are unaffected — this policy is already in place and is what
-- the app has been using since real accounts went in.
--   app_data_authenticated · ALL · {authenticated}

-- ── Close the file bucket properly ───────────────────────────────────────────
-- The last of the legacy public-bucket policies. Files are reached by signed-in
-- users through booking_files_read.
drop policy if exists "Allow public access pjwyyr_0" on storage.objects;

-- ── Tidy ─────────────────────────────────────────────────────────────────────
-- Was created without a role, so it applied to PUBLIC. The USING clause already
-- made it safe (auth.uid() is null for anon, matching nothing), but saying what
-- is meant beats relying on that.
drop policy if exists profiles_read_own on profiles;
create policy profiles_read_own on profiles
  for select to authenticated using (auth.uid() = id);

-- ── Proof ────────────────────────────────────────────────────────────────────
select policyname, roles, cmd
from pg_policies
where (schemaname='public' and tablename='app_data')
   or (schemaname='storage' and tablename='objects')
order by tablename, policyname;
