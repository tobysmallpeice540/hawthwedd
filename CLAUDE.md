# Hawthbush Farm venue management app

React + Vite on Netlify, with Supabase (Postgres + Auth + Storage) behind it.
Almost all UI lives in one file: `src/App.jsx` — ~19,000 lines, 1.2MB.

## Working agreements

- **Commit straight onto `main`.** No feature branches unless asked.
- Sessions have not been able to push — the git proxy refuses a credential for
  this repo. Commit locally; Toby pushes from GitHub Desktop.
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
  back from a component's snapshot has lost records four times. `mutateBookings`,
  `mutateAccom`, `createBookingRecord`, `updateAccomBookings`, `saveAccomBooking`
  and the nightly job all re-read. Two paths still do not —
  `netlify/functions/stripe-accom-webhook.js` and `AccomImport`. Fix on sight.
- **Check `res.ok` before believing anything.** Four silent-failure incidents,
  all the same shape: an unchecked response treated as valid data. The worst
  replaced 42 real weddings on screen with built-in seed data and would have
  overwritten them on save.
- **Free text is never parsed as money.** Reading a number out of the corkage
  note turned "£9 per adult · 100 guests" into £9,100.

### Database

- RLS is on with **no policies**. Every read and write goes through a
  `SECURITY DEFINER` function. Add functions; do not add policies.
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
- On iPhone, links in emails open in Safari, not in the installed app, so a
  portal magic link signs the couple in to Safari only. A typed one-time code
  on the sign-in screen would fix it; not built yet.

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
- The two array-write paths named above.
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
