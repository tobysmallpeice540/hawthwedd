# Hawthbush Farm — Grain Store Box Office
## Handoff document for Claude Code

**Repo:** https://github.com/tobysmallpeice540/hawthwedd
**Verified against:** commit `80d840b`, 21 Aug 2026 17:41 BST · `src/App.jsx` = 905,827 bytes · `APP_BUILD = "2026-08-13d"`
**Status:** planned and agreed, not yet built. Nothing in this document has been implemented.
**Owner:** Toby Smallpeice (toby@smallpeice.net)

---

## 1. What we're building and why

### The goal

Hawthbush Farm runs weddings in a barn called **the Grain Store**. Toby also wants to run *ticketed public events* there — comedy nights, supper clubs, Christmas parties — and is currently paying Ticket Tailor to do it. This project brings ticketing in-house, as a new section of the farm management app that already exists.

The whole loop must work without leaving the app: create an event → add ticket types → publish a public page → take card payments → email a QR ticket → scan people through the door → know who's in the room.

### Feature list

| Feature | Notes |
|---|---|
| Events | Name, start/end date & time, venue, description, images, capacity |
| Ticket types | Name, price, quantity, optional per-order min/max |
| Draft → publish | Shareable link per event |
| Public event page | Styled to match the existing farm booking pages |
| 3-step checkout | Tickets → Details → Payment, via Stripe Checkout |
| **One QR per booking** | Not one per ticket — see §4.3, this is the key design decision |
| Part-admission on the door | 10 bought, admit 5 now, code stays live for the other 5 |
| Camera check-in | Phone scanner in the admin app + printable A4 door list |
| Access codes | Per event. Set = private event, page is gated |
| Discount codes | Per event, percentage or fixed amount off |
| Availability display | Per event: hidden / "only 8 left" / exact "33 of 150" |
| Minimum booking size | Per event, e.g. six to a table |
| **Deposits** | Per-ticket deposit now, balance auto-billed X days before |
| Email templates | Eight templates + timings, editable in-app |
| Waitlist | Capture when sold out, plus a "release more tickets" button |
| Cash / transfer / comp tickets | Issued by hand, count against capacity |
| Cancel & restock | Voids tickets, returns stock, refund handled in Stripe |

### Explicitly out of scope

Toby ruled these out by name. Do not build them:

- Timezones — everything is Europe/London, always
- Ticket groups and bundles
- Donations
- Refund protection
- Multi-currency — always GBP
- SMS / WhatsApp reminders
- Seating charts, products/upsells, memberships
- Sales windows, custom transaction fees, custom sales tax, confirmation-page redirects
- Discount codes with expiry dates, usage caps, cross-event scope, or ticket-type restrictions
- Booking fees passed to the buyer — **Hawthbush absorbs Stripe fees**. A £20 ticket means the buyer pays £20.

---

## 2. The existing app — what you're building into

### Stack

- **React 18 + Vite**, deployed on **Netlify**
- **`src/App.jsx` is a single 15,204-line monolith.** Everything is in it. Match its style rather than refactoring — no TypeScript, no CSS files, inline style objects throughout, `function` declarations rather than arrow-heavy modern React.
- **`src/main.jsx`** holds the login screen and hardcoded credentials, then renders `<App role={role} />`
- **Supabase** for data, used as a key/value store via a table called `app_data` (`key`, `value` jsonb, `updated_at`)
- **Netlify Functions** (CommonJS, `exports.handler`) for anything server-side
- **Stripe** for payments, **Resend** for email

### Landmarks in `src/App.jsx`

| Line (approx) | What's there |
|---|---|
| 46–47 | `SUPABASE_URL` / `SUPABASE_KEY` constants (anon key, hardcoded) |
| 49–108 | `sbGet(key)` / `sbSet(key, value)` / `sbDelete(key)` helpers |
| 111–135 | Supabase Storage helpers, bucket `booking-files` |
| 1784 | `APP_BUILD` — bump this on every deploy; there's a stale-tab guard that depends on it |
| 5558 | `export default function App({ role, onSignOut })` |
| 5566 | `const [view, setViewRaw] = useState("home")` — the router is a string in state |
| 6104–6139 | The view switch — `{view==="list" && <ListView …>}` etc. |
| 6146–6158 | `function Header(...)` and its `tabs` array — **add the Box Office tab here** |

The nav tabs today: Home · Calendar · Lettings · Events · Enquiries · Viewings · Bar · Reports · Settings. Note **"Events" already means weddings** — the ticketing tab must be called something else. We agreed on **Box Office**.

### `app_data` keys currently in use

`hbf_accom_v1` · `hbf_accom_guests_v1` · `hbf_app_build_v1` · `hbf_backup_index_v1` · `hbf_bar_events_v1` · `hbf_bar_pos_map_v1` · `hbf_bar_products_v1` · `hbf_cleaning_email_v1` · `hbf_discount_codes_v1` · `hbf_email_log_v1` · `hbf_email_templates_v1` · `hbf_enquiries_v1` · `hbf_event_invoices_v1` · `hbf_min_wage_v1` · `hbf_properties_v1` · `hbf_starred_emails_v1` · `hbf_terms_v1` · `hbf_todoist_ics_v1` · `hbf_viewing_blocks_v1` · `hbf_viewing_requests_v1` · `hbf_viewings_v1`

### Existing Netlify functions — and which ones to copy

```
netlify/functions/
  _email-shell.js              ← shared email HTML shell (copied verbatim into each sender)
  create-accom-checkout.js     ← COPY THIS for create-ticket-checkout.js
  stripe-accom-webhook.js      ← COPY THIS for stripe-ticket-webhook.js
  send-accom-email.js          ← COPY THIS for send-ticket-email.js
  send-accom-reminders.js      ← COPY THIS for box-billing.js (deposit/balance logic already exists here)
  backup-data.js               ← daily snapshot, keeps 30 days
  calendar-feed.js  property-calendar.js  sync-all-icals.js  sync-property-ical.js
  handle-viewing.js  submit-viewing.js  send-cleaning-summary.js
  xero-proxy.js  xero-invoice.js  zettle-sales.js  todoist-feed.js
```

**Important convention:** Netlify functions here cannot share local modules. `_email-shell.js` is *copied verbatim* into every sender. Follow that pattern; a comment at the top of the file explains it. Same for the `sbGet`/`sbSet` helpers, which are duplicated in each function with no header spreading (`{...headers}` was avoided deliberately).

`send-accom-reminders.js` is the single most useful precedent for this project: it wakes daily, finds deposits and balances falling due, mints a Stripe payment link, sends a templated email, and marks what it sent so a Stripe/Netlify retry can't double-send. The box office billing run is the same shape pointed at different tables.

### Existing public pages

`public/book-accom.html` (69 KB), `public/book-viewing.html`, `public/terms.html`, `public/squarespace-embed.html`. These are standalone, dependency-free HTML files with inline `<style>` and vanilla JS — **not** part of the React app. They read Supabase directly with the anon key and POST to Netlify functions. The ticketing public pages follow exactly this pattern.

### netlify.toml

Scheduled functions are declared like this:

```toml
[functions."sync-all-icals"]
  schedule = "0 * * * *"
```

Redirects: there is a catch-all `/*` → `/index.html` (200) at the bottom. **Any new redirect must go above it.** Note also `SECRETS_SCAN_OMIT_KEYS` in `[build.environment]` — new secret-shaped env vars must be added to that list or the build fails.

---

## 3. Design and layout

There are **three** distinct visual languages already in this codebase. Use the right one; don't invent a fourth.

### 3.1 Admin app (inside `App.jsx`) — blue, dense, utilitarian

Uses a theme object `T` defined near the top of `App.jsx`. Reuse it; don't hardcode new colours.

- Deep blue `#1e4d8c`, accent blue `#2563eb`, borders `#c8d9ef`, text `#1a2d4a`, muted `#7a9bbf`, page background `#f0f6ff`
- System font stack, 13–15px, inline style objects
- Tabs: `padding: "22px 20px 18px"`, active gets `borderBottom: 3px solid T.accent` and `fontWeight: 700`
- There is a `useIsMobile()` hook and the Header renders a separate hamburger layout below the breakpoint — the Box Office tab must be added to **both** the desktop nav and the mobile menu list
- Sub-navigation inside a view is a `tabs` array of `[id, label]` pairs — see the Settings and Lettings views for the pattern

**Box Office layout:** one tab, four screens — `Events` · `Orders` · `Door` · `Settings`, with Waitlist living inside the individual event rather than as its own screen.

### 3.2 Public pages (`public/*.html`) — warm, editorial, farm

Taken from `book-accom.html`:

```
Fonts    Cormorant Garamond (600) for headings, Jost (300/400/500) for body
         via fonts.googleapis.com
bg       #f9f6f1        text     #2d2a25
muted    #7a7060        border   #e8e2d9
accent   #b8a88a        panel    #ffffff
Panels   border-radius 14px, 1px border, box-shadow 0 2px 10px rgba(0,0,0,.04)
Steps    a horizontal step bar: .step / .step.active (dark fill) / .step.done (green)
```

### 3.3 Email (`_email-shell.js`) — table-based, Outlook-safe

`BRAND` object with the same warm palette. Georgia + Helvetica, **not** the web fonts — webfonts don't load reliably in mail clients. Deliberately table-based with inline styles because Outlook ignores `<style>` blocks and flexbox. `bodyToHtml()` turns a plain-text template into paragraphs and auto-links bare URLs. `buildEmailHtml(bodyText, { termsUrl, buttonLabel, buttonUrl })` is the entry point.

### 3.4 Screens, as agreed from the Ticket Tailor screenshots

**Add / edit event** — event name; starts (date + time); ends (date + time); venue name (default "The Grain Store") and postcode (default "TN21 0JY"); description (rich text); event page image + header image; "Select tickets" button label; hide map toggle. Then the settings blocks: access code, availability display, minimum booking size, payment mode, waitlist.

**Add a ticket type** (modal, mirroring the screenshot) — Ticket name · Quantity (with a live "Total quantity" readout) · Ticket price with a `£` prefix · a collapsed "more" section holding description and per-order min/max. Above the list of types sits the capacity readout: **Issued · Remaining · % issued · Total capacity**.

**Public event page** — header image, event name, date line, location with map, description, and a sticky "Buy Tickets" panel on the right that collapses under the content on mobile.

**Checkout** — a modal-style three-step flow with a breadcrumb (`Tickets › Details › Payment`) and a persistent **Order summary** sidebar showing event name, venue, date, line items and total.

1. *Tickets* — one row per type with `− [n] +` steppers and price; running subtotal; "Got a discount code?"; minimum-order message if applicable
2. *Details* — First name, Last name, Email, Repeat Email, Phone
3. *Payment* — hand off to Stripe Checkout

**Confirmation** — green "Order complete" panel with the order reference, a "View your tickets" button, and an "Add to calendar" link.

**Door screen** — full-bleed camera view, large result banner, running count `84 / 120 in` pinned at the top, a search field, and a Print list button.

---

## 4. Technical decisions

Each of these was explicitly chosen by Toby. Don't quietly change them.

### 4.1 Real Supabase tables, not the `app_data` blob pattern

This is the one deliberate departure from how the rest of the app works. Every other feature stores itself as a single JSON blob that is read, edited in the browser and written back whole. That is fine for wedding bookings (rare, sequential) and **fatal for ticket sales**, where a rush of simultaneous buyers would silently overwrite each other and oversell the room.

So: sales data goes in proper tables with an atomic reserve function. **Email templates and timings stay in `app_data`** — one person edits them occasionally, so the blob really is the right tool there.

### 4.2 Schema — seven new tables

```
box_events
  id uuid pk · slug text unique · name text
  status              draft | published | hidden
  starts_at, ends_at  timestamptz (always Europe/London, no tz picker)
  venue_name          default 'The Grain Store'
  venue_postcode      default 'TN21 0JY'
  description         html · header_image · page_image
  capacity            int null — overall cap across all ticket types
  buy_button_label    text · hide_map bool
  access_code         text null — set = private
  listed              bool — off keeps it out of /whats-on and noindexes it
  show_remaining      hidden | low | exact
  low_threshold       int default 10
  min_per_order       int null — null = no minimum
  payment_mode        full | deposit
  deposit_pence       int — PER TICKET
  balance_days        int — balance due this many days before the event
  waitlist_on         bool · waitlist_cta · waitlist_text · waitlist_confirmation
  created_at

box_ticket_types
  id · event_id fk · name · description
  quantity int · price_pence int
  min_per_order · max_per_order · sort_order · hidden bool

box_orders                          ← this IS the entrant list
  id · event_id fk · order_ref      e.g. HB-8F3K2
  first_name · last_name · email · phone
  status              pending | deposit_paid | paid | cancelled | refunded
  source              stripe | cash | transfer | comp
  qr_token            32 random chars, unique, indexed — what the QR holds
  tickets_issued_at   null until paid in full; the QR endpoint refuses before this
  total_qty int · admitted int      ← the door's running tally
  discount_code · discount_pence
  total_pence · deposit_pence · balance_pence
  balance_due_on date · balance_paid_at · chased_at
  stripe_session_id · paid_at · notes · created_at

box_order_lines
  id · order_id fk · ticket_type_id fk · qty · unit_price_pence

box_checkins                        ← full scan log
  id · order_id fk · count int · checked_at · checked_by

box_discount_codes
  id · event_id fk · code text · kind (percent|fixed) · value numeric

box_waitlist
  id · event_id fk · name · email · qty_wanted
  created_at · notified_at · converted bool
```

### 4.3 The reserve function — the one clever bit

A single `SECURITY DEFINER` Postgres function is the only way an order is created. In one transaction it:

1. Locks the relevant `box_ticket_types` rows
2. Counts what is genuinely sold — paid orders, plus pending orders **created within the last 15 minutes**
3. Validates the access code, any discount code, and the minimum order size
4. Rejects if there isn't enough left
5. Inserts the `box_orders` row and its `box_order_lines`
6. Returns the order id and reference

Consequences that matter: two people going for the last three tickets means exactly one succeeds; the 15-minute hold means nobody loses seats while typing a card number; abandoned checkouts release themselves; and "first come, first served" after a waitlist release is actually true rather than aspirational.

`expire-ticket-holds.js` runs on a schedule purely for hygiene — the correctness comes from the count in step 2, not from the cleanup.

### 4.4 One QR per booking, admitting a head count

**Decision:** one code covers the whole booking. Buy ten, get one QR — not ten.

The scanner shows the booker's name and what they hold, with a large **Admit all** button and a `− / +` stepper beside it for when only part of a group has arrived. `box_orders.admitted` is the tally; every scan writes a `box_checkins` row with its count and time.

Behaviour:

```
Jane Smith — 2 General Admission                     [Admit 2]     green
Tom Reed — 10 General Admission, 5 already in        [Admit 5] − + green
All 4 already in — last scanned 19:42                              amber
Not valid for this event                                           red
```

A group arriving in three cars all scan the same code. Once `admitted == total_qty` the code goes amber, so an eleventh person can't follow the ten in.

**Accepted consequence:** the entrant list is a list of *bookings*, not individuals — one name per booking plus a head count. That was always the truth, since only the buyer's name is collected. Collecting per-attendee names would be a separate feature.

### 4.5 QR delivery

The QR is served as a **real PNG from a Netlify function at its own URL** (`ticket-qr.js`), referenced from the email as an ordinary `<img>`.

This is deliberate and was reasoned through: Gmail strips `data:` URI images, and Resend attachments don't reliably display inline. A hosted PNG renders everywhere. Use the `qrcode` npm package server-side.

The QR encodes a **random 32-character token**, never the order reference — so a reference glimpsed on someone else's ticket can't be turned into a working code. The email also links to `/my-ticket/<token>`, which is better on the door: it survives a deleted email, turns screen brightness up, and is forwardable to the rest of the party.

### 4.6 Deposits

Per event. Most events stay on `payment_mode = full` and behave exactly as before.

On a deposit event the deposit is **per ticket**. Worked example — the Christmas parties: £75 a head, minimum six, £20 deposit. A table of six pays **£120 now**, owes **£330**, due (say) 30 days before.

- Checkout states it plainly before payment: *£120 today, £330 due by 24 November*
- They get a **"table reserved"** email — amount outstanding and the date, **no QR**
- `/my-ticket/<token>` shows the same, with a **Pay the balance** button usable at any time
- `box-billing.js` runs daily: sends the balance email X days before, one chase Y days after the due date, and the pre-event reminder Z days before
- Still unpaid after the chase → the booking appears in a red **Balance overdue** list in the app. **Never auto-cancel.** Toby was explicit: software shouldn't cancel someone's Christmas because they were on holiday.

**No QR until paid in full.** `tickets_issued_at` stays null; the QR endpoint refuses. When the balance clears, the token is issued and the "here are your tickets" email goes out. On the door, a half-paid booking has nothing to scan — searching the name shows `Balance unpaid · £330 · no ticket issued`, and you can take the money on your phone and have the QR appear immediately. Reserved-but-unpaid seats still hold capacity.

### 4.7 Access codes

Set a code on an event and the public page asks for it before showing any tickets — wrong code shows only the event name and date. **Re-validate server-side in the reserve function**, so the gate can't be bypassed by posting directly.

Setting a code also flips `listed` off by default (out of `/whats-on`, `noindex`) — a private event that's still publicly listed isn't private. Overridable. The invite link can carry the code: `/tickets/harvest-supper?code=BARN26` pre-fills it. Codes are case-insensitive and trimmed, because people type them off a poster.

### 4.8 Discount codes

Per event. Percentage or fixed amount off. That's all — no expiry, no usage caps, no cross-event codes, no ticket-type restrictions (all explicitly declined).

Entered at the ticket step, shown in the summary before commitment, and **recalculated server-side** before the Stripe session is created. The browser is never trusted with a price. Present it to Stripe as its own discount line so the receipt tells the truth.

### 4.9 Availability display

Per event, three settings: `hidden` · `low` (shows "Only 8 left" below `low_threshold`) · `exact` ("33 of 150 left"). The admin side always shows real numbers regardless.

### 4.10 Minimum booking size

Per event, a tickbox plus a number, counted **across the whole order** (four adults and two children make a table of six). The public counter blocks progress below it and explains why rather than simply refusing. Off by default.

### 4.11 Email templates and timings

A **Box Office → Settings** screen built the same way as the existing lettings template editor: subject + plain-text body with `{{tokens}}`, stored in `app_data` under a new key (suggest `hbf_box_templates_v1`), rendered through `_email-shell.js`.

| Template | When |
|---|---|
| Booking confirmed | Paid in full. Carries the QR. |
| Table reserved | Deposit received. Balance + date, no QR. |
| Balance due | Automatic, X days before. Payment link. |
| Balance overdue | The single chase, Y days after due date. |
| Tickets issued | Balance cleared — here's the QR. |
| Event reminder | Z days before. Tickets again, parking, doors. |
| Tickets released | To the waitlist. First come, first served. |
| Booking cancelled | When an order is cancelled. |

Timings as house defaults, with `balance_days` overridable per event.

Tokens: `{{firstName}} {{eventName}} {{eventDate}} {{eventTime}} {{venue}} {{orderRef}} {{qty}} {{totalAmount}} {{depositAmount}} {{balanceAmount}} {{balanceDueDate}} {{payLink}} {{ticketsLink}}`

Guard every send with a flag on the record so Stripe or Netlify retries can't double-send — copy how `stripe-accom-webhook.js` does it with `emailFlags`.

### 4.12 Waitlist

Per event toggle. Sold out → the ticket picker is replaced by a waitlist form (name, email, how many). The admin sees `14 people waiting`. To release: raise a ticket type's quantity, press **Email the waitlist**. Everyone gets one message with the link; who actually gets the tickets is settled fairly by the reserve function.

### 4.13 Cash, comps, and cancellation

**Add order by hand** — pick tickets, name, email, mark it `cash` / `transfer` / `comp`, optional note. Issues real QR tickets, counts against capacity, emails them if there's an address. Covers door sales and the band's guest list.

**Cancelling** voids the tickets and returns the stock. The money goes back **through the Stripe dashboard** — the button deep-links to that payment. Deliberate: refund logic that moves real money isn't worth writing when Stripe does it in two clicks.

### 4.14 Public routes

```
/whats-on                      published, listed events
/tickets/<slug>                event page + 3-step checkout, access-code gate if set
/my-ticket/<token>             the QR, or a Pay-the-balance button if still owing
```

netlify.toml, **above the `/*` catch-all**:

```toml
[[redirects]]
  from = "/tickets/*"
  to = "/ticket-event.html"
  status = 200
[[redirects]]
  from = "/my-ticket/*"
  to = "/my-ticket.html"
  status = 200
[[redirects]]
  from = "/whats-on"
  to = "/whats-on.html"
  status = 200
```

### 4.15 New files

```
netlify/functions/
  create-ticket-checkout.js   reserve + open a Stripe session
  stripe-ticket-webhook.js    payment confirmed → issue tickets, send email
                              ** its own endpoint, separate from the accom one,
                                 so metadata can't cross between the two flows **
  pay-balance.js              Stripe session for an outstanding balance
  ticket-qr.js                returns the QR as a PNG
  box-admin.js                admin reads/writes using the service key
  send-ticket-email.js        confirmations, waitlist releases, resends
  box-billing.js              daily: balance emails, chases, event reminders
  expire-ticket-holds.js      scheduled tidy-up of abandoned checkouts

public/
  whats-on.html · ticket-event.html · my-ticket.html

src/App.jsx                   BoxOfficeView + the tab in Header()
netlify.toml                  3 redirects above the catch-all, 2 schedules
package.json                  + qrcode (server PNG), + jsqr (iOS scanner fallback)
```

**New env vars** — add to Netlify **and** to `SECRETS_SCAN_OMIT_KEYS`:

```
SUPABASE_SERVICE_KEY
HBF_ADMIN_TOKEN
STRIPE_TICKET_WEBHOOK_SECRET
```

### 4.16 The door scanner

- `BarcodeDetector` where the browser has it (Android Chrome), `jsqr` on a canvas as the fallback (iOS Safari)
- Requires HTTPS and camera permission — both fine on Netlify
- **Load the whole guest list into the page on open**, so scanning keeps working when the barn wifi drops. Check-ins queue locally and sync when it returns.
- Manual search by name or email, tap to admit
- Print list: A4, alphabetical by surname — Name · Email · What they bought · Qty · Ref · a box per head to tick. Plain `window.print()` with a print stylesheet.

---

## 5. Build phases

Each phase should end somewhere safe to stop.

### Phase 1 — Foundations, no money
Tables, RLS policies, the reserve function. The Box Office tab and its screens. Event CRUD, ticket type CRUD, access code, minimum order size, availability setting, discount codes, draft/publish with a copyable link. Clash warning against the existing wedding diary.
*Nothing is on sale, so nothing can go wrong with a customer.*

### Phase 2 — Selling
Public event page with its code gate. Three-step checkout including discounts. `create-ticket-checkout.js`, Stripe session, `stripe-ticket-webhook.js`, confirmation email with QR, `ticket-qr.js`, `/my-ticket` page.
*Rehearse end to end in Stripe test mode, then once for real with a 50p ticket.*

### Phase 3 — The door
Scanner with part-admission, running count, manual search, printed list, offline cache.
*Test in the barn on the phone that will actually be used, at night.*

### Phase 4 — Deposits and email settings
Deposit events, `pay-balance.js`, the daily `box-billing.js` run, the overdue list, and the template editor with its timings.
*The Christmas parties become possible here.*

### Phase 5 — Waitlist and hand-issued tickets
Waitlist capture and release, cash/transfer/comp orders, cancel and restock.

### Phase 6 — Joining it up
`/whats-on`, ticketed events on the home dashboard and in the `/calendar.ics` feed, and a sales summary — tickets sold, revenue, split by type.

### Setup jobs that are Toby's, not the agent's

1. Run the schema SQL in the Supabase SQL editor
2. Add the three env vars in Netlify + the secrets-scan exemption
3. Add a **second** webhook endpoint in Stripe → `/.netlify/functions/stripe-ticket-webhook`, listening for `checkout.session.completed` and `checkout.session.expired`
4. **Confirm the Stripe account** behind `accounts@hawthbushfarm.co.uk` (used by Ticket Tailor) is the same one the cottage bookings use — if not, a second key is needed

---

## 6. Security — the honest position

Toby asked directly. This was the answer, and it should be carried into any future work.

### What is true today

- The three logins are in `src/main.jsx`, compiled into the JavaScript every visitor downloads. `admin / Hawth8u$h` is readable via View Source. Nothing is checked server-side — the app simply decides to render.
- The Supabase anon key sits in the same bundle and grants full read/write to all of `app_data` — every booking, guest name, email, phone and price — **without needing the password at all.** The password gates the interface; the key is the actual door, and it's unlocked.
- The `bar` and `cleaner` roles are therefore cosmetic. They change what's drawn, not what's reachable.
- Nothing records who changed or deleted what. A comment in the codebase notes that data was destroyed once.

Proportionality: this is a small farm's internal tool and the realistic threat is a curious ex-employee, not a criminal. But ticketing adds the names and email addresses of hundreds of members of the public who never signed anything, which raises the stakes.

### The real fix

**Supabase Auth** — real accounts with server-checked passwords, plus RLS policies keyed to `auth.uid()`. The key in the bundle then grants nothing on its own. Roles become real (bar staff genuinely cannot reach the bookings table). Writes can carry a name and timestamp. A leaver is revoked without a deploy.

Cost is real — auth screen, a profiles/roles table, policies on every table, and reworking every read and write in `App.jsx` to use the session token. Probably the largest outstanding job on the app. **But it splits:** the box office tables get proper policies from day one, and the older data migrates table by table afterwards.

### Cheaper wins worth doing regardless

- Turn on RLS for `app_data` and move its writes behind functions holding the service key — a halfway house that closes the worst of it
- An append-only audit log — cheap, and it's what was actually wanted the day data disappeared
- Separate passwords per person rather than per role — doesn't strengthen the lock, but tells you which key was used
- The daily backup function already keeps 30 days. That's the most valuable control already in place — keep it.

### For the box office specifically

- Buyer PII behind service-key functions, never readable with the public anon key
- Anon role gets `SELECT` on published events, their ticket types, and remaining counts. Nothing else.
- Verify Stripe webhook signatures (`stripe-accom-webhook.js` already shows how)
- Rate-limit the access-code and discount-code endpoints so they can't be brute-forced

**Recommendation given:** don't hold ticketing up for this. Build the box office with proper policies from day one, then treat Supabase Auth as the next project after phase 6.

---

## 7. Open items

- [ ] Confirm the Stripe account question (§5, setup job 4)
- [ ] **Ticket terms and conditions** — a short refund/cancellation paragraph for the checkout, separate from the wedding T&Cs. Must cover whether deposits are refundable if a table cancels. Needs drafting and Toby's approval before the first Christmas booking.
- [ ] Decide whether a ticketed night should auto-create a Bar event with the expected head count (the Bar tab already tracks events for stock) — phase 6 question
- [ ] Longer term: Supabase Auth

---

## 8. Reference material held elsewhere

- The visual plan artifact: https://claude.ai/code/artifact/8b83dcfa-ac71-4750-8be7-1f8c461313d4
- Project doc: `claude/box-office-ticketing-plan.md` in the "Weddings Booking App" project
- Toby's source screenshots: Ticket Tailor's edit-event page, add-ticket-type modal, and the four customer-facing checkout steps. The UI descriptions in §3.4 are derived from these.
