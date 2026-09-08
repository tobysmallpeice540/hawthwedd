-- ─────────────────────────────────────────────────────────────────────────────
-- PHASE 1 — take the customer database off the public booking pages
--
-- Run this whole file in a NEW Supabase SQL editor tab. Safe to re-run.
--
-- Today public/book-accom.html and public/book-viewing.html download whole
-- app_data blobs with the anon key, purely to work out which dates and slots
-- are free. book-accom.html pulls every cottage booking — names, emails,
-- phones, prices, payment schedules — and uses three fields from it. And
-- book-viewing.html pulls the entire wedding diary and every enquiry, to
-- answer "is there an event that day".
--
-- These two functions answer those questions and return nothing else. Not one
-- name, email, phone number or price crosses either boundary.
--
-- SECURITY DEFINER so they keep working once app_data has RLS turned on: they
-- run as the owner, and the anon role is granted nothing but the right to call
-- them.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Cottage availability ─────────────────────────────────────────────────────
-- Every occupied stay, as property + dates. Mirrors buildAvailability() in
-- book-accom.html exactly, including its two quirks:
--   · a cancelled booking frees its dates
--   · a PENDING booking (started online, not yet paid) still holds them
-- and it handles both record shapes — modern bookings carry a stays[] array,
-- older ones have the property and dates on the record itself.
create or replace function public_accom_busy()
returns jsonb
language sql
security definer
set search_path = public, extensions
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'propertyId', s->>'propertyId',
           'checkIn',    s->>'checkIn',
           'checkOut',   s->>'checkOut'
         )), '[]'::jsonb)
  from jsonb_array_elements(
         coalesce((select value from app_data where key = 'hbf_accom_v1'), '[]'::jsonb)
       ) b
  cross join lateral (
    select case
             when jsonb_typeof(b->'stays') = 'array' and jsonb_array_length(b->'stays') > 0
               then b->'stays'
             else jsonb_build_array(b)
           end as arr
  ) x
  cross join lateral jsonb_array_elements(x.arr) s
  where coalesce(b->>'status', '') <> 'cancelled'
    and coalesce(s->>'propertyId', '') <> ''
    and coalesce(s->>'checkIn', '')    <> ''
    and coalesce(s->>'checkOut', '')   <> '';
$$;

-- ── Viewing availability ─────────────────────────────────────────────────────
-- Three things the booking page needs, and nothing more:
--   taken      slots already used, as date + time
--   blocks     manual blocks and manual openings, as date + slot + kind
--   eventDays  dates with a farm event on — a bare list of dates. The page
--              only ever asked "is something on that day"; it never needed to
--              know whose wedding it was.
create or replace function public_viewing_availability()
returns jsonb
language sql
security definer
set search_path = public, extensions
stable
as $$
  with
  bookings as (
    select coalesce((select value from app_data where key = 'hawthbush_bookings_v6'), '[]'::jsonb) as v
  ),
  enquiries as (
    select coalesce((select value from app_data where key = 'hbf_enquiries_v1'), '[]'::jsonb) as v
  ),
  requests as (
    select coalesce((select value from app_data where key = 'hbf_viewing_requests_v1'), '[]'::jsonb) as v
  ),
  blocks as (
    select coalesce((select value from app_data where key = 'hbf_viewing_blocks_v1'), '[]'::jsonb) as v
  ),

  -- Viewings booked against a wedding record
  from_bookings as (
    select vw->>'date' as d, vw->>'time' as t
    from bookings, jsonb_array_elements(bookings.v) b
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(b->'viewings') = 'array' then b->'viewings' else '[]'::jsonb end
    ) vw
  ),
  -- …and against an enquiry
  from_enquiries as (
    select vw->>'date' as d, vw->>'time' as t
    from enquiries, jsonb_array_elements(enquiries.v) e
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(e->'viewings') = 'array' then e->'viewings' else '[]'::jsonb end
    ) vw
  ),
  -- …and requests made online that have been confirmed
  from_requests as (
    select r->>'date' as d, r->>'time' as t
    from requests, jsonb_array_elements(requests.v) r
    where r->>'status' = 'confirmed'
  ),
  taken as (
    select d, t from from_bookings
    union all select d, t from from_enquiries
    union all select d, t from from_requests
  )

  select jsonb_build_object(
    'taken', coalesce((
      select jsonb_agg(distinct jsonb_build_object('date', d, 'time', t))
      from taken where coalesce(d, '') <> ''
    ), '[]'::jsonb),

    'blocks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date', bl->>'date', 'slot', bl->>'slot', 'kind', coalesce(bl->>'kind', 'block')))
      from blocks, jsonb_array_elements(blocks.v) bl
      where coalesce(bl->>'date', '') <> ''
    ), '[]'::jsonb),

    -- Just the dates. A farm event blocks the day; who it belongs to is none
    -- of the public page's business.
    'eventDays', coalesce((
      select jsonb_agg(distinct b->>'date')
      from bookings, jsonb_array_elements(bookings.v) b
      where coalesce(b->>'date', '') <> ''
        and coalesce(b->>'couple', '') <> ''
    ), '[]'::jsonb)
  );
$$;

-- The anon key may call these two and nothing else.
grant execute on function public_accom_busy()           to anon, authenticated;
grant execute on function public_viewing_availability() to anon, authenticated;

select 'public_accom_busy'           as fn, jsonb_array_length(public_accom_busy()) as rows
union all
select 'public_viewing_availability', jsonb_array_length(public_viewing_availability()->'taken');
