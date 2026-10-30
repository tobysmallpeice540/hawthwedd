# Hawthbush Farm venue management app

React + Vite on Netlify, with Supabase (Postgres + Auth + Storage) behind it.
Almost all UI lives in one file: `src/App.jsx` — ~19,000 lines, 1.2MB.

## Working agreements

- **Commit straight onto `main`.** No feature branches unless asked.
- Sessions could not push until 25 Oct 2026; attaching the repo with push
  access now works, and a push to `main` deploys. Toby's local copy is in
  GitHub Desktop at `~/Documents/GitHub/hawthwedd` — he pulls after a push.
- Toby wants work reviewed critically before it ships. Flag anything worth fixing.
- Estimates are **developer-hours**, not calendar time.

## Layout

| Path | What |
| --- | --- |
| `src/App.jsx` | Everything. Inline-styled React. |
| `src/main.jsx` | Entry point, plus the global stylesheet (the whole mobile layer). |
| `portal.html` + `src/portal/` | The client portal — a **second Vite entry**, its own bundle. A wedding client downloads none of the staff app; verified at build time by checking `dist/portal.html` never references `main-*.js`. |
| `netlify/functions/` | 30 functions — Stripe, SignWell, Brevo, Xero, box office, iCal, backups. |
| `supabase/` | Box office schema, the seven security-phase migrations, their `.mjs` test suites. |
| `tests/` | Node suites (`.cjs`) run against a real Postgres and real pages. |

The schema is only **partly** captured: `supabase/box-office-schema.sql` and
`supabase/functions.sql` (22 functions, 58 execute grants). Tables, indexes,
triggers, RLS policies and table grants are captured nowhere. Refresh
`functions.sql` whenever a function changes — the regeneration query is in its
own header.

## Rules learned the hard way — do not rediscover these

### Data integrity

- **Anything that writes a shared array re-reads it first.** Writing an array
  back from a component's snapshot has lost records four times. Every writer in
  the app and the functions now re-reads (24 Oct review). The tools, in
  `App.jsx` near the top:
  - `sbGetStrict(key)` — the read a write depends on. **Throws** on a failed
    read (`sbGet` returns null for both "missing" and "failed", which is how an
    empty list got written over a real one).
  - `sbSet` **throws** on failure, and refuses (throws, with the red banner)
    when the tab is a stale build or the key is holding example data
    (`SEED_FALLBACK`). Never wrap it in a catch that carries on as if saved —
    rethrow, or tell the person.
  - `useMergedSave(key, value, setValue[, "object"])` — the way a screen saves
    a shared list. Applies only this screen's difference (`mergeById` /
    `mergeByKey`) to a fresh read, saves of one key run one at a time
    (`queueSave`), rolls the screen back on failure and rethrows. **Pass an
    updater (`prev => next`) whenever the list is built after an await** — a
    list from a closure taken before the await has no record added meanwhile,
    and the merge reads that as a delete. `saveArrayMerged` is the same without
    the hook.
  - `mutateBookings(mutator, onWritten)` — events. Queued per key too.
  - The event form writes only the fields it changed (`mergeFormFields`
    against `formBasesRef[formKey]`). Pass the **form key** to
    `saveBookingRecord` / `createBookingRecord`, never a base: the base is read
    and moved inside the save queue, or two overlapping autosaves drop a field
    set back. Top-level fields only — editing one payment rewrites the schedule.
- **Check `res.ok` before believing anything.** Four silent-failure incidents,
  all the same shape: an unchecked response treated as valid data. The worst
  replaced 42 real weddings on screen with built-in seed data and would have
  overwritten them on save.
- **Free text is never parsed as money.** Reading a number out of the corkage
  note turned "£9 per adult · 100 guests" into £9,100.

### Database

- RLS is on everywhere. The `wp_` and `box_` tables have **no policies** —
  every read and write goes through a `SECURITY DEFINER` function; add
  functions, not policies. The exceptions: 4 policies on public tables
  (among them `app_data_staff` and the public terms policy on `app_data`) and 4 storage
  policies on `booking-files`, which require `is_staff()` from migration
  `2026-10-24i`. Table privileges for anon/authenticated were trimmed there too.
- **Admin-only portal functions check `wp_is_admin()`**, not `is_staff()`
  (bar and cleaner logins are staff). Granting/revoking portal access, the
  invoice mirror and the drinks and bar money functions are admin only.
- **Never paste a live function body back from a copy you did not read out of
  the catalogue in the same breath.** Read it with `pg_get_functiondef()`, apply
  a string patch, assert the anchor appears exactly once, raise otherwise. A
  copy that came through a chat window silently lost 24 characters of
  whitespace.
- Pin existing behaviour with assertions that pass **before and after** the
  change. That is the point of them.
- **Supabase grants EXECUTE on every new function in `public` to `anon` AND
  `authenticated`** via ALTER DEFAULT PRIVILEGES. The default is open, not
  closed, and revoking from `PUBLIC` is not enough — `authenticated` holds its
  own explicit grant and must be revoked by name. Every new function: revoke
  from public, anon and authenticated, then grant back only where wanted. This
  was found the hard way in the portal phase 00 migration, where it left an
  internal logging helper callable by any signed-in client.
- **No client-facing function takes an id that selects whose data it returns.**
  The portal resolves the event from the signed-in user (`wp_my_event_id()`).
  If a caller can name the record, they can name somebody else's.
- **Payloads to non-staff are built as an allowlist, field by field** — never
  the whole record minus a few fields. A column added later must not leak by
  default. See `wp_my_event()`.

### React

- **Components that render inputs live at module scope.** A component defined
  inside another is a new type on every render, so React rebuilds its DOM —
  destroying focus and throwing away every row of a list. Two bugs and one
  performance problem so far.

### Mobile

- One global stylesheet, not per-component media queries — the app is
  inline-styled, so attribute selectors are the only practical lever. Collapsed
  grid tracks must be `minmax(0, 1fr)`. Any flex row that must not wrap has to
  say `nowrap`, because the stylesheet forces wrap onto every row that does not.
  Column flex containers are exempt from that rule (a wrapped column inside a
  height-limited modal sends its body off-screen); keep it that way.

### Layout (sidebar redesign, 22 Oct 2026)

- Two layouts, chosen per browser by `localStorage.hbf_ui_classic`: the
  sidebar layout (default) and the classic top menu. `T` is `T_NEW` or
  `T_CLASSIC`. The last commit before the redesign is `2866c5a`.
- **Colours go through `T`.** Never hard-code a hex for chrome. But a colour
  that is **data** — a property's `colour`, an event type's colour, anything
  saved to the database or used as a key — stays a literal: Hamlet is blue in
  the stored records, whatever the theme.
- Every page opens with `<PageHeader title sub actions back onBack/>`; every
  tab row on a page is `<TabStrip tabs value onChange/>`.
- Lettings, Box Office, Bar and Viewings keep their sub-page in `useNavTab()`
  (a small module store), not `useState`, so the sidebar can show and change
  it. Side effects of a sidebar click go in `useNavTab`'s second argument,
  which runs **inside the click** — an effect afterwards is one render too
  late (it let Bar mount a "new stocktake" holding the order being edited).
- Sections hide their own tab strip when `useContext(SidebarNavContext)` is
  true (sidebar layout, desktop). Phones and the bar/cleaner logins still show it.
- Sticky panels inside a page use `top: var(--hb-sticky-top, 0px)` so they sit
  under the sidebar layout's top bar and at 0 everywhere else.

### Phone app (23 Oct 2026)

- The staff app and the client portal are installable web apps (Add to Home
  Screen on iPhone, Install on Android): `public/app.webmanifest` (scope `/`)
  and `public/portal.webmanifest` (scope `/portal`, shown as "Our wedding"),
  icons in `public/icons/`. Both pass Chrome's installability check.
- **There is deliberately no service worker.** An offline cache would let an
  installed phone keep running an old build, which is exactly what the
  stale-build guard exists to stop. If push notifications are ever wanted, add
  a worker with no fetch handler — never one that caches the app shell.
- On iPhone, links in emails open in Safari, not in the installed app, so every
  sign-in and invite email also carries the one-use code (`email_otp` from
  `generate_link`); the portal's sign-in page takes it ("Sign in with the
  code", `verifyOtp` type `email`, falling back to `magiclink`). Using either
  spends both. Like the link, the code is a credential: never logged.

### Client portal (23 Oct 2026)

- **Money is held inc VAT everywhere** — drinks, add-ons, food, settings. Ex VAT
  is for marketing copy only. VAT is worked out (never typed) when it is needed,
  e.g. for Xero, which is sent `LineAmountTypes: "Inclusive"`.
- **First-read seeding takes a per-event advisory lock**
  (`pg_advisory_xact_lock(hashtext('wp_seed_…'), event)`). Without it two first
  reads at once both seed — React's dev mode calls every effect twice, which is
  how a replica wedding got 18 checklist items. Any new "seed on first read"
  function must do the same.
- **Which tabs an event shows** is data: a standard set per event type
  (`wp_section_defaults`) plus per-event ticks (`wp_event_sections`). Hiding is
  presentation, not permission.
- **Drinks arithmetic lives in ONE place**, `wp_drinks_summary()`. The client
  tab, the staff panel and the Xero invoice lines all read it.
- The drinks order **locks** N days before (a setting) and staff can unlock —
  a deliberate exception to "warn, never refuse", because the invoice is made
  from it.
- **No bank details are collected.** Money behind the bar is paid by card via a
  Stripe Payment Link (with `client_reference_id=event-<id>`); unused money is
  refunded to that card from Stripe.
- The portal falls back to its old tab list if `wp_get_home` is missing, so the
  front end can go out before the migration without breaking anybody.
- **Client uploads never pass through a function.** `portal-upload.js` asks the
  database AS THE USER (`wp_upload_slot`), which picks the path
  (`<event_id>/<uuid>.<ext>`); then signs a one-use upload token for that path
  only. The browser sends the file straight to the private `portal-uploads`
  bucket, and a row only becomes `ready` after the function has checked the
  object exists. Netlify functions take 6MB; films are hundreds.
- A function run with the service key has no signed-in person, so
  `wp_log()` (which finds the event from the caller) logs nothing there. Write
  the change-log row directly, as `wp_upload_confirm` does.
- A portal section can be switched on by a confirmed add-on (`wp_addons.unlocks`,
  e.g. the webcast). A per-event tick still overrides it.
- **The evening bar is its own section, `bar`** (23 Oct, migration c), separate
  from Drinks (packages and corkage, weddings only). Drinks is off as standard
  for every type but Wedding. The client ticks "we would like a pay bar" and
  says how busy they expect it (`wp_drinks.pay_bar`, `bar_usage`); there is no
  Save button — each control saves itself through `wp_save_bar_prefs`, where
  NULL leaves a field alone. Money behind the bar is "Add now" to the Stripe
  Payment Link; the page shows only what staff have recorded as received.
- **A new section key needs the front end first.** The portal draws a menu
  entry for every visible section by name; an older bundle with no name for a
  new key throws. Push, let Netlify deploy, then apply the migration. (From
  this build on, the portal skips keys it does not know, so the next one is safe
  either way round.)
- The portal menu is a left-hand column (`.side`) that folds into one button
  under 820px. The old single row of tabs ran off its box with no scrollbar.
- Each event's portal logins and drinks are on the event form itself (the
  "Drinks & bar" and "Client portal" sections). Events → Portal settings holds
  what every event starts with; its "By event" tab lists coming events first
  and hides past ones.

- **Guest numbers and suppliers come from the portal** (23 Oct, migration d).
  The event form's Guests and "Suppliers & the day" sections read
  `wp_admin_guests` (admin only — guests' dietary notes), `wp_admin_numbers`
  (any staff), `wp_admin_event_suppliers` and `wp_admin_event_timeline`;
  staff set numbers with `wp_admin_set_numbers`. The diary's old fields
  (mealGuests, caterers, band…) are left in the record, never written, and
  shown read-only as "Notes from before the portal". The events list and the
  calendar feed use portal numbers and fall back to the old fields.
- **Money behind the bar records itself** (23 Oct, migration f). The client
  types an amount; `bar-checkout.js` asks `wp_bar_payment_start` AS THE USER,
  makes a Checkout session for exactly that amount on the TICKETING Stripe
  account (`metadata.bookingType = "bar_tab"`), and attaches it. The ticket
  webhook's `handleBarTab` calls `wp_bar_payment_paid`, which checks session
  AND amount and reports `first_time`, so a retried delivery never emails twice;
  then it emails the client (wording from the portal email templates) and the
  office. Unmatched money emails the office. **Refunds record themselves too**
  (migration h): staff refund in the Stripe dashboard, `charge.refunded` on the
  ticketing account calls `wp_bar_payment_refunded(payment_intent, cumulative
  refunded)`, which stores the cumulative figure (so retries change nothing)
  and the client and office are emailed (template `bar_refund`). Every
  `charge.refunded` on the platform account stops at that handler — a charge
  is not a checkout session and must never reach the ticket code below it. `wp_drinks.bar_paid_amount` is the
  recomputed total of paid rows. The old Payment Link setting is unused once
  migration f is in; staff can add a payment "taken another way".
- **Portal emails are editable** under Settings → Email templates → Client
  portal (`app_data` `hbf_portal_email_templates_v1`). `portal-auth.js` and the
  webhook read it with the service key and fall back, field by field, to the
  standard wording. The sign-in link is only ever the button, never the text.
- Settings has its own pages: General, Staff, Activity (with More), Email
  templates (Lettings, Client portal, Box office, Brochure request — the same
  editors that live in each section, on the same stored keys).

### Money, the day and follow-ups (23 Oct 2026, evening)

- **Damage deposit** on an event (`damageDeposit`, `damageDepositState`,
  `damageDepositKept`) is refundable: never on an invoice stage, shown on the
  couple's statement as refundable, and only an amount KEPT reaches the VAT
  split (outside the scope).
- **VAT split** (`eventVatSplit`) is worked out from the venue fee, linked
  accommodation and the portal's drinks, food and confirmed extras, plus
  `vatAdjustments` (inc VAT, either sign — `signedAmount`, because
  `parseMoney` drops the minus). Rates are standard-rate assumptions.
- **Statement of account**: the staff app publishes each event's payments
  still to come (`eventStatementRows`) to `wp_payment_schedule` through
  `wp_admin_publish_schedule` (admin only). It never publishes from example
  data or after a failed START-UP read (`startupReadFailedRef` in App — not the
  shared `READ_FAILED`, which another screen's later read clears). Cancelled
  events are sent with no rows so they clear. The portal labels every figure
  provisional.
- **Function sheet** (`functionSheetHtml`, Actions → Function sheet) escapes
  every value with `fsEsc`; it is written into a new window.
- **Follow-ups** (`netlify/functions/automations.js`, run at 09:00 and 09:20
  UTC by `automations-cron.js`): three enquiry emails — **first** (N+ days
  after it arrives, no contact since, **however old** — 28 Oct, Toby: switching
  it on catches the whole backlog, which `MAX_SENDS_PER_RUN` (15) and the
  Gmail-check cap spread over a few mornings), **second** (only after the
  first, N days after it went, or after their last activity if later),
  **third** (only after the second, likewise) — a chain, no age windows any
  more; each off until switched on in Settings → Email templates →
  Follow-ups, each once, one email per address per run. The enquiry's
  **"Suppress automatic emails"** tick (`noAutoEmails`) stops all three. The thank-you/review email is gone (28 Oct).
  The second and third each have **"Then mark Freezing"** after X quiet days:
  the run sets that enquiry's `temperature` to `freezing` (+ `autoFrozenAt`,
  `autoFrozenAfter`) — its ONE write to the shared enquiries array, on a
  fresh read, PATCHed only if `updated_at` is unchanged, re-planned on a clash
  (`freezeEnquiries`). Once per enquiry (`frozen` in the sent record): warmed
  up by hand, it stays warm. A Freezing enquiry is never emailed. What was
  sent lives in `hbf_automation_sent_v1` (`followup`, `second`, `third`,
  `frozen`), written ONLY by the function, marked BEFORE sending (a cut-off run
  can miss someone, never email twice). It and `hbf_automations_v1` are
  deliberately NOT restorable from a backup — restoring the sent record would
  re-send. Addresses with a live event, sombre event types (wake, funeral,
  memorial, celebration of life — second and third only) and duplicate
  addresses are left out.
  **Email is checked by the run itself in the farm Gmail**
  (hawthbushfarm@gmail.com, the Airbnb-mail connection's sealed refresh token
  in `airbnb_mail_state`): a first plan on the app's cache
  (`hbf_enquiry_email_seen_v1`) picks the addresses that matter today, Gmail is
  asked for the newest message from/to/cc each (`lastEmailWith`, at most 40,
  stopping at 4s), merged over the cache (`mergeSeen`), and the plan is made
  again. If the farm Gmail cannot be reached it falls back to the cache. Quiet
  days count only up to the last Gmail check of that address, never past it;
  never checked = never followed up. The contact log (every note there is
  dated) is activity. Sending stops at 7.5s and anything unsent is unmarked
  for the 09:20 run — Netlify's 10-second limit. The preview lists what would
  go, what would be frozen, and which Gmail was used. Tests:
  `tests/automations-test.cjs` (rules), `tests/automations-run-test.cjs` (the
  whole run, faked at fetch), `money-and-day-test.cjs` (app and function
  defaults agree).
- **Web addresses in emails become links with or without `https://`**
  (`linkifyEscaped` / `LINK_RE`, copied into every function that builds an
  email body — `_email-shell.js` is the master copy). Bare domains need a
  known ending (.co.uk, .com, .org, .net, .uk, .org.uk, .events); email
  addresses are never linked; trailing punctuation stays outside the link.
  Pinned in `tests/automations-test.cjs`. Every branded email already has
  the logo at the top (`email-logo.png`).
- **`sbRpcQuiet`** is `sbRpc` without the red banner, for optional reads and
  for functions a migration may not have created yet. Portal pages use
  `isMissingFunction(e)` the same way.

### Product

- **Double bookings warn, never block.** Every override takes a second press.
- **Money received confirms a pending booking**, by whatever route it arrives,
  and only ever promotes *from* pending.
- Two Stripe accounts, settling separately: ticketing `acct_1DeKnBKCwZHyDyxr`,
  lettings `acct_1Pyd6CBQuJjvSXJo`. Do not cross them.
- Everything is Europe/London. There is no timezone handling and that is
  deliberate.

### Diagnosis

- **Diagnose from the data, not the code.** The Supabase MCP tools read
  production. Booking W15032 took two SQL queries to explain exactly; reasoning
  from the code alone pointed confidently at the wrong cause.

## Known weak spots

- `netlify/functions/xero-proxy.js` forwards **any** GET path to Xero with a
  token supplied by the caller, under `Access-Control-Allow-Origin: *`, with no
  authorisation check. `xero-invoice.js` likewise checks nothing about who is
  calling, and `/api/xero-api/*` in `netlify.toml` is a bare redirect straight to
  `api.xero.com` — there is no server-side layer there at all. The Xero access
  token lives in the browser's `sessionStorage`. Workable while only staff can
  sign in; it must not be extended to any client-facing feature. See
  `claude/scope-client-portal.md`.
- The portal's Supabase client needs `detectSessionInUrl: true` (a magic link
  arrives in the URL fragment) and its **own `storageKey`** — the staff app and
  the portal share an origin, so on the default key signing into one silently
  signs you out of the other.
- `role` is enforced **only in the browser**. No database function checks it;
  authorisation is execute grants plus the `app_data` RLS policy. Portal
  functions therefore do their own gating (`is_staff()`) rather than assuming a
  caller was filtered upstream.
- **Sign-in links are minted and sent by us**, in `netlify/functions/portal-auth.js`,
  never by Supabase's mailer — which is unbranded, heavily rate-limited and
  spam-prone. Two consequences that are easy to forget:
  - **The link points at us, not at Supabase.** `generate_link` hands back an
    `action_link` that verifies the token and then redirects — but only to a URL
    on the project's redirect allowlist, silently falling back to the Site URL
    otherwise. The first invite ever sent went to `localhost` that way, and
    spent its one-use token getting there. So we send `/portal#t=<hashed_token>`
    and the page calls `verifyOtp` itself. **Do not "simplify" this back to
    `action_link`** — it reintroduces a dashboard setting that can break every
    sign-in link without a word.
  - The token is taken out of the address bar at module scope, before React
    renders, and the exchange is a single module-scope promise so React 18's
    double-invoked effects cannot spend a one-use token twice.
  - The link is a **credential**. It is never written to `hbf_email_log_v1`;
    the log is readable by every member of staff.
- **Checksumming a migration against the catalogue: compare the BODY, not
  `pg_get_functiondef`, for any function with parameters.** Postgres prints
  `p_id uuid DEFAULT NULL::uuid` where a file says `p_id uuid default null`, so
  a faithful ten-parameter function reads 80 characters longer in the catalogue
  and looks like drift. Use `md5(trim(regexp_replace(prosrc,'\s+',' ','g')))`
  plus `pg_get_function_arguments()` separately. `pg_get_functiondef` is still
  the right comparison for a zero-argument function.
- **Adding a parameter to a function creates an OVERLOAD, not a replacement.**
  If every argument has a default, two overloads make every call ambiguous and
  PostgREST starts failing on a function that looks fine in the catalogue. Drop
  the old signature explicitly — and remember the new one is a *new* function,
  so its grants need revoking from `anon` and `authenticated` again.
- **A database function that records something does not tell anyone about it.**
  `wp_grant_access` writes the access row and nothing more, which is how the
  portal shipped with an invite screen that sent no invite: an address was
  added, no email arrived, and Recent Automated Emails showed nothing either.
  When a write is meant to reach a person, the sending is a second, separate
  step — and it is reported separately, so "the row landed but the email did
  not" never reads as outright failure and prompt a duplicate grant.

### Build guard and deploys (24 Oct 2026)

- **Bump `APP_BUILD` in `App.jsx` on every deploy** ("YYYY-MM-DD" + letter).
  `vite.config.js` copies it into `dist/build.json`; open tabs poll that file
  and a tab whose build is not the one deployed refuses every write (inside
  `sbSet`), older or newer — so a Netlify rollback works. The database key
  `hbf_app_build_v1` is still written, only for tabs of builds before
  2026-10-24b. Rolling back to a build older than that would leave those tabs
  refusing saves until the key is set back by hand.
- Netlify env vars added in this round: `CALENDAR_FEED_TOKEN` (the calendar
  feed shows contact details only with `?t=<token>`), and `HBF_ADMIN_TOKEN` is
  required. Staff-only functions check the caller's Supabase session
  (`resolveStaff`); the app sends `sbAuthHeaders()` to them.
- `send-cleaning-summary-cron.js` is the schedule shim (Netlify returns 403 to
  HTTP calls on a scheduled function), like `brevo-sync-cron`.
- Lettings webhook: a payment that matches no schedule row, or lands on a row
  already paid by a different Stripe payment, is set aside on the booking as
  `unmatchedPayments[]` and the office is emailed; the guest is not. The app
  does not show that list yet. Accommodation checkout sessions expire after an
  hour, and the server enforces the page's stay rules as well as its price.

### Portal tidy-up (24 Oct 2026, migrations j and k)

- **Bespoke packages are written by staff, per event.** Drinks: `wp_drinks.bespoke_name`,
  `bespoke_note`, `bespoke_pp` (per adult, through `wp_drinks_summary`); the client only
  sees a bespoke option once one is written (`bespoke_offered`), and `wp_set_drinks_route`
  refuses it otherwise. Food: `wp_food_packages.event_id` — a menu only that event sees.
  The settings list and its save leave event menus alone (`event_id is null`).
- **Details questions can live on another page** (`wp_venue_form_questions.in_form`):
  drop-off and collection are saved from Bringing and not drawn on Details. The admin
  form editor deletes and re-inserts every question, so it carries `in_form` across by key.
- `photos` is a section of LINKS (`wp_media_links`); `uploads` (files) is labelled Uploads.
- A timeline line can name a key contact (`contact_id`) as well as a supplier.
  `wp_set_block_who` SETS both — `wp_update_block` can only ever add a supplier (coalesce).
- Checklist items can fall on a fixed day each year (`due_md` "MM-DD", the last one before
  the event — `wp_fixed_due`). Interim payment is 15 January.
- The evening bar links to a menu (`wp_drinks_settings.bar_menu_url`); the example price
  list is emptied.

### Guest import, reminders, the board (25 Oct 2026, migrations m and n)

- **Re-importing a guest list never doubles it.** `wp_merge_guests(list, rows,
  apply)` matches by name across both lists (duplicates paired in order),
  updates the reply when the file gives one, adds notes VALUE BY VALUE
  (`notes_parts`: one already there is not repeated, a meal choice replaces the
  one under the same heading, nothing is ever cut to fit — an overflow is
  reported), fills side/role only where empty, changes age only when the cell
  plainly says adult/child/baby (`explicitAge`), adds new names unless they are
  not coming, and reports people missing from the file and duplicate names
  without removing anything. `apply = false` is the preview. `rsvp` is null
  whenever the file does not say, and null never overwrites. The portal falls back to the
  old add-only `wp_import_guests` while m is missing.
- **Weekly deadline reminder** (`portal-nudges.js`, hourly 08:00–11:00 UTC on
  Mondays — later runs pick up only what did not go; a run stops sending after
  7s — OFF until ticked on the "nudge" portal email template). Confirmed
  bookings only. Payments are listed only when due in the next three weeks,
  never as overdue: `wp_payment_schedule` does not record payment, so a past
  date on it means "not republished", not "unpaid". What goes in it is
  `wp_nudge_plan(today)`; one email per event per week, marked in
  `wp_nudges_sent` BEFORE sending (`wp_nudge_mark` refuses a taken week;
  `wp_nudge_unmark` frees it after a failed send — no DELETE). Links to
  `/portal`, never a sign-in link. Sombre event types are left out.
- **Who's behind** (Events → Portal settings, first tab): `wp_admin_portal_progress()`
  (admin only); the red/amber rules are `portalProgressFlags` in App.jsx, pinned
  by `tests/portal-progress-test.cjs`.
- **`wp_visible_sections` delegates to `wp_visible_sections_typed(event, type)`**
  — one rule, but a caller handling many events looks the type up once (the
  board went from 5s to 0.5s). Change visibility in the typed function.
- **Portal UI tests run the BUILT app with Supabase faked**:
  `tests/portal-harness.cjs` (`openPortal`, `openStaff`, `goTab`). Build to
  `$HOME/dist-check` first. RPCs with no handler answer PGRST202, exactly what
  a page meets when it ships before its migration.

### Suppliers and links (25 Oct 2026, migration o)

- **A couple's supplier is private until approved.** `owner_event_id` set =
  that wedding's alone; `wp_get_suppliers` shows other couples only rows with
  no owner. Events → Portal settings → Supplier directory lists every couple's
  supplier; staff correct the category and write the blurb there
  (`wp_admin_review_supplier` — never name or contact, those are the
  couple's), then tick **Approved for sharing** (`wp_admin_approve_supplier`),
  which moves the row into the directory and keeps `promoted_from_event_id`.
  Unticking gives it back to the couple if nobody else chose it, otherwise
  sets `active = false` (kept by those who chose it, offered to nobody new).
  Admin only (`wp_is_admin`). Test: `supabase/2026-10-25o-supplier-approval-test.sql`.
- The venue's own directory rows have Edit (upsert for name/contact,
  `wp_admin_review_supplier` for the line, note and insurance so they can be
  cleared), Suppress (kept, never offered) and Delete
  (`wp_admin_delete_supplier`, migration p): refused while any wedding has
  chosen them or a timeline names them, because the foreign keys would
  otherwise cascade them off couples' pages or blank the timeline line.
- **Rows open their record.** Deep links: `goToEvent`, `goToEnquiry`,
  `goToAccomBooking`, `goToBoxEvent` (box office editor), `goToViewingRequest`
  (Viewings, card scrolled to and picked out). A new list of records should
  use one of these, never `setView(section)`. Pinned by
  `tests/record-links-e2e.cjs`.

### Airbnb emails (25 Oct 2026, migration q)

- **`netlify/functions/airbnb-mail/`** reads the Airbnb emails in Toby's personal
  Gmail (`gmail.readonly`, connected once in Lettings → Settings → Airbnb Sync)
  and puts them on Airbnb lettings bookings. `parse.js` is pure (parser +
  `planBookingPatches`), pinned by `tests/airbnb-mail-test.cjs`; the worker is
  pinned by `tests/airbnb-mail-worker-test.cjs`, the screens by
  `tests/airbnb-booking-e2e.cjs`. Hourly via `airbnb-mail-cron.js` at :25 (the
  iCal sync writes the same array on the hour).
- **Host side only.** Toby's own trips reach the same inbox: an email counts only
  with a link into `airbnb.*/hosting/`, a HOST review template, or a cancellation
  naming one of our listings (`Listing #<room>`, rooms read off each property's
  iCal import link) or a `_TO_HOST` template. Money only from the `YOU EARN`
  line under `HOST PAYOUT`, or a payout email's per-reservation line.
- **The booking's value becomes Airbnb's payout after fees** (Toby's choice) —
  the sent payout once paid, `YOU EARN` until then. A field is written only where
  it holds an estimate / placeholder / 0, or still holds what the sync put there
  (`airbnb.appliedValue`, `appliedName`, `appliedCount`); a typed figure is left
  and the panel shows Airbnb's beside it. Lettings turnover is therefore net of
  Airbnb's host fee.
- **What the sync and the iCal sync record is theirs:** the lettings form's save
  keeps `airbnb` and `airbnbMissingSince` from the fresh server copy. The worker
  writes `hbf_accom_v1` only if `app_data.updated_at` is unchanged since its read
  (PATCH with `updated_at=eq.`), re-planning on a clash; every writer of that key
  must move `updated_at` (the app's `sbSet` and `sync-all-icals` do).
- **Cancellations are never acted on.** `airbnb.cancelledAt` (from the email) and
  `airbnbMissingSince` (sync-all-icals: a booking not yet started that has left a
  complete feed) raise a prompt — Mark cancelled / Delete / It's not cancelled.
- The refresh token is AES-GCM sealed with a key derived from `HBF_ADMIN_TOKEN`
  in `airbnb_mail_state` (service role only). Rotating `HBF_ADMIN_TOKEN` means
  connecting Gmail again. Env: `GOOGLE_CLIENT_SECRET` (same OAuth client as the
  app's Gmail button); redirect URI
  `https://hawthbushfarm.netlify.app/.netlify/functions/airbnb-mail`.
- The first read walks back to 1 Jan 2026 one Gmail page per run
  (`backfill_page`); only bookings ending in 2026 or later are changed.
  Gmail allows ~250 units/s per mailbox (a read costs 5): three reads at a
  time, paced. A 429 / "Quota exceeded" stops the run as `throttled` (not
  failed, the walk not restarted); Sync now waits a minute and carries on.
  Enquiry threads with no booking are purged after 30 quiet days, only once the
  first read is done. Messages sent from the Airbnb app are never emailed, so
  only emailed replies and the co-host's appear.
- **One mailbox to another (migration r).** Airbnb emails are forwarded from
  Toby's Gmail to hawthbushfarm@gmail.com; the history was read from his, the
  future from the farm's. The same email can be read from both, so a payout is
  unique by Airbnb's payout ID + code (`payout_id`), and a message is skipped when
  the same author said the same words on the same thread within two days. A
  forwarded copy may lose the `X-Template` header: nothing may depend on it alone.

### Housekeeping changeovers (28 Oct 2026)

- **The cleaners sign off every check-out and every confirmed event** — diary
  events and box office (ticketed) events alike — on the housekeeping login:
  Live / Upcoming / Calendar / Bookings / House, plus an App button by Sign out.
  State is worked out from dates;
  only the sign-off is stored, in `app_data` `hbf_changeovers_v1` (array, by id,
  saved with `useMergedSave` — the cleaner login writes nothing else).
- Ids: `accom:<bookingId>:<propertyId>` (`:2` for a second stay at the same
  property), `event:<eventId>`, `box:<box_events.id>` — never the dates, so
  moving a stay keeps its sign-off. Record: `doneAt` (UK wall-clock
  `YYYY-MM-DDTHH:MM`, editable), `hours.edita` / `hours.karina`
  (`CHANGEOVER_CLEANERS`), `comments`, `lostProperty`, and `who` / `unitName`
  so it still reads if the booking goes.
- The lozenge shows the state, in Toby's words: Not yet (grey, inert) before
  the stay starts, Guests (yellow) while in use, To clean (red) from the
  check-out day (events: the day after the last day), Ready (green, reopens to
  edit). All four come from `changeoverMeta`. Holding events get none.
  Nothing before `CHANGEOVER_FROM` (Mon 5 Oct 2026 — moved back from
  24 Oct so the weeks after the first week of October are signed off) is ever red.
- **Box office events reach housekeeping through `box-admin`'s
  `housekeeping.events`** — the only action a cleaner login may call
  (`HOUSEKEEPING_ACTIONS`): name, start, end, venue; drafts left out. The admin
  lettings calendar uses it too (ids `box:<uuid>`, opening the box office).
- Bookings (housekeeping) is one list of stays and Grain Store events, one card
  per thing to clean, filtered by property buttons; no money on it. Every row
  that must keep its lozenge on the line is a `flexWrap:"nowrap"` flex row —
  never a grid, which the phone stylesheet folds into one column.
- `UnitStatusBar`: one line of small coloured pills — short names (Hamlet,
  Amly, Glamping, Grain St.) and the state colour, nothing else — on the admin
  home and on Live (`role="group"`, `aria-label="Property status"`); fits a
  375px phone. A pill opens its booking or event. `ChangeoverRecordPanel` shows the
  sign-off on the letting and event forms; the lettings list has a
  lost-property chip. Reports → Housekeeping Hours sits above Hours Worked,
  which stays last.
- **Upcoming** (`changeoverWindows`): four Monday-to-Sunday weeks a page, each
  changeover listed in order showing the stay or event's own dates (`occ`, the
  same "Mon 2 Nov 26 – Wed 4 Nov 26" as Bookings) — Toby found the cleaning
  window confusing, so it is not shown. The window (check-out + 2h to the next
  check-in − 2h, `CHANGEOVER_GRACE_MIN`) is still worked out, to decide the
  week. A window belongs to the week it opens in — except one opening
  on a Sunday, which is the next week's clean unless the next guests arrive
  that same Sunday (`changeoverWeekOf`).
- **Setup cleans** (`setupCleanItems`): a "Setup clean" tick box on the letting
  form, the event form and the box office event editor (`SetupCleanToggle`,
  saved to its own key `hbf_setup_cleans_v1` — `{ id: "setup:<kind>:<refId>" }` —
  so no booking save path and no box office column is involved). Window: from
  when the place was last left (`unitUsages`) if within `SETUP_CLEAN_LEAD_DAYS`
  (7), else a week before; to check-in − 2h / the event's start. Sign-off id
  `setup:<kind>:<refId>:<unit>`, kind `setup`, `setupOf` the record's kind. Red
  from the day the window opens; once the stay or event has begun it no longer
  turns the tile red. Draft box office events are not in housekeeping, so their
  setup clean waits until published. Shown to everyone as **"Extra clean before
  arrival"** (lettings) / "Extra clean before the event" — a bare tick box, no
  explanation (Toby, 28 Oct). New jobs say `who: "Extra clean · …"`; older
  sign-offs say `"Setup · …"`, so strip both (`/^(Setup|Extra clean) · /`).
  **"No exit clean needed"** (reinstated by Toby, 28 Oct) is the tick beside
  it on all three forms: `{ id: "noexit:<kind>:<refId>", kind: "noexit", of,
  refId }` in the same key. `noExitClean(setups, jobId)` drops that record's
  clean afterwards from `changeoverJobs` (after arrival notes are placed — a
  note that lands on it shows only on the check-in row) and from
  `changeoverWindows`; Live and Bookings show "No exit clean" where the
  lozenge was, and the day card's "Changeover:" leaves it out.
- **Notes to housekeepers** (28 Oct): a textarea on the letting form under the
  tick box, saved on blur into the SAME key as
  `{ id: "note:accom:<refId>", kind: "note", of, refId, text }` (empty text
  removes it). The kind is deliberately not accom/event/box, so builds before
  it ignore the row; `setupCleanItems` only reads ids starting `setup:`.
  **A note is about the guests ARRIVING** (Toby): it goes on their extra clean
  if one is ticked, otherwise on the previous check-out at the same property
  (`attachArrivalNotes`, called in `changeoverJobs`) — never on the letting's
  own check-out — worded "For <guests>, arriving <day>: …"
  (`hkNoteForArrival`), and on their check-in row on Live. No earlier
  booking at that property = only the check-in row. It shows on Live (incl.
  Still to sign off) and Bookings cards (`HkNoteLine`) and in a red box at
  the top of the sign-off, which refuses to save until "I have read this" is
  ticked. The tick is stored on
  the sign-off as `noteAck: { text, at }`; a later change to the note asks
  again. **Events have notes too** (28 Oct): the event form's housekeeping
  box (extra clean, no exit clean, notes) sits on **Event Details**, not
  above every section. An event's note goes on its extra clean if ticked,
  else on the Grain Store's clean before it (`attachArrivalNotes`, events
  and box office), worded "For <event>, on <day>: …" (`hkNoteForEvent`),
  and on the event's own row on Live — never on its own clean after. The
  box office editor writes ticks only.
  **The sign-off pop-up shows both** (28 Oct, Toby): "Notes from previous
  let" (the note written on the let or event this clean comes after —
  `job.prevNote`) and "Notes for next let" (the arrival notes above —
  `job.note`); "event" for the Grain Store (`changeoverNoteWord`). One tick
  covers both; `noteAck.text` is `changeoverAckText(prev, next)` — just the
  next note when there is no previous one, so older acknowledgements hold.
- **Deleting an event retires its housekeeping** (`retireEventHousekeeping`,
  28 Oct review): event ids are reused (highest + 1), so its `setup:` /
  `noexit:` / `note:event:<id>` rows are removed, and its sign-offs (and the
  office's read marks for them) move to `<id>#deleted-<date>` with
  `eventDeleted: true` — kept for the pay sheet, out of reach of the next
  event. Deleting from the event form now asks once (the form's dialog) and
  leaves the form BEFORE deleting: a second "are you sure" used to open behind
  the first, and an open form's autosave writes a deleted event back.
- **Admin Home → "From housekeeping"** (28 Oct): every sign-off with comments
  or lost property, newest first, until someone presses **Read**. What was
  read is stored in its own key `hbf_changeover_seen_v1` (`{ id: <sign-off id>,
  comments, lostProperty, at }`) — the cleaners' records are never written
  from the office (bar retiring a deleted event's, above). A sign-off whose comments or lost property change later
  comes back. Read with `sbGetStrict`; if that read fails the panel is hidden
  rather than listing everything.
- **The House** (28 Oct): Karina also cleans Toby's own house, paid by the
  hour. The housekeeping **House** tab (it replaced Hours) is her Mon–Fri
  timesheet (`hbf_house_hours_v1`, one record a week, id `karina:<monday>`):
  last two weeks, this week, next two; grey future (cannot open), yellow this
  week up to Friday, red after Friday until submitted, green once submitted.
  Weekends never. A week the office has marked paid is read-only to her.
  Every unsubmitted week from `HOUSE_FROM` (Mon 5 Oct 2026, 2641 — Toby has
  her hours to 2640) stays listed, red, until submitted.
- **Weeks are coded YYWW from the ISO week** (`isoWeekCode`): 2601 is the week
  of Mon 29 Dec 2025; 2026 has a week 2653.
- **Pay rates live on the staff record as a history** — `rates: [{ from, rate,
  holidayRollup }]`, numbers, each applying from its date (`staffRateOn`); the
  old free-text "Pay Rate" stays a note for the Hours Worked report and is
  never read for housekeeping pay. `employment`: "PAYE" (the default when
  missing) or "Self-employed". Role **Housekeeping** is left out of rota
  pickers. A cleaner key maps to the staff record with role Housekeeping and
  that first name (`housekeepingStaffFor`).
- **Reports → Housekeeping Hours is the weekly pay sheet**
  (`HousekeepingPayReport`, `housekeepingWeek`): per week, changeover hours by
  the day each was ready plus Karina's House hours, each priced at the rate on
  its day; Edita, Karina, total, a breakdown, and Paid + date
  (`hbf_housekeeping_pay_v1`, id = the Monday, amounts kept as paid so a later
  change shows against them). Karina's pay is House hours plus her changeover
  pop-up hours, by Toby's choice. Its three reads are strict: a failed read
  shows an error, never a short sheet that Paid could be ticked against.
- **Housekeeper's view** (admin menu, 28 Oct): view `"housekeeping"` renders
  the housekeeping login's own shell and `CleanerView` for an admin
  (`hkPreview`), with "← Back to admin" in place of Sign out and a note that
  sign-offs made there are real.
- **Past weeks' sign-offs are the office's** (28 Oct): Upcoming pages back
  as well as forward; a sign-off whose `doneAt` is before this week's Monday
  opens read-only on the housekeeping login (`changeoverLocked`, the
  dialog's `locked`) — no Save, no "Not done after all". The Housekeeper's
  view (`CleanerView isAdmin`) can change it. Unsigned past jobs stay
  signable by the housekeepers (Still to sign off).
- The housekeeping login stays signed in indefinitely (persisted session, no
  session time-box in Supabase); Sign out asks first, a stale build reloads
  itself when the app comes back to the front, and the App button (hidden once
  installed) opens the install pop-up
  (Android button via `useInstallPrompt`; iPhone steps). Test:
  `tests/changeover-e2e.cjs`.

### Email archive (28 Oct 2026, migration s)

- **Every email to and from the people on events, enquiries and lettings is
  kept in the database**, so nobody has to Connect Gmail to see it.
  `netlify/functions/email-archive/` reads the farm Gmail (the Airbnb-mail
  connection's sealed token in `airbnb_mail_state`, read only) at 10 and 40
  past (`email-archive-cron.js`). `parse.js` is pure, pinned by
  `tests/email-archive-test.cjs`; the run by `tests/email-archive-run-test.cjs`;
  the screens by `tests/email-archive-e2e.cjs`; the SQL by
  `supabase/2026-10-28s-email-archive-test.sql`.
- Tables (no policies, service role only): `email_messages` (one row per
  email: who, when, `direction` in/out/app, subject, the TEXT with the quoted
  history cut off, capped at 20,000 characters, and the LIST of real
  attachments `[{part, name, mime, size}]`), `email_archive_addresses` (record
  addresses already read back to 1 Jan 2025), `email_archive_seen` (recent
  Gmail ids that were nobody's), `email_archive_state`.
- A run: copies in the app's own emails from `hbf_email_log_v1` (which keeps
  only 500; id `app:<log id>`, direction `app`, `body_html` kept for those
  only); looks at what is new since two days before the last good run
  (From/To/Cc/Bcc only; read in full only if an address is on a record); then
  reads back each address not yet read back, eight at a time. Three Gmail reads
  at a time, paced; a 429 stops the run as `throttled`, nothing marked done
  that was not read. A new enquiry's earlier emails arrive this way.
- **One bad email must never jam a run** (28 Oct review). Postgres refuses a
  NUL anywhere in jsonb, so one row with `\u0000` failed the whole
  `email_ingest`, every run: UTF-16 parts are decoded as UTF-16
  (`decodeData`) and every row is `scrubDeep`ed. An email Gmail no longer has
  (404/400) or that cannot be parsed is noted as seen (`readOrSkip`), not
  failed — a failure is retried next run, so one that always fails held the
  read-back up for good.
- **Whose:** a record's addresses (events: email, email2, email3 and any in
  `invoiceEmails`; enquiries: email; lettings: email), never ours
  (`hawthbushfarm.co.uk`, `smallpeice.net`, the farm Gmail) and never a relay
  (Airbnb, Booking.com — the Airbnb reader has those).
- **Admins only.** `email_admin_messages(addresses, ref)` and
  `email_admin_status()` check `wp_is_admin()`; the function's attachment
  action checks the admin role. Anyone else sees only the app's own emails.
  Guest email text is only ever rendered as text, never as HTML.
- **Attachments are listed, not stored.** Signature logos are left out (an
  image under 50KB, or inline / Content-ID under 200KB; S/MIME and
  winmail.dat). "Save to files" calls `email-archive` `{action:"attachment",
  gmail_id, part, folder}`: only an attachment the archive lists, found again
  by PART number (Gmail's attachment ids change between reads), uploaded with
  the service key to `booking-files/<folder>/…`; the app then adds it to the
  record's `files` with `source` `email-in` / `email-out`, `gmailId`,
  `gmailPart`.
- **File flavours:** `source` on a file — `uploaded`, `contract`, `email-in`
  ("Email attachment from guest"), `email-out` ("… from Hawthbush"). Older
  files: SignWell = contract, else uploaded (`fileSource`). Delete takes a
  second press and saves the record BEFORE removing the stored file.
- Lettings now have a Files section; its saves write only `files`, on a fresh
  read (`patchAccom`). A new booking is saved before it can take files.
- **Retention:** daily, `email_purge(keep, before)` deletes emails older than
  two years unless anybody on them is on an event, a letting or an enquiry
  that booked (booking ids are on the keep list for the app's own emails). It
  refuses an empty keep list or anything under 700 days; the worker skips it
  if the events or lettings read came back empty.
- `RecordEmailsPanel` replaced the browser-Gmail `GmailThreadPanel` on events
  (Contact), enquiries and lettings, and the "Emails Sent" / "Viewing Emails
  Sent" lists there (box office orders keep `EmailHistoryPanel`). Stars still
  live in `hbf_starred_emails_v1` by Gmail thread id. Settings → Email archive
  shows progress and has Read now. The enquiries list's "last contact" still
  uses the browser Gmail cache; the follow-up run checks Gmail itself.

### Staff checklists (28 Oct 2026, migration t)

- **Short phone checklists that start on their own.** Templates
  (`chk_templates`: title, `trig` jsonb, `items` jsonb, `default_due_min`,
  `fire_from`), lists that have started (`chk_runs`, unique per template +
  `anchor_key`) and their items (`chk_run_items`, COPIED from the template when
  a list starts, one row each so phones never collide). RLS on, no policies,
  everything through `chk_` functions. SQL test:
  `supabase/2026-10-28t-checklists-test.sql`.
- **Triggers**: manual (Start now), once, weekly, monthly, letting check-in /
  check-out (any or one property), event (any, wedding, party, celebration of
  life, other, or **pay bar**), viewing, cleaned (a changeover sign-off, any
  property or the Grain Store). Source triggers have `offset_min` — when the
  list appears, before or after the anchor. **Every item's due time is an
  offset from the anchor** (Toby), not from when the list appeared.
- **Anchor keys never hold a movable date**: `in:<booking>:<property>[:n]`,
  `out:…`, `event:<id>`, `box:<uuid>`, `viewing:enq|evt:<id>:<day>[:n]`,
  `clean:<sign-off id>`, `weekly:<date>`, `monthly:<yyyy-mm>`, `once`. A moved
  booking moves its untouched list.
- **Firing is `netlify/functions/checklists/`** (every 15 minutes via
  `checklists-cron.js`, or Settings → Checklists → Check now). `plan.js` is
  pure (pinned by `tests/checklists-plan-test.cjs`; the run by
  `tests/checklists-run-test.cjs`; the screens by `tests/checklists-e2e.cjs`).
  It reads only what the switched-on templates need, works out every anchor,
  and sends `fire` / `retime` / `cancel` to `chk_worker_apply` (service role
  only), which fires a key once, never before the template's `fire_from`
  (moved to now when a template's trigger changes or it is switched on again,
  so nothing back-fires), re-opens a list the SYSTEM cancelled if its
  booking comes back, marks the previous weekly/monthly list Missed, and
  refuses to move or cancel a list anyone has ticked. **A failed or empty
  read cancels nothing** (`sure` in plan.js).
- **Who**: an item goes to a person (an office login), `role:admin` (Office),
  `role:bar`, `role:cleaner` (Housekeeping) or `anyone`. The bar and
  housekeeping logins are shared, so ticks from them read "Bar" /
  "Housekeeping" (`chk_person_label`; office people by first name, the
  surname's initial only when two share it). Anyone on staff may tick anyone's
  item and **ignore a whole list** (Toby) — the name is kept. Untick: whoever
  ticked, or an admin. Bar and housekeeping see only lists with something for
  their role or Anyone; admins see everything.
- An item ends **Done**, **Done with a comment** (`note`, comment required) or
  **N/A** (comment optional). Comments and ignored / missed lists show on the
  admin home ("From checklists") until Read (`chk_seen`).
- **Pay bar**: `wp_drinks.staff_pay_bar` (the office's tick, set by
  `wp_admin_set_pay_bar`, on the event's Drinks & bar) overrides the client's
  `pay_bar` either way; null = go by the client. Ticketed events have
  `box_events.pay_bar` (box office editor → The event; `EVENT_COLS`).
- **Event start time** for event lists: the event's `guestArrivalTime` only if
  it is a bare time like `13:00`, otherwise a default per type in
  `app_data` `hbf_checklist_settings_v1` (`startTimes`; weddings 12:00,
  parties 19:00, celebrations of life 12:00, other 12:00 until changed).
  Ticketed events use `starts_at`.
- A viewing on both an enquiry and the booking it became fires once (the
  booking's — matched by email and day).
- The Todoist box and its Settings card are gone (Toby, 28 Oct); the
  `todoist-feed` function is left in place, unused.
- **A record's own checklists** (29 Oct, migration u): `chk_for_record(kind,
  id)` returns every list whose `link` is that letting / event / ticketed
  event (cancelled ones left out, not-yet-open ones in). `RecordChecklistsPanel`
  shows them on the letting (Details, under housekeeping), the event (Event
  Details, under housekeeping) and the box office editor — nothing at all
  while a record has none or the function is missing — and opens one in
  `ChecklistRunModal` over the form, so unsaved edits are not lost.
- **Finished and past** is grouped by the day each list was FOR (`anchor_at`,
  never `closed_at`), then by its record (`chkPastGroups`). The record's name
  comes from the context the worker wrote (`chkRecordInfo`: "Emma Juner
  letting", "Smith wedding"); a clean's context has no name, so it borrows
  one from another list in the group or says "A letting". Pinned by
  `tests/letting-form-e2e.cjs`.

### Letting form (29 Oct 2026)

- **Tabs, like the event form**: Details (type, source, link, guest, stays,
  housekeeping, checklists, notes), Payments (discount, extras, breakage,
  schedule), Emails (Airbnb conversation, Send an email now, the archive),
  Files. Save / Exit sit under every tab. The guest's name is the page title
  (`PageHeader`, back to Lettings = Exit) with `accomFormSub` under it.
- On a phone: rows are wrapping flex with a basis per field, not grids (the
  stylesheet folds every grid to one column) — guest + status, email +
  phone. The payment schedule is ONE `nowrap` line per payment (name,
  amount, due, paid tick) under a header row; extras likewise. Notes grow
  with the text up to 60vh, then scroll (`GrowTextarea maxHeight`).

### WhatsApp (29 Oct 2026, migration v)

- **Send-only number: the 01825 VoIP landline**, directly on Meta's Cloud API
  (no provider). Phone number id `1454490917738977`, account `970274439005564`
  — in `whatsapp-send.js`, not secret. Secrets in Netlify only:
  `WHATSAPP_TOKEN` (permanent system-user token), `WHATSAPP_APP_SECRET`,
  `WHATSAPP_VERIFY_TOKEN`. The business mobile is untouched.
- **Replies are allowed and read by email in office hours** (Toby): every
  template's footer says so; there is no auto-reply and no Call button.
  `whatsapp-webhook.js` keeps each inbound message in `wa_messages` (id =
  Meta's message id), matches the number to a letting / event / enquiry
  (`normaliseNumber`: UK numbers to 44…), and emails it to
  hawthbushfarm@gmail.com. A failed email answers 500 so Meta redelivers;
  `emailed_at` makes it once only. Pinned by `tests/whatsapp-webhook-test.cjs`.
  **No `WHATSAPP_APP_SECRET` = every POST refused** (503, Meta redelivers;
  30 Oct review) — never fail open on a public address. Settings → WhatsApp →
  Setup shows whether it is set (`appSecretSet` in `whatsapp-send` status).
- `wa_messages`: RLS on, no policies, anon/authenticated revoked — functions
  only.
- **Settings → WhatsApp is its own page** (`WhatsAppPage`, view `whatsapp`,
  tabs Setup / Messages / Sent, 30 Oct). Setup: the sending number and its
  name review; whether the WhatsApp account is linked to the app
  (`/{WABA}/subscribed_apps` — a verified callback URL alone does NOT bring
  messages in; "Link it now"); a test box; who gets what (staff mobiles, the
  housekeepers' summary numbers, summary day/hour, arrival hour); Check now.
  Messages: every template — on/off, its wording, Meta's status, Submit /
  Resubmit. Sent: `wa_messages` newest first, filter by number.
- **Templates live in `netlify/functions/whatsapp-reminders/templates.js`**
  (shared by `whatsapp-send.js` and the sender): `checklist_live`,
  `checklist_overdue`, `changeover_summary`, `pre_arrival`. Wording uses NAMED
  merge fields (`{{guestName}}`); on submission they are numbered in
  first-appearance order and the body + order are stored in `app_data`
  `hbf_whatsapp_submitted_v1` (written only by `whatsapp-send` submit).
  **Sending fills values in the SUBMITTED order** (`sendOrder`), never the
  order of wording edited since. An existing template is edited in place
  (`POST /{template id}`), refused while Meta's review is PENDING. Meta's
  rules enforced by `checkBody`: ≤1,024 chars, no field at the very start or
  end, no two fields side by side, known fields only. Values may hold no line
  break (`cleanParam`). **Meta's sample `hello_world` is not on this account**
  (error 132001) — never assume it.
- **Settings object** `app_data` `hbf_whatsapp_settings_v1`: `templates[name]
  {on, body}`, `checklists[<chk template id>] {live, overdue}` (the two ticks
  on each checklist — kept HERE, not on `chk_templates`, because changing a
  template's trigger moves when it fires), `summary {day, hour, recipients
  [{name, mobile}]}` (default Sunday 8am, Edita + Karina), `arrival {hour}`
  (default 9). Every writer re-reads and changes only its part
  (`saveWaSettings`).
- **The sender** (`whatsapp-reminders/`, every 15 min at 7/22/37/52 via
  `whatsapp-reminders-cron.js`; `plan.js` pure): **nothing 10pm–8am**
  (`isQuiet`); something due in the night goes at 8am — every rule has a
  14-hour catch-up window and no more, so switching a message on sends no
  backlog. Checklist messages go only to items set to a NAMED person, one per
  person per list each (live: when the list opens; overdue: once their first
  item passes due, listing the overdue ones). Pre-arrival: from the arrival
  hour on the check-in day, confirmed/completed lettings, consenting guests,
  one per booking per day. Summary: the chosen weekday from the chosen hour,
  the next 10 days per property (out / in + surname + extra clean / note /
  no exit clean) and the Grain Store (confirmed diary events, published box
  office events, their notes); each day's line is sized from the wording in
  use so the body fits 1,024 (`dayCap`). Every send is marked in
  `wa_sent_marks (kind, ref)` BEFORE sending and unmarked on refusal; a
  132000/132001 stops that template for the run (not approved). The log row
  keeps the text exactly as read (`render`), `to_name`, `template`.
- **Guest consent** (`waConsent` on a letting): ticked by default on the
  letting form and the public booking page ("information about your stay
  only, never marketing"); `create-accom-checkout` stores only a plain true.
  A booking with no answer counts as yes — **except Airbnb**, never asked
  (`guestAgreed`).
- **Replies** keep their photo / voice note / video / file: the webhook stores
  `media {type,id,mime,name}` and fetches it from Meta with `WHATSAPP_TOKEN`
  at email time, attached up to 10MB; bigger or failed = named in the email,
  never a failed delivery.
- **Pre-arrival asks for an arrival time** (30 Oct): three tap-to-answer
  buttons (`quickReplies` on `pre_arrival` — "Before 6pm", "6pm to 9pm",
  "After 9pm"; their ORDER is their meaning: add at the end, never reorder).
  Each button is sent with a payload `eta|<booking id>@<arrival day>|<n>`;
  `whatsapp-webhook` (`etaOf` / `saveEta`) writes `arrivalEta {text, date, at,
  via}` on the letting — fresh read, PATCH only if `updated_at` is unchanged,
  retried on a clash — and the email says it was saved. The lettings form
  keeps `arrivalEta` from the server copy on save (with `airbnb`). Shown on
  the letting form ("Expected arrival"), on housekeeping Live's check-in row
  and on the home page's arrivals — only when `date` is that stay's check-in.
  `arrival` settings also hold `daysBefore` (0 / 1), `gateCode` and `packs
  {<property id>: link}`, the `{{gateCode}}` / `{{arrivalPack}}` merge fields
  of the WhatsApp AND the lettings emails (`send-accom-reminders`,
  `send-accom-email` read them as `WA_ARRIVAL`).
- **Home → Accom check-ins** carry three markers per coming arrival
  (`ArrivalBadges`): the clean before them (their extra clean, else the last
  clean due on or before check-in at that property: Clean ✓ / To clean /
  Clean due), their checklists (`chk_for_record`, per booking: Checklist ✓ /
  late / n of m / later) and their WhatsApp arrival time. Pinned by
  `tests/arrival-badges-e2e.cjs`. **Migration u (`chk_for_record`) was only
  applied to production on 30 Oct** — before then the letting/event
  checklists panel was silently empty.
- **Early check-in / late check-out** (30 Oct): two ticks with times on the
  letting form (`EarlyLateToggles`; 3pm and midday unless changed), kept as
  `earlyCheckIn` / `lateCheckOut` AND written into the first arrival's
  `checkInTime` / the last departure's `checkOutTime` (`applyEarlyLate`), so
  housekeeping windows, checklists and the pre-arrival WhatsApp follow with no
  change of their own. Unticking puts those stays back to the standard time.
  Shown on the home page line ("Early in 3pm", "Late out 12pm") and in the
  changeover summary.
- **Hosted arrival packs** (`arrival-pack.js`, 30 Oct): serves an
  attachment of a lettings email template (the data URL in
  `hbf_email_templates_v1`) — so replacing the attachment updates the link.
  `/pack/<template id>/<key>` = the file for everyone;
  `/pack/<template id>/<key>/<tag>` = the file marked for that tag, else the
  one for everyone. Key = HMAC(template id [+ "/" + tag], `HBF_ADMIN_TOKEN`),
  16 chars (`packKey` in templates.js); rotating the token changes every link.
- **Attachments are marked per booking kind** (31 Oct, Toby): each attachment
  on a lettings email template has `for` — blank (everyone), a property id
  (`hamlet`, `amly`, `glamping`), or on the Wedding/Event template a kind of
  event (`event-wedding`, `event-party`, `event-celebration`, `event-other`,
  from the LINKED farm event's type; a Wedding booking with no link =
  wedding). A booking's tags are `packTags()` (event kind, then its
  properties); `attachmentsFor()` picks the files for everyone plus those for
  its tags — in `send-accom-email` AND `send-accom-reminders` (whose automatic
  arrival email attached nothing at all before 31 Oct). `{{arrivalPack}}` in
  the WhatsApp and the emails = the property's own link on the WhatsApp page
  if set, else `pickHostedPack()`: that booking's arrival template, its link
  for the first matching tag, else its link for everyone, then the other
  template. **Wedding bookings and lets linked to a farm event get
  `arrival_event`** (`usesEventTemplate`, the same test as `isWeddingStay`'s
  check-in times) — before 31 Oct only bookingType Wedding did. All shared
  from `whatsapp-reminders/templates.js`; pinned by
  `tests/arrival-packs-test.cjs`, the editor's choice by `whatsapp-page-e2e`.
- **Send WhatsApp by hand** on a letting (`WaBookingSend`; `whatsapp-send`
  `bookingPreview` / `sendBooking`): the pre-arrival message for the next
  arrival, previewed as sent, refused without consent or a mobile, marked in
  `wa_sent_marks` as `arrival|<id>|<day>` so the automatic one won't repeat
  it; a second send needs `force` ("Send again"). Pinned by
  `tests/whatsapp-send-booking-test.cjs`.
- Home page order (Toby, 30 Oct): … Accom check-ins (name · property, then
  the markers) … the wedding pipeline, then Brochure requests last. Recent
  automated emails moved to Settings → Email templates → Sent
  (`RecentAutomatedEmails`).
- **Weddings are "Holding" until the contract is sent** (Toby, 30 Oct) — on
  screen only: the wedding pipeline has Holding / Contract sent / Contract
  signed (a Confirmed wedding with no contract counts as Holding), and
  `BookingStatusBadge` shows a Confirmed wedding with no contract as Holding.
  The event's stored `status` is unchanged and must stay **Confirmed** for a
  real wedding: housekeeping, checklists and the reports skip Holding events.
- **Every staff login may have a mobile** (`profiles.mobile`, international
  digits, written only by `user-admin.js` `users.create` / `users.setMobile`;
  edited in place on Settings → Staff, `MobileCell`). Optional for everyone:
  blank = no WhatsApps.
- `wa_reminders_sent` (migration w) is unused and empty — replaced by
  `wa_sent_marks` (migration x); drop it when convenient.
- Tests: `tests/whatsapp-reminders-test.cjs` (templates, plans, the run),
  `tests/whatsapp-webhook-test.cjs` (incl. media), `tests/whatsapp-page-e2e.cjs`,
  the ticks in `tests/checklists-e2e.cjs`, consent in `tests/letting-form-e2e.cjs`,
  arrival times in `tests/whatsapp-webhook-test.cjs` and `tests/arrival-badges-e2e.cjs`.
- Still to build: Send buttons and a WhatsApp panel on records, couples'
  templates.

## Working in this folder from a Claude session

The repo is reached through a mount that does not allow deletion, and two
things break because of it. Neither is a repo problem.

- **`git commit` fails with "could not read commit message".** Git writes
  `.git/COMMIT_EDITMSG` successfully and then cannot read it back. Commit with
  plumbing instead, which never touches that file:

      TREE=$(git write-tree)
      C=$(git commit-tree "$TREE" -p "$(git rev-parse HEAD)" -F /path/to/msg)
      git update-ref refs/heads/main "$C"

  Set `GIT_AUTHOR_*` and `GIT_COMMITTER_*` in the environment first. Verify with
  `git log`, `git status` and `git fsck --connectivity-only`.
- **`vite build` fails at `prepareOutDir` with EPERM** because it cannot empty
  `dist/`. Build somewhere else to check compilation:
  `npx vite build --outDir "$HOME/dist-check" --emptyOutDir`. Netlify builds
  from a clean checkout, so `dist/` here is only ever a local artefact.
- Git also leaves a `.git/HEAD.lock` or `.git/index.lock` behind after most
  writes. Move them aside (`mv` works, `rm` does not) or the next commit — including
  one from GitHub Desktop — is refused.

## Where the rest of the context lives

Build history and decisions live in the Claude project ("Weddings Booking App")
as `claude/STATUS-current.md` and the `claude/build-*.md` documents. They are
not in this repo. The `HANDOFF-*.md` files in the root are earlier and partly
superseded.

Currently being scoped: `claude/scope-client-portal.md`.
