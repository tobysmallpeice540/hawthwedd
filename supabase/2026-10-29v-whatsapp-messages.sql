-- 2026-10-29v  WhatsApp messages (the 01825 send-only number)
--
-- One row per WhatsApp message, in or out. Written only by Netlify functions
-- with the service key (whatsapp-webhook now; the sending function next), so
-- RLS is on with NO policies and anon/authenticated hold no privileges at all.
-- The staff app will read it through a SECURITY DEFINER function when the
-- booking panel is built.
--
-- id is Meta's message id (wamid…), so a webhook delivery Meta retries can
-- never make a second row. emailed_at is set only once the reply has been
-- forwarded to the farm inbox; a row with it null is retried on the next
-- delivery of the same message.

create table if not exists public.wa_messages (
  id            text primary key,
  direction     text not null check (direction in ('in', 'out')),
  number        text not null,            -- the guest's number, digits only, e.g. 447415740704
  profile_name  text,                     -- the WhatsApp name they go by (inbound)
  msg_type      text not null,            -- text, image, audio, document, …
  body          text,                     -- the text, or the caption; null for media with none
  at            timestamptz not null,     -- when WhatsApp says it was sent
  record_kind   text,                     -- accom / event / enquiry, when the number matched one
  record_id     text,
  record_name   text,
  status        text,                     -- outbound: sent / delivered / read / failed
  emailed_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists wa_messages_number_at on public.wa_messages (number, at desc);
create index if not exists wa_messages_record on public.wa_messages (record_kind, record_id);

alter table public.wa_messages enable row level security;
revoke all on public.wa_messages from public, anon, authenticated;
