# Client portal for booked weddings — build spec

**Status: scoped, not started. Revised 8 September 2026.**

A logged-in portal for booked wedding clients. Eight tabs, two logins per
wedding, opened on contract signature, hung off this app.

---

## Decisions — settled, do not relitigate

| | |
| --- | --- |
| Dietary | **Out.** Hawthbush is not the caterer. Replaced by an **access needs** field, which is the venue's business whoever caters. |
| Supplier share links | **In.** Tokenised read-only URLs to the timeline and plan, no login. |
| Venue-must-know form | **In.** |
| Purge rule | **In.** |
| Logins | **Two per wedding**, many-to-one on the event, magic links. |
| Money | **Real Xero invoices**, not a generated payment plan. See below. |
| Contract | **Its own tab**, read-only. |
| Change digest | **In**, 07:00, never real-time. |
| Seeding | **In.** Nothing is invited to an empty portal. |
| Table plan | **Not authoritative** — indicative only. Toby's setup sheet stays master. |
| Rooms | **One room planned.** Both are used by a wedding, but the second needs no planning tool. |
| Portal opens | **On contract signature** — the trigger already exists (`2026-09-08d`). |
| Supplier directory | **Public** as well as portal — a recommended-suppliers page on the website. |
| Lock date | **Warns, never refuses** — same call as double bookings. |
| Pinterest | **A dashboard field**, not a tab. |

---

## Architecture

**Portal data goes in its own relational tables keyed on `event_id`. It never
touches the `app_data` events array.** Reads and writes through
`SECURITY DEFINER` functions resolving `auth.uid()` to exactly one event — the
box office shape (8 tables, RLS on, no policies, everything through functions),
which has not lost a row.

A portal means third parties writing at unpredictable moments while an admin has
the same event open. This project has lost records four times to
read-array/write-array and two of those paths are still open
(`stripe-accom-webhook.js`, `AccomImport`). The only crossing point is a link
table mapping email → event. The portal never writes a lettings record, a Stripe
object or the events array.

Auth: Supabase magic link (`signInWithOtp`), no passwords, two users per event.

---

## Money — the Xero integration

Toby's call, and it is the right one: **the Xero invoices are king.** A generated
payment plan would be wrong constantly, because the schedule moves with which
accommodation is taken and corkage moves with final numbers. A figure the portal
invents and a figure Xero holds will disagree, and Xero is the one the client
has actually received.

### What already exists

- `netlify/functions/xero-invoice.js` — pushes an event invoice into Xero as a
  DRAFT, finds or creates the contact, resolves the branding theme, reads the
  invoice back to verify totals. Good error surfacing of Xero's own validation
  messages. 289 lines, and its helpers are largely liftable.
- `netlify/functions/xero-proxy.js` — forwards GETs to the Xero API.
- `src/App.jsx` — a browser-side PKCE OAuth flow. Client ID at line 486, scopes
  at 503 (`accounting.invoices`, `accounting.contacts`, `accounting.settings`,
  `offline_access`), token stored in `sessionStorage` (line 535).

### Why none of it can be reused for the portal

**The Xero access token lives in the browser, and `xero-proxy.js` will forward
any path to Xero for anyone who presents one**, under
`Access-Control-Allow-Origin: *`, with no check on who is calling.
`xero-invoice.js` checks nothing either.

That is tolerable while only staff can sign in — the token is the credential and
only staff obtain one. It is not tolerable the moment a wedding client has a
login. A token that can read `Invoices` can equally read `Contacts`,
`BankTransactions` and `Reports/ProfitAndLoss`. There is no version of this
design where a couple's browser holds a key to the Hawthbush ledger.

The interactive flow is also useless for a nightly sync: the token dies with the
tab.

### What to build instead

A **Xero Custom Connection** — machine-to-machine `client_credentials`, no user
consent step, no refresh token to keep alive, secret in Netlify env vars, token
never leaves the server. One connection serves one organisation, which is
exactly the shape here. Available in the UK. Access tokens last 30 minutes and
are re-minted from the credentials automatically.

- A new function returns **only** the invoices belonging to one event. It never
  proxies an arbitrary path, and the portal never speaks to Xero directly.
- **Cache into a `wp_invoices` table.** Sync nightly plus an on-demand refresh,
  and show a last-synced time. The portal reads the table, never Xero. That
  keeps the tab working when Xero is down, keeps well inside the rate limit, and
  lets the 07:00 digest say "invoice 1043 went overdue".
- **Match by Xero ContactID stored on the event.** `xero-invoice.js` already
  does find-or-create-contact on push, so capture the `ContactID` there — the
  link mostly falls out of existing code. Add a per-invoice show/hide toggle in
  the admin view for the case where a couple's contact also carries an unrelated
  cottage booking.
- **Only AUTHORISED and PAID invoices are ever shown. Never DRAFT, never
  VOIDED.** `xero-invoice.js` pushes drafts; showing a client a draft invoice is
  a bad afternoon.
- Each invoice links out via the online invoice URL
  (`GET /Invoices/{id}/OnlineInvoice`) so the client can view and, if online
  payments are on, pay. Serve the PDF as a fallback. Confirm both against the
  live org before building on them — the diagnostic-first pattern from the
  SignWell work.
- Overdue = AUTHORISED, `DueDate` in the past, `AmountDue > 0`.

### Two things to check before starting

1. **What a Custom Connection costs now.** Xero moved to usage-based tiers on
   2 March 2026 — Starter is free with 5 connections and 1,000 API calls per day
   per org, which is ample here, but the Custom Connections FAQ still describes
   them as a premium option without naming a price. Confirm with Xero. If it is
   chargeable and unwanted, the fallback is to keep the existing standard OAuth
   app but move the token server-side, storing the refresh token in Supabase —
   more work, and it brings back the refresh-token fragility a Custom Connection
   avoids.
2. **`xero-proxy.js` should be locked down regardless** — require an
   authenticated admin session and allowlist the paths it will forward. Roughly
   an hour, worth doing whether or not the portal happens.

---

## The eight tabs

| Tab | Build | Hours |
| --- | --- | --- |
| **Guests** | Name, side, meal/evening, adult/child/infant, plus-one link, staying overnight, **access needs** (step-free, hearing loop, parking by the door, high chair). Import by CSV **and** pasted column with mapping. Live counts: meal, evening, children. Dropping dietary keeps the portal clear of health-adjacent data entirely, which makes the purge rule simpler to write and to explain. | 5 |
| **Accommodation** | Named rooms with real bed configurations — 7 hamlet bedrooms, 3 cottage, 7 bell tents — not a generic four a side. Allocates only *within what is already booked*. Never creates a letting. Rooming list export for the cleaning role. | incl. |
| **Checklist** | Locked venue items dated relative to the wedding (final numbers, final balance, plan lock, curfew acknowledged) plus client-added. The admin completion column is the real payoff — it is a chasing tool. | 4 |
| **Contract** | Read-only: signed PDF, plain-English key terms already on the event, T&Cs. **Two wrinkles.** Storage buckets were closed in phases 5–6, so the PDF is served through a short-lived signed URL from a function, never a bucket path. And the nightly SignWell poll deliberately does not file the PDF — Toby applies it from the review panel — so the tab must show "your signed contract will appear here shortly" in the gap between signature and review rather than break. | 1.5 |
| **Money** | Real Xero invoices — number, issue date, due date, total, amount due, status, overdue in unmissable colour, and a link out to the online invoice. Synced into a cache table. See above. | 10 |
| **Suppliers** | Curated directory (category, contact, website, public liability held y/n) plus this wedding's selections; client-added suppliers promotable into the directory. The public page adds a **listed publicly** flag and a short description per supplier — **and an obligation to get each supplier's agreement before publishing their details.** Do that as one batch email before the page goes up; it doubles as a nudge to collect the PLI certificates not yet held. | 5 |
| **Timeline** | Vertical blocks — time, duration, title, linked supplier, note — dragged to reorder, later blocks shifting, with a pin for the ones that cannot move. Seeded from a Hawthbush template, which is the real value: it steers people off a 4pm ceremony without the conversation. Venue-fixed rows locked. Printable run sheet plus the tokenised share link. | 6 |
| **Layout** | Indicative, not authoritative — **no millimetre accuracy and no fire-gangway checking, which removes the riskiest part of the build.** One room only. Admin editor draws it once: outline, bar, stage, doors, pillars, no-go zones. Clients place tables from a short palette, grid snap, 90° rotation, refused in no-go zones. Seating is a panel, not chair-dragging: click a table, get a seat list, assign from a searchable list of unassigned guests. Desktop only, said out loud; read-only on phones. Every export footered *"indicative layout — confirm with the venue"*. | 10 |

## Not building

Website/RSVP (accept a CSV out of Joy); budget tracker; in-app messaging;
payments taken inside the portal (a second Stripe path into the lettings account
for something Xero invoices already solve); auto-seating solver ("fill this
table from a group" gets 90% of it); 3D walkthrough; live collaborative editing
(last-write-wins with "changed by Sarah, 4 min ago" is honest and free).

---

## Build order — developer-hours

| | Phase | Hours |
| --- | --- | --- |
| 00 | Foundations: tables, functions, magic-link auth (two users/event), shell, invite on signature | 5 |
| 01 | Guests + accommodation allocation + counts + import | 5 |
| 02 | Checklist, venue-must-know form, contract tab, Pinterest field | 5.5 |
| 03 | Money: Xero Custom Connection, cache table, sync, portal tab | 10 |
| 04 | Suppliers — portal directory + selections | 3 |
| 05 | Suppliers — public page (after consent emails) | 2 |
| 06 | Timeline + tokenised share links + run sheet | 6 |
| 07 | Layout — the one room template | 2 |
| 08 | Layout — tables, seating, exports | 8 |
| 09 | Admin views, 07:00 digest, lock-date warnings, purge job | 4 |

**≈50.5 hours all in.** Phases 00–02 ≈15.5 hours is the smallest thing worth
logging into. Box office was ≈11 hours, for scale.

Phase 03 is worth doing early even though it is the largest single phase,
because **the Xero connection is useful outside the portal**: once it exists,
the admin app can show invoice and payment status against every event, which is
a chasing tool Toby gets whether or not a single client ever logs in.

Separately, and not part of the portal: **harden `xero-proxy.js`** (~1h).

---

## Open questions

1. **Does the payment picture need anything Xero does not hold?** The assumption
   is that every figure a client should see is on an invoice. If deposits taken
   by Stripe are not invoiced in Xero, the tab will look incomplete.
2. **Who chases supplier consent for the public page?** One batch email before
   phase 05.
3. **Retention:** default is portal access for a month after the wedding, guest
   rows purged at three, timeline and layout kept indefinitely (useful, almost
   no personal data). Confirm or change.

---

## Market timing

Prismm (formerly AllSeated), the floor-plan tool many UK venues point couples
at, is being retired by Cvent: view-and-export only from 1 October 2026, shut
31 December 2026, templates and object groups do not migrate. That argues for
owning the layout tab, and is worth a line in the 2027 brochure.
