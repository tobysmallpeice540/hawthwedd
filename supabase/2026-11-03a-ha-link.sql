-- 2026-11-03a  The Home Assistant link (netlify/functions/ha-link/).
--
-- One row: the SHA-256 (hex) of the token the farm's Home Assistant sends as
-- x-ha-token, and the WhatsApp numbers its alerts go to (international
-- digits, e.g. 447…). Service role only: RLS on, no policies, and nothing
-- granted to anon or authenticated. To change the token, write a new hash;
-- the token itself is stored only in Home Assistant's secrets.yaml.

create table if not exists public.ha_link (
  id          int primary key default 1 check (id = 1),
  token_hash  text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  alert_to    text[] not null default '{}',
  updated_at  timestamptz not null default now()
);
alter table public.ha_link enable row level security;
revoke all on public.ha_link from public, anon, authenticated;
