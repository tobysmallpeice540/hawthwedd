# Hawthbush Farm — Contracts via SignWell
## Spec as agreed, 23 Aug 2026

**Template:** Hawthbush Farm Booking Form v3
**Template id:** `65c6bae4-d261-437f-ab08-1b8d9d1c3b72`
**Signers:** HT (Hawthbush Farm) · C1 (client 1) · C2 (client 2)
**Status:** spec agreed, not yet built.

---

## 1. The shape of it

A **Contract tab** on the event, beside Files.

Only the fields assigned to **signer 1 (Hawthbush Farm)** are filled in by us.
Every one of them is shown on the tab, prefilled, and **editable before
Generate contract** — the prefills are a starting point, not a decision.

The fields assigned to C1 and C2 are left alone: the clients complete those
when they sign, and a subset comes back to us afterwards (§3).

---

## 2. Outbound — what we prefill

| Contract field | Prefilled with |
|---|---|
| Amly | `yes` |
| Amly from · Hamlet from · Glamping from | the day **before** the event |
| Amly to · Hamlet to · Glamping to | the day **after** the event |
| Access, day before | `Midday to 4.30pm` |
| Access, event day | `10am to Midnight` |
| Access, day after | `10am to 11.30am` |
| Max guests | `200` |
| Emails | from the booking — `email`, `email2` |
| Venue fee | from the booking — `venueFee` |
| Amly fee · Hamlet fee · Glamping fee | entered here, on the contract |

The emails and the venue fee already live on other tabs of the event. They are
repeated here and remain editable in both places.

### The accommodation fees
Entered on the contract tab. When a linked accommodation booking is later added
to the event, the fee **copies across** to that booking rather than being typed
twice.

Note the naming: the event record calls glamping **camping** —
`campingBooked` / `campingFee`. Amly and Hamlet match
(`amlyBooked`/`amlyFee`, `hamletBooked`/`hamletFee`).

---

## 3. Inbound — what comes back

Only these six, from the signed form:

- full name, client 1
- full name, client 2
- mobile, client 1
- mobile, client 2
- address
- approximate number of guests

**Each is written to the event record only after a confirmation step if there
is already a value there.** Nothing overwrites silently — the person who typed
the existing value gets asked first.

---

## 4. The template's actual fields

Read from the template on 23 Aug 2026. `api_id` is what we write to.

### Assigned to **Hawthbush Team** — ours to fill

| api_id | type | Prefill |
|---|---|---|
| `Event Name` | text | `couple` |
| `Event Type` | text | `eventType` |
| `Event Date` | date | `date` |
| `Access Day Before` | text | `Midday to 4.30pm` |
| `Access Event Day` | text | `10am to Midnight` |
| `Access Day After` | text | `10am to 11.30am` |
| `Max Guests` | text | `200` |
| `Venue Fee` | text | `venueFee` |
| `Amly` | dropdown | `Yes` — **see defect 1** |
| `Amly From` / `Hamlet From` / `Glamping from` | date | day **before** the event |
| `Amly to` / `Hamlet to` / `Glamping to` | date | day **after** the last day |
| `Amly Fee` / `Hamlet Fee` | text | entered on the tab |
| `Glamping fee pd` | text | entered on the tab — **per day** |
| `HF Sign Name` / `HF Sign Date` / `HF Signature` | | signed by us in SignWell |

Multi-day events: *from* is the day before `date`, *to* is the day after
`endDate` where there is one, otherwise the day after `date`.

### Assigned to **Client 1** — theirs to fill
`Special Requirements` · `Hamlet` (dropdown, see defect 2) ·
`Glamping` (dropdown, see defect 2) · `Client 1 Name` · `Client 1 Mobile` ·
`Address` · `Client 1 Signature` · `Client 1 Sign Date` ·
`Name Invoiced` (optional) · `TextField_1` (optional, labelled "Email Invoiced")

### Assigned to **Client 2**
`Client 2 Name` · `Client 2 Mobile` · `Client 2 Signature` · `Client 2 Sign Date`

---

## 5. Two defects in the template

**1. The `Amly` dropdown has broken option ids.**

```
{ api_id: "Amly", name: "Yes"  }
{ api_id: "Hold", name: "No"   }   <- id says Hold, label says No
{ api_id: "Amly", name: "Hold" }   <- id "Amly" used twice
```

`Amly` identifies both *Yes* and *Hold*, so setting it through the API is
ambiguous and the contract could say the opposite of what was meant. Compare
`Hamlet`, whose options are properly `SelectField_1_option_1/2/3`.

Must be fixed in SignWell before this field can be set.

**2. `Hamlet` and `Glamping` are assigned to Client 1, `Amly` to Hawthbush
Team.** As it stands we choose Amly and the client chooses the other two.
Almost certainly an authoring slip — needs a decision either way.

---

## 6. On return, book the accommodation

All four choices belong to Client 1: **Amly**, **Hamlet**, **Glamping** (one
night) and **Glamping 2 night**. We set every date and every fee; they say yes,
no or hold to each.

| Their answer | What we book |
|---|---|
| Yes | the booking, confirmed |
| Hold | the booking, with **maybe** ticked |
| No | nothing |

### Glamping is two options for one thing
One night arrives on the day of the event; two nights arrives the day before.
Both leave the morning after. They are meant to pick one, so the pair has to
resolve to a single booking. One rule does it:

> **The two-night option wins unless it is a flat No. Whichever option wins,
> tick *maybe* if that answer was a Hold.**

Which gives:

| One night | Two nights | Booked |
|---|---|---|
| Yes | No | 1 night |
| Hold | No | 1 night, maybe |
| — | Yes | 2 nights |
| — | Hold | 2 nights, **maybe** |
| No | No | nothing |

So *yes to one night, hold on two* books **two nights, maybe** — a hold on the
longer stay is worth more than a yes on the shorter one, because the extra
night is the part that has to be kept free.

Dates and price come from whichever option won.

## 7. Written back to the event

| From the contract | Onto the booking |
|---|---|
| `Client 1 Name` | new field `client1Name` |
| `Client 2 Name` | new field `client2Name` |
| `Client 1 Mobile` | `phone` |
| `Client 2 Mobile` | new field `phone2` |
| `Address` | new field `address` |

`couple` is left alone: it names the booking everywhere in the app. The two
client names are recorded alongside it, not over it.

Each write asks first if there is already a value there.

## The return path (built 2026-08-23, build `2026-08-23g`)

Verified against a real completed contract rather than assumption.

**Dates are asymmetric**, established by probing the API (Settings → Test date
formats). They must be *sent* as a full ISO8601 **timestamp**; both
`YYYY-MM-DD` and `DD/MM/YYYY` are refused with "must be in Iso8601 format".
They come *back* in the template's display format, `DD/MM/YYYY`. Hence
`toIsoDate` outbound and `fromUkDate` on the return leg.

`toIsoDate` appends `T12:00:00Z`, not `T00:00:00Z`: midnight UTC is the
previous calendar day in any timezone behind Greenwich, and a contract off by a
day is worse than one that is refused.

**Recipients: all placeholders assigned, all addresses different.** Omitting
Client 2 gives `missing_placeholder_names`; reusing an address across signers
gives `duplicated_emails`. Together these mean **this template cannot produce a
one-signer contract** — a genuinely single-client booking needs its own
template in SignWell with only Client 1. The Contract tab therefore requires a
distinct Client 2 email and explains why before sending.

**Dropdowns return names, not ids.** SignWell sends `"Yes"` / `"No"` / `"Hold"`
as the value. The duplicated option ids across `Amly`, `Hamlet` and
`Glamping 2 night` (all `SelectField_1_option_1..3`) therefore never have to be
disambiguated. Dates come back `DD/MM/YYYY` whatever was sent.

All 22 api_ids sent by the Contract tab match the live template exactly.

### What comes back onto the event
`Client 1 Name` → `client1Name`, `Client 2 Name` → `client2Name`,
`Client 1 Mobile` → `phone`, `Client 2 Mobile` → `phone2`, `Address` → `address`.

`client2Name`, `phone2` and `address` are new booking fields; `couple` is left
alone.

`Special Requirements` was retired on 2026-08-23 and replaced by
**`Non Standard Terms`**, prefilled from `nonStandard` (Non-Standard / Extras,
the top field on Financials). 21 fields are sent.

### Hawthbush fields are two-way
Anything sent blank is offered to us to fill in SignWell while signing, and an
existing value can be corrected there too — so these come back as well, or that
edit is silently lost:

| Contract field | Event field |
| --- | --- |
| `Event Name` | `couple` |
| `Event Type` | `eventType` (must match `EVENT_TYPES`, else ignored) |
| `Event Date` | `date` (parsed from `DD/MM/YYYY`) |
| `Venue Fee` | `venueFee` |
| `Non Standard Terms` | `nonStandard` |
| `Amly Fee` / `Hamlet Fee` | `amlyFee` / `hamletFee` |
| `Glamping fee pd` / `Glamping 2 fee` | `campingFee` / `glamping2Fee` |

Same review rules as the client fields: unchanged values are not offered at
all, a blank event field is ticked to fill, a genuine difference is amber and
unticked. `Event Type` is guarded by `only` so free text cannot corrupt the
dropdown.

The accommodation **dates** need no mapping — `contractStays` already reads
them off the returned values, so editing `Amly From` while signing changes the
stay that gets created.

`glamping2Fee` was added to the event record on 2026-08-23 so the two-night
price persists between contracts. It sits with `amlyFee`, `hamletFee` and
`campingFee`, which likewise have no Financials UI — accommodation money really
lives on the lettings booking now; these are the quoted prices that go on the
contract.

The two glamping fees are **alternatives, not additions** — only the option the
client picks is ever charged. That is why `glamping2Fee` is deliberately left
out of the `totalAccom` year figure, which already sums `campingFee`: including
both would double-count every glamping event.

Whichever option wins carries its own fee to the lettings booking: one night
takes `Glamping fee pd`, two nights takes `Glamping 2 fee`. Covered by tests
for booked and held in both directions.

Still without a home on the event: `Max Guests` and the three access times.
Both are fine as contract-only — confirmed 2026-08-23.

**Invoice emails are a merge, not a copy.** `invoiceEmails` on the Financials
tab becomes the union of whatever it already held, the couple's `email` and
`email2`, and the client's Email Invoiced — comma separated, deduplicated
case-insensitively, addresses without an `@` dropped. Because nothing is ever
removed it is additive, so it is ticked by default and labelled "adds …"
rather than "replaces". Email Invoiced is read as either `Email Invoiced` or
`TextField_1`, so renaming it in SignWell will not break this.

`Name Invoiced` was removed from the template on 2026-08-23 and is no longer
expected.

An empty field is ticked to fill by default. A field that already holds
something different is shown amber, unticked, with the old value struck
through — the operator decides. Identical values are not offered at all.

### Stays created in lettings
Amly and Hamlet are independent: Yes books, Hold books with `maybe`, No books
nothing. Glamping is one choice in two rows — **the two-night answer wins
unless it is a flat No**, and whichever wins carries `maybe` if that answer was
a Hold. All nine combinations are covered by `contract-test.mjs`.

Properties are matched by name (`amly`, `hamlet`, `glamp`/`camping`) and the
guess is a preselected dropdown, not a decision — properties are the user's to
rename.

New bookings carry `source: "contract"`, `linkedEventId`, and a note saying
which answer produced them. They are appended via `createAccomBookings`, which
re-reads the server array first for the same reason `mutateBookings` does.

Applying stamps `contract.appliedAt`, which suppresses the panel until the next
**Check status** — without it, returning to the tab would offer to create the
same bookings again.

### Deliberately not built: the completion webhook
The Event Callback URL is still empty. A webhook would have to find the event
inside `hawthbush_bookings_v6` and rewrite that whole array from a background
function — a lost-update risk against anyone editing an event at the time, for
no gain over pressing **Check status** on a contract that completes a handful
of times a month. Revisit only if volume makes polling tedious, and then write
to a separate key rather than into the events blob.

### The signed PDF
Applying a completed contract also fetches the signed PDF and files it against
the event with `docType: "Event Booking Form"`. That is what turns the **EBF**
square green on the events list — `BookingFileTicks` reads the attached files,
so nothing else needed telling.

The file record carries `signwellDocumentId`, so checking status again does not
file a second copy. A contract that is signed but not yet filed opens the
review panel on its own, even when every value came back unchanged.

If the PDF cannot be fetched the details and lettings bookings are still saved
and the failure is reported — losing those because a download failed would be
the wrong trade.

The endpoint is not documented clearly, so `case "pdf"` tries four variants of
`/documents/{id}/completed_pdf` and reports which worked in `via`, plus every
failure if none did. Netlify caps a function response at 6MB and base64 is a
third larger than the file, so anything over ~3.7MB is refused with a message
rather than truncated.
