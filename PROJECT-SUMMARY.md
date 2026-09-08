# Hawthbush Farm — management app: work summary

Covering August 2026. Three substantial pieces of work plus a set of smaller
changes, all in the same React/Vite app deployed on Netlify with Supabase
behind it.

---

## 1. The Grain Store Box Office

An in-house ticketing system, built to replace Ticket Tailor.

**What it does.** Events with multiple ticket types, draft→publish, a public
event page, three-step Stripe checkout, one QR code per booking, part-admission
at the door (a party of six can arrive in twos), camera check-in with an
alphabetical fallback list, access codes for private events, discount codes,
availability display, minimum booking size, deposits with balances billed
automatically, eight email templates, a waitlist, cash/transfer/comp tickets,
and cancel-and-restock.

**Deliberately out of scope**, agreed at the start: timezones (everything is
Europe/London), ticket bundles, donations, refund protection, multi-currency,
SMS, seating charts, sales windows, and passing booking fees to the buyer.

**Shape of it.**

- `supabase/box-office-schema.sql` — 8 tables (`box_events`,
  `box_ticket_types`, `box_orders`, `box_order_lines`, `box_checkins`,
  `box_discount_codes`, `box_waitlist`, `box_code_attempts`), row-level
  security on with no policies, and 15 database functions. All reads and
  writes go through those functions rather than the tables.
- 8 new Netlify functions: `box-admin`, `box-billing`,
  `create-ticket-checkout`, `expire-ticket-holds`, `pay-balance`,
  `send-ticket-email`, `stripe-ticket-webhook`, `ticket-qr`.
- 3 public pages: `ticket-event.html`, `my-ticket.html`, `whats-on.html`.

**Seats are held atomically.** `box_reserve_order()` takes a row lock and
creates a 15-minute pending hold, so two people checking out at once cannot
oversell the last ticket. An hourly job clears abandoned checkouts.

**Stripe is a separate account** from lettings — `acct_1DeKnBKCwZHyDyxr` for
ticketing, `acct_1Pyd6CBQuJjvSXJo` for lettings — so ticket income and letting
income stay separately quantifiable for bookkeeping.

**Verified before shipping** by a 40-assertion schema test run against a real
Postgres instance, not by inspection.

---

## 2. Closing the unlocked door — Supabase Auth migration

The larger and more consequential piece. Before this, the app authenticated
with three shared passwords compiled into the JavaScript bundle, and the
database was readable by anyone who viewed source.

Done in seven phases, each deployed and verified before the next.

| Phase | What changed |
| --- | --- |
| 1 | Public booking pages stopped downloading the whole customer database |
| 2 | Scheduled jobs moved to the service key |
| 3 | Real accounts via Supabase Auth; roles read from the database, not the browser |
| 4 | Function-level authorisation |
| 5–6 | Storage buckets closed; audit logging |
| 7 | `app_data` closed to anonymous access |

**Three roles**: admin sees everything; bar sees stock-take and door check-in;
cleaning sees events and changeovers. One account per person, so a leaver is
revoked without a deploy.

**Measured, not assumed.** Phase 1 was checked against production data: 240
occupied stays and 634 occupied nights identical to the old client-side logic,
with zero email addresses in the new payloads. Exposure before and after:

- booking a viewing: 120KB / 100 emails / 33 phone numbers → 4KB / none
- booking accommodation: 172KB / 66 emails → 17KB / none

**Final state, tested with the public key**: wedding diary, cottage bookings,
enquiries, properties and email log all closed. Writes refused. Deletes affect
zero rows. Contracts refused. Only the two public terms documents readable.

**The near-miss worth remembering.** After Phase 3, `app_data` still carried an
old "Allow all for anon" policy. Every session read came back empty and the app
silently substituted its built-in example data — 42 real weddings replaced on
screen by seed records. Saving anything at that point would have overwritten
them. The fix was three-part: a red banner when seed data is showing, a guard
that refuses to save while it is, and RPC calls that throw on error instead of
returning an empty array.

That was the fourth silent-failure incident in this project, and the pattern
behind all four was the same — an unchecked response treated as valid data.
The codebase now checks `res.ok` before believing anything.

**52 assertions** across five phase test suites (`phase1-test` 15,
`phase3-test` 8, `phase5-6-test` 11, `phase7-test` 12, `grants-test` 6), all
run against a local Postgres configured to mirror Supabase's extension and
schema layout.

---

## 3. SignWell contracts

Sending the event booking form for signature from inside the app, and taking
the completed values back out. The most recent work, and the least
battle-tested.

**Outbound.** A Contract tab on each event prefills all 21 Hawthbush-side
fields from the event — names, dates, access times, venue fee, non-standard
terms, and the four accommodation options with their dates and prices — every
one editable before sending. Test mode is on by default.

**Inbound.** When the contract comes back signed, a review panel proposes what
to do with it. Nothing saves until it is applied.

- Client details — both names, both mobiles, address — onto the event.
- Invoice emails merged into the Xero field (additive; nothing is removed).
- Lettings bookings created for whatever accommodation they chose.
- The signed PDF filed against the event, which turns the EBF square green on
  the events list.

**The accommodation rule**, as agreed: Amly and Hamlet are independent — Yes
books, Hold books provisionally, No books nothing. Glamping is one choice
offered as two rows, and the two-night option wins unless it is a flat No.
Whichever wins is marked provisional if that answer was a Hold.

**Overwrite protection.** A value that matches what the event already holds is
not offered at all. A blank field is ticked to fill. A genuine disagreement is
shown amber and unticked, with the old value struck through, so replacing
something is always a decision.

**Fields are two-way.** Anything sent blank is offered to us to fill in
SignWell while signing, and an existing value can be corrected there — so those
come back as well, or the edit would be lost.

### Three API behaviours found by probing, not guessing

Worth recording, because all three were counter-intuitive and each cost a
failed send:

1. **Dates are asymmetric.** They must be *sent* as a full ISO 8601 timestamp —
   plain `YYYY-MM-DD` is refused — but come *back* as `DD/MM/YYYY`. We send
   midday UTC rather than midnight, because midnight UTC is the previous
   calendar day anywhere behind Greenwich and a contract off by a day is worse
   than one that is refused.
2. **Every placeholder must have a recipient, and every address must differ.**
   Between them these mean this template cannot produce a one-signer contract;
   a genuinely single-client booking would need its own template.
3. **Dropdowns return names, not option ids** — which is fortunate, because
   three of the four accommodation dropdowns share the same option ids.

After guessing wrong twice on the date format, a diagnostic was added to
Settings that sends each candidate format to the live API and reports which is
accepted. That is now the pattern for anything uncertain in this integration.

---

## 4. Smaller pieces

- **Brevo sync** — ticket buyers, event enquiries, wedding couples and cottage
  guests pushed to four mailing lists nightly at 02:40, with the date added and
  soft opt-in set.
- **Email sender** now shows as "Hawthbush Farm" rather than "hello".
- **Enquiries** — event type as a dropdown, warm/cold based on contact in
  either direction, new viewing enquiries always warm.
- **Home screen** reordered — box office and new bookings below viewing
  requests.
- **Door access for bar staff** without giving them the rest of the app.

---

## Current state

Last build handed over: **`2026-08-23r`**. The box office and all seven
security phases are deployed and verified in production. The SignWell
integration is deployed and has successfully sent and received a real signed
contract; the PDF filing, the two-way field write-back and the glamping
two-night fee were built after that test and have not yet been exercised
against a real contract.

## Outstanding

1. **Rotate the SignWell API key** — it was visible in a screenshot shared
   during setup. Worth doing before real contracts run through it.
2. **Write the ticket terms and conditions** — the Box Office settings screen
   flags this amber.
3. **Contract test suite is not in the repo.** 49 assertions covering the
   glamping rules, the email merge and the field mapping were written in a
   temporary directory that has since been cleared. They should be rewritten
   into `supabase/` alongside the others.
4. Confirm the 3am backup and 7am reminders ran clean on the service key.
5. Optional: rename `TextField_1` in the SignWell template to `Email Invoiced`.

## Decisions worth not relitigating

- **No SignWell completion webhook.** It would have to rewrite the whole events
  record from a background function, risking a lost update against anyone
  editing an event at the time. For something that completes a few times a
  month, pressing "Check status" is the safer trade.
- **Glamping's two fees are alternatives, not additions.** Only the option the
  client picks is charged, so the two-night fee is deliberately excluded from
  the year accommodation total, which already sums the one-night one.
- **Estimates are developer-hours, not calendar time.** The box office was
  roughly 11 hours of build across two to three weeks of elapsed time.
