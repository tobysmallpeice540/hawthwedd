-- 2026-10-30w  WhatsApp checklist reminders
--
-- 1. profiles.mobile — each office login's mobile, international digits only
--    (447415740704). Written only by user-admin.js (service key). A signed-in
--    person can read their own row (profiles_read_own) and nobody else's.
--
-- 2. wa_reminders_sent — one row per (checklist run, person) once a reminder
--    has gone, so a person gets ONE WhatsApp per list however often the
--    worker runs (Toby, 30 Oct). Marked BEFORE sending; a failed send deletes
--    its mark so the next run can try again. RLS on, no policies, no
--    privileges for anon / authenticated: functions only.

alter table public.profiles add column if not exists mobile text;

create table if not exists public.wa_reminders_sent (
  run_id     uuid not null,
  person     uuid not null,
  kind       text not null default 'checklist',
  wa_id      text,                 -- Meta's message id, once accepted
  sent_at    timestamptz not null default now(),
  primary key (kind, run_id, person)
);

alter table public.wa_reminders_sent enable row level security;
revoke all on public.wa_reminders_sent from public, anon, authenticated;
