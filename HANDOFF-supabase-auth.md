# Hawthbush Farm — Supabase Auth
## Plan for the security job named in HANDOFF-box-office.md §6

**Repo:** https://github.com/tobysmallpeice540/hawthwedd
**Surveyed against:** commit `80d840b` plus the box office work, 21 Aug 2026
**Status:** planned, not started. Nothing here has been built.
**Owner:** Toby Smallpeice (toby@smallpeice.net)

---

## 1. Why this is worth doing now

The box office handoff put it plainly: the password gates the interface, and the
Supabase anon key is the actual door — and it's unlocked. That is still true.
Two things found while surveying the code make it more urgent than that
paragraph implied.

### The leak is already public

It isn't a theoretical hole reachable by someone who knows to open the
JavaScript bundle. Two pages on the open internet demonstrate it:

| Page | What it reads with the anon key |
|---|---|
| `public/book-viewing.html:158` | `hawthbush_bookings_v6` — the entire wedding diary, and `hbf_enquiries_v1` — every enquiry |
| `public/book-accom.html:1244` | `hbf_accom_v1` — every cottage booking: guest names, emails, phones, prices |

Both do it for an ordinary reason: to work out which dates and slots are free.
Neither needs the names to do it. But the key in those pages grants read *and
write* on all of `app_data`, so anyone who copies it out of the page source has
the whole customer database and can change it.

`public/terms.html` also reads `app_data`, but only the two terms keys, which
are meant to be public.

### The rest of the picture

- Three shared logins are compiled into the bundle (`src/main.jsx:45-48`).
  `admin / Hawth8u$h` is readable via View Source.
- The chosen role is kept in `sessionStorage` (`hbf_auth_role_v1`) and trusted
  by `App.jsx`. Nothing is checked server-side — the app simply decides what to
  render, so `bar` and `cleaner` change what's drawn, not what's reachable.
- The `booking-files` storage bucket is served from `/object/public/` —
  contracts and uploads sit on public URLs.
- Nothing records who changed or deleted what.

The box office tables built this week are the exception and the template: RLS
on with no policies at all, public reads through `SECURITY DEFINER` functions
that expose only what a stranger may see, and writes behind a service key.
The pattern is proven in this codebase now; this job applies it to everything
older.

---

## 2. The good news: the client-side job is small

The box office handoff estimated "reworking every read and write in `App.jsx`
to use the session token", and called it probably the largest outstanding job
on the app. The first half of that isn't right, and it's worth knowing before
budgeting.

`App.jsx` makes **85 data calls** — 52 `sbGet`, 32 `sbSet`, 1 `sbDelete`. Every
one goes through helpers defined in one place:

```
src/App.jsx:49-108    sbGet / sbSet / sbDelete       ← all 85 call sites
src/App.jsx:111-135   sbUploadFile / sbDeleteFile    ← storage
src/App.jsx:7307      one stray direct upload        ← duplicates the helper
```

So attaching a session token to every read and write in the admin app is a
change to **six places**, not eighty-five. The call sites don't move.

The real work is elsewhere, and this plan is ordered around where it actually
is: the two public pages, and the twelve Netlify functions still holding the
anon key.

---

## 3. Target state

- **Supabase Auth**, email and password, one account per person rather than
  three shared logins — as many accounts as needed, each holding one of the
  three existing roles.
- A **`profiles`** table mapping `auth.users.id` to a name and a role.
- **RLS on `app_data`**, keyed to the signed-in user — so the key in the bundle
  grants nothing on its own.
- **Public pages read through `SECURITY DEFINER` functions** that return
  availability and nothing else. No guest name ever reaches a public page again.
- **Netlify functions hold the service key**, not the anon key.
- **Storage private**, with signed URLs minted server-side.
- **An append-only audit log** — which is what was actually wanted the day data
  disappeared.
- **A leaver is revoked without a deploy.**

---

## 4. The order of work

Each phase ends somewhere safe to stop, and each is useful on its own. The
sequence matters more than usual here, because two of these phases will break
things badly if they land in the wrong order.

### Phase 1 — Take the database off the public pages ✅ BUILT 22 Aug 2026

**Correction to the original plan.** As first written this phase also turned on
RLS for `app_data`. That cannot happen here, and the reason matters:

- `src/App.jsx` makes all 85 of its reads and writes with the **anon key**
- 12 Netlify functions still use the **anon key**

A restrictive policy today would break the entire admin app and every scheduled
job with it. The RLS switch therefore moves to its own step **after Phase 3**,
once the app and the functions have credentials of their own.

**What that means for the claim this phase closes the leak.** It does not, on
its own. It stops the two public pages *handing the data out* — today a visitor
receives the whole customer database in a network response with no skill
required — but the anon key still grants access to anyone who reads it out of
the bundle and goes looking. The move is from "handed to you" to "you have to
go and get it". Real, and worth having, but not closure. Closure is the RLS
step, and that waits for Phase 3.

**Built:**

1. `supabase/phase1-public-availability.sql` — two `SECURITY DEFINER`
   functions:
   - `public_accom_busy()` → occupied stays as property + dates. Mirrors
     `buildAvailability()` exactly, including its two quirks: a cancelled
     booking frees its dates, a pending one still holds them. Handles both
     record shapes.
   - `public_viewing_availability()` → `taken` slots, `blocks`, and
     `eventDays` — a bare list of dates. The page only ever asked "is something
     on that day"; it never needed to know whose wedding it was.
2. `public/book-accom.html` now reads `hbf_properties_v1` (pricing rules, not
   sensitive) and `hbf_terms_v1` (public by design), and nothing else. It also
   had a third read of the bookings blob whose result was **discarded** — it
   downloaded every guest record to show a thank-you page. Removed.
3. `public/book-viewing.html` reads **nothing** from `app_data` at all. Its
   reader helper is gone.

**Verified:** 15 checks in `supabase/phase1-test.mjs`, including a diff against
the old client-side logic transcribed verbatim, and assertions that no name,
email, phone or price appears anywhere in either function's output.

**Still to do for this phase:** nothing. The RLS switch is tracked below as its
own step.

### Phase 2 — Move the server to the service key ✅ BUILT 22 Aug 2026

All twelve switched from the hardcoded anon key to
`process.env.SUPABASE_SERVICE_KEY`:

```
backup-data              calendar-feed           create-accom-checkout
handle-viewing           property-calendar       send-accom-email
send-accom-reminders     send-cleaning-summary   stripe-accom-webhook
submit-viewing           sync-all-icals          sync-property-ical
```

The constant name is unchanged in every file, so nothing downstream moved —
only the value it holds. **No fallback to the anon key**, deliberately: a
missing variable must fail loudly rather than quietly reopen what this closes.

`netlify/functions/` now contains **zero** anon-key literals. The only places
it remains are the public pages, where it belongs, and `src/App.jsx`, which is
Phase 3.

Four header comments still described the old arrangement and have been
corrected — a stale comment about a credential is worse than none.

**Verify after deploying:** `/calendar.ics` and `/ical/<property>.ics` both read
`app_data` and are not scheduled, so they answer over HTTP. If they still
return events, the service key is working. Then watch the 3am backup and the
7am reminders land once before considering this done.

### Phase 3 — Real accounts in the admin app ✅ BUILT 22 Aug 2026

- `supabase/phase3-auth.sql` — `profiles`, a signup trigger that guarantees
  every account has a role, a backfill for accounts made before it ran, RLS so
  a person reads only their own row, and `my_profile()`.
- `src/main.jsx` — the three shared passwords are gone. Email and password
  through Supabase, a reset-by-email path, sessions that persist and refresh
  silently. The role is read from the database, never from `sessionStorage`.
- `src/App.jsx` — one `sbAuthHeaders()` now supplies the credential for all 85
  reads and writes, the two storage helpers, the stray upload and two file
  downloads. `SUPABASE_KEY` appears in exactly two places: where it is declared
  and where it is read.

**Rollback is built in.** With no session the helpers fall back to the anon key,
and RLS is not on yet, so a failed sign-in deploy cannot lock anyone out of
their data. That fallback disappears in Phase 7, which is the point of it.

**Also built (asked for alongside):** bar logins get a Ticket Check-in tab
beside Bar Management. `box-admin.js` now accepts a verified Supabase session as
well as the office key, and authorises per role — a bar session reaches
`door.events`, `door.list`, `door.admit`, `door.unadmit` and nothing else.
24 checks in the authorisation matrix confirm every sensitive action is refused.
Check-ins now record **who** scanned them, which was not knowable before.

**Verified:** 8 checks on the schema (`supabase/phase3-test.mjs`), 24 on the
authorisation matrix.

**Toby's setup:** create the accounts, set roles, point Supabase SMTP at Resend.

### Phase 4 — Roles, and a staff accounts screen ✅ BUILT 22 Aug 2026

Two thirds of this phase turned out to be done already:

- **The role comes from the profile** — done in Phase 3.
- **Box office restricted by role** — done when the door was opened to bar
  staff. `box-admin.js` checks `allowedFor(role, action)` on every request, so
  the box tables need no separate RLS policies: nothing reaches them except
  through that function, and it already refuses. 24 tests cover the matrix.

What was left, and is now built:

- `netlify/functions/user-admin.js` — create a login, change a role, switch one
  off, send a reset. Admin only, and deliberately **does not** accept the
  office key: that is a shared secret with nobody attached, and creating logins
  should be attributable to a person.
- **Staff → Logins** in the app. Lists everyone with their role and when they
  last signed in. Switching someone off sets `active = false` *and* bans the
  account at Supabase, so a leaver is out in both senses within seconds.
- Guard rails: you cannot remove your own administrator access, switch off your
  own account, or delete yourself. Without those the last admin could lock the
  building with everyone outside.

**`HBF_ADMIN_TOKEN` is retired from the app.** No more pasting a key per device
— an admin session is the credential now. It remains an env var for
server-to-server calls (`brevo-sync-cron`, `box-billing`, the ticket webhook),
where there is no person to be. `boxAdmin()` still sends an old key if one is
left in localStorage, so nobody mid-session was thrown out by the change.

### Phase 5 — Storage ✅ BUILT 22 Aug 2026
`booking-files` was a public bucket: signed contracts and paperwork on URLs
with no login and no expiry. It is now private, with policies on
`storage.objects` granting access to signed-in users only.

The app changed with it:
- the stray upload was folded back into `sbUploadFile`, so there is one path in
  and out and the bucket can be changed in one place;
- `storageUrl()` builds the authenticated URL **and repairs the public ones
  already stored on records**, so nothing had to be migrated;
- two `<a href>` "Open" links became `openStoredFile()` — a bare link cannot
  carry an Authorization header, so it fetches with credentials and hands the
  browser a blob instead. Same click, same result, no guessable URL.

### Phase 6 — Audit log ✅ BUILT 22 Aug 2026
A trigger on `app_data`, not calls in the app — it cannot be forgotten at a
call site or skipped by a script. Every insert, update and delete is recorded
with who, which key, when and how big.

Append-only, and **enforced**: a trigger refuses updates and deletes, including
from an administrator. An audit log that can be tidied up is not an audit log.

`auth.uid()` is null for the service key, so scheduled jobs record as `server`
and are distinguishable from a person — a distinction worth having.

It records the key, the person and the moment, **not the contents**. The daily
backup already keeps thirty days of full snapshots; between the two you can
answer "who touched this" and "what did it look like before" without putting
hundreds of megabytes of duplicated bookings in the database.

Visible in **Settings → Activity**, with the build-version ping filtered out
(every browser writes it on every load) and a *People only* tick.

**Verified:** 11 checks in `supabase/phase5-6-test.mjs`.

### Phase 7 — Close app_data to the anon key ✅ BUILT 22 Aug 2026

The audit found `app_data` carried a legacy policy — **"Allow all for anon",
ALL commands** — so anyone with the key from the JavaScript bundle could read,
write and delete the entire business. That policy is gone.

Anon now has exactly one policy: `SELECT` on `hbf_terms_v1` and
`hbf_ticket_terms_v1`, both published text meant to be read.

`hbf_properties_v1` could not simply be left open: alongside the pricing rules
it holds three **Airbnb iCal import URLs**, which are secret by virtue of being
unguessable. It is served through `public_properties()`, an allowlist
projection — a field added later will not reach the public page until it is
named, which is the safe direction to fail in.

The last legacy storage policy went with it, so `booking-files` is finally
reachable only by signed-in users.

**Verified:** 14 checks in `supabase/phase7-test.mjs`, including that anon can
still read both terms keys, cannot read the diary, cottages or properties,
cannot write or delete, that the iCal URLs appear nowhere in the projection,
and that signed-in users are unaffected.

**Deploy `public/book-accom.html` BEFORE running the SQL.**

## 5. Decisions taken

All settled 21 Aug 2026. Build to these.

| # | Decision | Answer |
|---|---|---|
| 1 | Accounts | Many, one per person, each holding one of the three existing roles |
| 2 | How far roles restrict | **Screens only, for now** — see below |
| 3 | Account administration | A staff accounts screen in the app, under Staff |
| 4 | Auth library | Supabase's auth client for sign-in and refresh only; the data helpers stay hand-rolled `fetch` |
| 5 | Sign-in | Passwords, with reset by email, and long-lived sessions |
| 6 | Auth email | Through Resend, from `hello@hawthbushfarm.co.uk` |

### What decision 2 means, precisely

Roles decide **which screens render**, not what the data layer permits. A
signed-in bar hand could, with the browser's network tab, read blobs their
screens don't show them.

That is a deliberate, reasonable trade and it is still an enormous improvement
on today, because:

- the login is per person, not a password shared round a WhatsApp group;
- a leaver is revoked in seconds, without a deploy;
- **nothing is readable without signing in at all** — which is the actual hole,
  and Phase 1 closes it regardless of this decision;
- every write can be attributed to a person, so the audit log is real.

**It is upgradeable with nothing wasted.** Adding projection functions later is
additive — new functions, and the two role screens repointed at them. No
migration, no undoing.

**One exception, and it comes free.** The box office tables are proper
normalised tables rather than JSON blobs, so RLS *can* restrict them per role
without any projection work. Buyer names, emails and phone numbers therefore
stay admin-only even under "screens only" — which is a decent argument that
building the box office on real tables was the right call.

## 6. Effort — and why the calendar is longer than the work

These were originally written as developer-days, carried over from the box
office handoff's register. That's the wrong unit: the code is written by an
agent in a session, so the honest split is build time, setup time, and the
elapsed time you should let each phase sit before starting the next.

| Phase | Build | Your setup | Then wait for |
|---|---|---|---|
| 1 — public pages | ~2 h ✅ done | run one SQL file | A few days of live bookings |
| 2 — service key | ~45 min ✅ done | none | **One overnight** — 3am backup, 7am reminders |
| 3 — real accounts | ~3 h ✅ done | ~30 min | Everyone to sign in once |
| 4 — roles + staff screen | ~3 h | account creation | — |
| 5 — storage | ~1 h ✅ done | none | — |
| 6 — audit log | ~1 h ✅ done | none | — |
| 7 — close app_data | ~1 h ✅ done | none | — |

Roughly eleven hours of building, and it should still take two or three weeks.

**The schedule is set by verification, not by typing.** Phase 2 cannot be
validated faster than one night, because that is when the crons run. Phase 1
wants several days of real bookings before anyone should trust it. Compressing
those windows is the only way this job goes wrong badly.

### The one thing that can't be tested in advance

The availability functions can be checked against a throwaway Postgres exactly
as the box office schema was (see `supabase/schema-test.mjs`). What cannot be
checked without production data is the only question that matters: *does the
new function agree with the old client-side logic on real bookings?* Getting
that wrong is a double booking.

Two ways to close it, in preference order:

1. **Ship both paths and log disagreements.** The page computes availability the
   old way and the new way, uses the old answer, and logs any difference to the
   console for a few days. Catches cases a snapshot would miss, and needs
   nothing from you.
2. **Export `hbf_accom_v1`** and diff both implementations across every date in
   the calendar before deploying anything.

### Why Phase 1 is smaller than it sounds

`book-accom.html` downloads the entire bookings blob — names, emails, phones,
prices, payment schedules — and then uses exactly three fields from it:
`stays[].propertyId`, `checkIn`, `checkOut` (`public/book-accom.html:1124`).
`buildAvailability()` never touches anything else.

So the replacement is not a port of the pricing logic. It is an RPC returning
busy date ranges, handed to code that already expects that shape. The pricing
rules in `hbf_properties_v1` aren't sensitive and can stay exactly where they
are.

## 7. Things that will bite

- The stale-build guard writes `app_data` on every load (see Phase 3).
- `backup-data.js` restores as well as reads (Phase 2).
- The role in `sessionStorage` is trusted by `App.jsx` today; it must come from
  the profile once sessions exist, or the new auth is decorative too.
- Rotating the anon key afterwards is worth doing, but it breaks every public
  page until they're redeployed — do it in one go, not piecemeal.
- The box office's `HBF_ADMIN_TOKEN` becomes redundant in Phase 4. Don't remove
  it before then; it's the only thing protecting the buyer list until sessions
  can be checked server-side.

---

## 8. Verified against production — 22 Aug 2026

Tested with the anon key, the one printed in the public page source:

| Probe | Result |
|---|---|
| Read `hawthbush_bookings_v6` | **closed** |
| Read `hbf_accom_v1` | **closed** |
| Read `hbf_enquiries_v1` | **closed** |
| Read `hbf_properties_v1` | **closed** |
| Read `hbf_email_log_v1` | **closed** |
| Read `hbf_terms_v1` / `hbf_ticket_terms_v1` | readable — by design |
| Write to `app_data` | refused, 401 |
| Delete from `app_data` | 0 rows |
| Fetch a signed contract from the bucket | refused, 404 |
| `public_properties()` | 3 returned, 1 publicly bookable, prices present, **no iCal URLs** |
| `box_reserve_order` / `box_expire_holds` | not callable |

At the start of the day that key granted read *and write* on every wedding,
every cottage booking, every enquiry, every email, and delete on every file.

### Found along the way, none of it in the original plan
- `booking-files` allowed **anon DELETE** — anyone could delete a signed contract
- `box_reserve_order` was **anon-callable**: `revoke … from public` does not
  remove the direct grant Supabase gives `anon` on every new function
- `app_data` carried **"Allow all for anon", ALL commands** — the real hole,
  and nobody knew it was there
- Three separate places where the app silently substituted built-in example
  data for a failed read, the worst of which would have overwritten 42 weddings
  had anyone pressed Save

### The lesson, for whoever picks this up
Every one of those was invisible because a failure looked like an empty result.
The app now refuses to save over a fallback, shows a banner when a read is
refused, and throws when an RPC fails. Keep it that way.

## 9. Reference

- The visual plan: https://claude.ai/code/artifact/754ac441-1c4b-4477-8f3d-aa105e8abbee
- The job this follows from: `HANDOFF-box-office.md` §6
