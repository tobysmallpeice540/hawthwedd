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
  calling. The Xero access token lives in the browser's `sessionStorage`. This
  is workable while only staff can sign in; it must not be extended to any
  client-facing feature. See `claude/scope-client-portal.md`.
- The two array-write paths named above.

## Where the rest of the context lives

Build history and decisions live in the Claude project ("Weddings Booking App")
as `claude/STATUS-current.md` and the `claude/build-*.md` documents. They are
not in this repo. The `HANDOFF-*.md` files in the root are earlier and partly
superseded.

Currently being scoped: `claude/scope-client-portal.md`.
