-- 2026-10-30x  WhatsApp: one "sent once" table for every kind of message,
-- and who / which template on the message log.
--
-- wa_sent_marks replaces wa_reminders_sent (migration w, never used — left in
-- place, empty; drop it at leisure): the checklist, pre-arrival and changeover-summary WhatsApps all mark
-- here BEFORE sending, keyed by text so a booking id, a date or a run + person
-- all fit. A failed send deletes its mark. RLS on, no policies, no privileges
-- for anon / authenticated: functions only.
--
-- wa_messages.to_name — who it went to, for the Sent list's filter.
-- wa_messages.template — which template, when it was one.
-- wa_messages.media — what a guest attached (type, name, size, forwarded?).

create table if not exists public.wa_sent_marks (
  kind     text not null,
  ref      text not null,
  wa_id    text,
  sent_at  timestamptz not null default now(),
  primary key (kind, ref)
);
alter table public.wa_sent_marks enable row level security;
revoke all on public.wa_sent_marks from public, anon, authenticated;

alter table public.wa_messages add column if not exists to_name text;
alter table public.wa_messages add column if not exists template text;
alter table public.wa_messages add column if not exists media jsonb;
