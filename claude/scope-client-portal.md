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
| Guest numbers | **Numbers before names.** Seated day and evening extras as counts on day one; names later, in two separate lists. |
| Schedule span | **Per event type.** A wedding gets the day before and the day after; **a party gets the event day only** — no access either side. |
| Tables | **Rectangular, six seats, three a side.** Seats belong to the table and move with it. A per-table **one side only** tick gives three seats on one side for the top table. |

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

Toby's call and the right one: **the Xero invoices are king.** A generated plan
would be wrong constantly — the schedule moves with which accommodation is taken
and corkage moves with final numbers. Xero is the figure the client received.

### What already exists — more than first credited

- **`xeroContactId` is a field on every event** (`emptyBooking`, App.jsx 6512).
  There is no contact picker to build and no matching problem to solve.
- **`XeroInvoicesPanel`** (App.jsx 8575) renders an invoice list for a contact.
- Aggregate amount-due across bookings (App.jsx ~7994–8001) and an overdue
  chasing view (~11193) already exist. The display rules are worked out.
- The query is settled: `Invoices?ContactIDs=…&order=Date DESC`.
- `netlify/functions/xero-invoice.js` pushes invoices as DRAFT and resolves the
  contact; helpers reusable.

Mirroring this into the portal is largely a restyle of components that work.

### What does not carry over: the transport

`/api/xero-api/*` is **not a function** — it is a bare Netlify redirect
(`netlify.toml` line 74) straight to `api.xero.com/api.xro/2.0/:splat`. The
browser supplies the token, held in `sessionStorage` with the refresh token
alongside it (App.jsx 535, 566). **There is no server-side layer in that path to
extend**, and the token it carries reads `Contacts`, `BankTransactions` and
`Reports/ProfitAndLoss` as happily as `Invoices`.

That is fine while only staff can sign in — the token is the credential and only
staff obtain one. It is not fine once a wedding client has a login.

### What to build

A **Xero Custom Connection**: machine-to-machine `client_credentials`, no consent
step, no refresh token to keep alive, secret in Netlify env vars, token never
leaving the server. One connection per organisation, which is the shape here;
available in the UK; access tokens last 30 minutes and are re-minted
automatically.

One function, given an event, resolves that event's `xeroContactId`
**server-side** and returns only its invoices, slimmed to what the portal shows.

**The single most important line in the implementation: the function must never
accept a contact id from the caller.** If it does, a couple can pass another
wedding's id and read their invoices. Take the event from the session, look the
contact up behind the function, and the hole does not exist.

Other rules:

- **Only AUTHORISED and PAID invoices are ever returned. Never DRAFT, never
  VOIDED.** `xero-invoice.js` pushes drafts; showing a client a draft invoice is
  a bad afternoon.
- Overdue = AUTHORISED, `DueDate` past, `AmountDue > 0`.
- Link out via the online invoice URL (`GET /Invoices/{id}/OnlineInvoice`) so the
  client can view and, if online payments are on, pay. PDF as fallback. Confirm
  both against the live org first.
- **A cache table is optional and deferred.** Live fetch behind the function is
  fine for the number of active weddings here. Add `wp_invoices` plus a nightly
  sync only when the 07:00 digest should spot an invoice going overdue by itself
  (+2h).

### Check before starting

1. **What a Custom Connection costs now.** Xero moved to usage tiers on 2 March
   2026 — Starter is free with 5 connections and 1,000 calls/day/org, ample here,
   but the Custom Connections FAQ still calls them premium without naming a price.
   Confirm with Xero. Fallback if unwanted: move the existing token server-side
   with the refresh token in Supabase — more work, and it reintroduces the
   refresh-token fragility a Custom Connection avoids.
2. **The admin path is worth tightening too**, separately: `xero-proxy.js` and the
   `/api/xero-api/*` redirect forward anything, to anyone holding a token, under a
   wildcard CORS header. ~1h, and the portal's function is the pattern to copy.

## A trap in the guest numbers: `eveGuests` means the total, not the extras

From the live bookings: one wedding has 90 seated / 25 evening, another 106 / 225,
another 100 / 0. The field is being used as the **total** evening headcount in
some records and as something closer to extras in others — 25 against 90 seated
must mean 25 arriving in the evening; 225 against 106 must mean everyone.

Toby wants an evening **extras** list, which is the more useful thing to collect:
a couple knows who is coming for the evening only, and does not reliably know a
combined total.

**Decision unless overridden: the portal stores extras; the app's `eveGuests`
keeps meaning the total; the portal writes the sum when numbers are applied to the
event.** Decide this once and convert on the way in — left alone, the portal and
the diary will disagree about how many people are on site, which is the number the
bar and the fire figure both depend on.

---

## The event-type rules config

The app already has `EVENT_TYPES = ["Wedding (Peak)","Wedding (Off Peak)","Party",
"Wake","Other"]` (App.jsx 8124) and `eventTypeLabel()` (636), which strips the
peak suffix.

**Hang the rules off the label, not the variant.** Peak is a pricing distinction,
not an operational one — a peak wedding and an off-peak wedding keep the same
curfew. So four rule sets: Wedding, Party, Wake, Other.

Each carries:

- **Which days the schedule offers** — day before, event day, day after.
  **Wedding: all three. Party: event day only, no access either side.** Wake and
  Other still to be decided.
- **Per day: access/arrival time, music end, bar close, carriages, vacate time.**

A party being single-day has a knock-on worth building in rather than discovering:
with no day-before access, setup happens on the morning, so the party template
opens with setup and supplier-arrival blocks rather than starting at guest arrival.
A wedding's template can assume the room was dressed yesterday; a party's cannot.

These become the locked rows in the timeline. A party gets different limits from a
wedding weekend with nothing hardcoded. Per-event override is allowed but flagged —
warn, never refuse, same as double bookings.

Worth noting this config is useful beyond the portal: it is the house rules written
down once, and the run sheet and staff rota could read it later.

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

### The layout behaviour that earns an assertion

**What happens to a seated guest when the table changes.** Ticking "one side only"
destroys seats four to six — those guests must return to the unassigned list,
visibly, and never silently vanish. Rotation must not reshuffle anybody: seats keep
their index, only their drawn position moves.

This is the same family as the four record-loss incidents. Pin it with assertions,
not with care.

---

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
| 01 | Guests: numbers panel, two name lists, import, reconciliation, accommodation allocation | 6 |
| 02 | Checklist, venue-must-know form, contract tab, Pinterest field | 5.5 |
| 03 | Money: Xero Custom Connection, server-side route, portal tab | 6 |
| 04 | Suppliers — portal directory + selections | 3 |
| 05 | Suppliers — public page (after consent emails) | 2 |
| 06 | Timeline: multi-day, event-type rules config + admin editor, share links, run sheet | 8 |
| 07 | Layout — the one room template | 2 |
| 08 | Layout — one table type with derived seats, snap, rotation, the one-side tick and its guest eviction, seat panel, tables-needed count, exports | 6.5 |
| 09 | Admin views, 07:00 digest, lock-date warnings, purge job | 4 |

**≈48 hours all in.** Phases 00–02 ≈16.5 hours is the smallest thing worth
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
3. **Who chases supplier consent for the public page?** One batch email before
   phase 05.
4. **Retention:** default is portal access for a month after the wedding, guest
   rows purged at three, timeline and layout kept indefinitely (useful, almost
   no personal data). Confirm or change.

---

## Market timing

Prismm (formerly AllSeated), the floor-plan tool many UK venues point couples
at, is being retired by Cvent: view-and-export only from 1 October 2026, shut
31 December 2026, templates and object groups do not migrate. That argues for
owning the layout tab, and is worth a line in the 2027 brochure.
