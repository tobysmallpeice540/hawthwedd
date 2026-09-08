-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 5b — remove the legacy public policies on the file bucket
--
-- Left over from when booking-files was set up as a public bucket. Making the
-- bucket private in Phase 5 stopped the public URL working but did nothing
-- about these, so the contents stayed reachable — and deletable — with the
-- anon key that sits in the JavaScript bundle.
--
-- Run PART ONE now. Run PART TWO once you have confirmed that file previews
-- work while signed in.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── PART ONE: the write permissions. Run this immediately. ───────────────────
-- Nobody should be able to upload to or delete from this bucket without an
-- account, and no read behaviour changes here — so there is nothing to test
-- first. The app's own uploads and deletes go through the authenticated
-- policies created in Phase 5.

drop policy if exists "Allow public uploads pjwyyr_0" on storage.objects;
drop policy if exists "Allow public access pjwyyr_1"  on storage.objects;

select policyname, roles, cmd
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
order by policyname;


-- ── PART TWO: the read permission. Run this AFTER checking previews. ─────────
-- This is the one that could bite: while it exists, file reads work whether or
-- not the session token is reaching storage, which means it is currently
-- masking any problem there. Removing it makes the real state visible — which
-- is the point, but do it when you can look at a booking and check.
--
-- Uncomment and run once previews are confirmed working while signed in:
--
-- drop policy if exists "Allow public access pjwyyr_0" on storage.objects;
