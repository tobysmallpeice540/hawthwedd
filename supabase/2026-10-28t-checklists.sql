-- supabase/2026-10-28t-checklists.sql
--
-- Staff checklists (28 Oct 2026). Short phone lists that appear on their own:
-- on a date, every week or month, before or after a check-in or check-out, an
-- event (any, a wedding, a party, a celebration of life, or one with a pay
-- bar), a viewing, or a property being cleaned — or when someone presses
-- Start now.
--
--   chk_templates   what a list is: title, trigger, items (jsonb). Admin only.
--   chk_runs        one list that has fired, for one anchor (a check-in, an
--                   event, a Monday...). Unique per template + anchor key, so
--                   firing is idempotent: the scheduled worker can run twice.
--   chk_run_items   its items, COPIED from the template when it fires — a
--                   template edited later never changes a live list. One row
--                   per item, so ticks from several phones never collide.
--
-- Who: an item goes to a person (an office login), the Office, the Bar,
-- Housekeeping or Anyone. The bar and housekeeping logins are shared, so a
-- tick from them is recorded as "Bar" / "Housekeeping" (chk_person_label).
-- Anyone on staff can tick anyone's item and ignore a whole list; the name is
-- kept either way. Unticking is for whoever ticked, or an admin.
--
-- Firing is done by netlify/functions/checklists (every 15 minutes), which
-- reads the bookings and asks chk_worker_state / chk_worker_apply, both
-- service role only. It works out every anchor; this file only checks and
-- records.
--
-- Also here: the office's own Pay bar tick on a diary event
-- (wp_drinks.staff_pay_bar, set by wp_admin_set_pay_bar — overrides the
-- client's pay_bar either way; null = go by the client) and a Pay bar tick on
-- ticketed events (box_events.pay_bar).
--
-- RLS on, no policies: every read and write is through these functions.
-- Safe to run twice.

begin;

-- ── Tables ──────────────────────────────────────────────────────────────────

create table if not exists public.chk_templates (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,
  active           boolean not null default true,
  deleted          boolean not null default false,
  trig             jsonb not null,
  items            jsonb not null default '[]'::jsonb,
  default_due_min  integer not null default 0,
  -- Nothing whose anchor is before this fires. Moved to now() whenever the
  -- template is switched on again or its trigger changes, so a new or
  -- changed template never fires for last month.
  fire_from        timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  created_by       uuid,
  updated_at       timestamptz not null default now(),
  updated_by       uuid
);

create table if not exists public.chk_runs (
  id               uuid primary key default gen_random_uuid(),
  template_id      uuid references public.chk_templates(id) on delete set null,
  trig_kind        text not null,
  anchor_key       text not null,
  anchor_at        timestamptz not null,
  opens_at         timestamptz not null,
  title            text not null,
  context          text,
  link             jsonb,
  status           text not null default 'open'
                     check (status in ('open', 'done', 'missed', 'cancelled', 'ignored')),
  closed_at        timestamptz,
  closed_by        uuid,              -- null with a closed_at = the system did it
  closed_by_name   text,
  reason           text,
  seen_at          timestamptz,       -- an admin has read the ignore / miss
  created_at       timestamptz not null default now(),
  started_by_name  text               -- Start now
);
create unique index if not exists chk_runs_key on public.chk_runs (template_id, anchor_key) where template_id is not null;
create index if not exists chk_runs_status on public.chk_runs (status, opens_at);
create index if not exists chk_runs_closed on public.chk_runs (closed_at) where closed_at is not null;

create table if not exists public.chk_run_items (
  id               uuid primary key default gen_random_uuid(),
  run_id           uuid not null references public.chk_runs(id) on delete cascade,
  position         integer not null,
  title            text not null,
  detail           text,
  who              text not null,
  who_label        text not null,
  due_min          integer not null default 0,   -- from the anchor, kept for a re-time
  due_at           timestamptz not null,
  state            text not null default 'open' check (state in ('open', 'done', 'note', 'na')),
  done_at          timestamptz,
  done_by          uuid,
  done_by_name     text,
  comment          text,
  seen_at          timestamptz                   -- an admin has read the comment
);
create index if not exists chk_run_items_run on public.chk_run_items (run_id, position);
create index if not exists chk_run_items_unseen on public.chk_run_items (done_at)
  where comment is not null and seen_at is null;

do $$
declare t text;
begin
  foreach t in array array['chk_templates', 'chk_runs', 'chk_run_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;

-- ── Pay bar ─────────────────────────────────────────────────────────────────

alter table public.wp_drinks  add column if not exists staff_pay_bar boolean;
alter table public.box_events add column if not exists pay_bar boolean not null default false;

create or replace function public.wp_admin_set_pay_bar(p_event_id integer, p_value boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  if p_event_id is null then return jsonb_build_object('ok', false, 'error', 'no_event'); end if;
  insert into wp_drinks (event_id) values (p_event_id) on conflict (event_id) do nothing;
  update wp_drinks set staff_pay_bar = p_value, updated_at = now() where event_id = p_event_id;
  return jsonb_build_object('ok', true, 'staff_pay_bar', p_value);
end $$;

-- ── Helpers ─────────────────────────────────────────────────────────────────

-- The caller's role, if they are active staff.
create or replace function public.chk_my_role()
returns text language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and active and role in ('admin', 'bar', 'cleaner');
$$;

-- How a login is named on a list. Shared logins by what they are; office
-- people by first name, with the surname's initial only when two share it.
create or replace function public.chk_person_label(p_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((
    select case
      when p.role = 'bar' then 'Bar'
      when p.role = 'cleaner' then 'Housekeeping'
      else (
        with parts as (select regexp_split_to_array(trim(coalesce(p.name, '')), '\s+') a)
        select case
          when (select a[1] from parts) = '' then coalesce(nullif(split_part(coalesce(p.email, ''), '@', 1), ''), 'Someone')
          when coalesce((select a[2] from parts), '') <> '' and exists (
            select 1 from profiles q
             where q.id <> p.id and q.active and q.role = 'admin'
               and lower((regexp_split_to_array(trim(coalesce(q.name, '')), '\s+'))[1]) = lower((select a[1] from parts)))
            then (select a[1] from parts) || ' ' || upper(left((select a[2] from parts), 1))
          else (select a[1] from parts)
        end)
    end
    from profiles p where p.id = p_id), 'Someone');
$$;

create or replace function public.chk_who_label(p_who text)
returns text language plpgsql stable security definer set search_path = public as $$
begin
  if p_who = 'anyone' then return 'Anyone'; end if;
  if p_who = 'role:admin' then return 'Office'; end if;
  if p_who = 'role:bar' then return 'Bar'; end if;
  if p_who = 'role:cleaner' then return 'Housekeeping'; end if;
  if p_who like 'person:%' then
    begin
      return chk_person_label(substr(p_who, 8)::uuid);
    exception when invalid_text_representation then return 'Someone';
    end;
  end if;
  return 'Anyone';
end $$;

create or replace function public.chk_is_mine(p_who text, p_role text, p_me uuid)
returns boolean language sql immutable as $$
  select p_who = 'anyone' or p_who = 'role:' || coalesce(p_role, '-') or p_who = 'person:' || coalesce(p_me::text, '-');
$$;

-- Admins see every list; the bar and housekeeping logins see lists with
-- something for them (their role, or Anyone).
create or replace function public.chk_visible(p_run uuid, p_role text, p_me uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_role = 'admin' or exists (
    select 1 from chk_run_items i where i.run_id = p_run and chk_is_mine(i.who, p_role, p_me));
$$;

create or replace function public.chk_run_json(p_run uuid, p_role text, p_me uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', r.id, 'template_id', r.template_id, 'kind', r.trig_kind, 'title', r.title,
    'context', r.context, 'link', r.link, 'status', r.status,
    'anchor_at', r.anchor_at, 'opens_at', r.opens_at,
    'closed_at', r.closed_at, 'closed_by', r.closed_by_name, 'reason', r.reason,
    'started_by', r.started_by_name, 'seen', r.seen_at is not null,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'title', i.title, 'detail', i.detail, 'who', i.who, 'who_label', i.who_label,
        'due_at', i.due_at, 'state', i.state, 'done_at', i.done_at, 'done_by', i.done_by_name,
        'comment', i.comment, 'seen', i.seen_at is not null,
        'mine', chk_is_mine(i.who, p_role, p_me),
        'can_untick', i.state <> 'open' and (p_role = 'admin' or i.done_by = p_me))
        order by i.position)
      from chk_run_items i where i.run_id = r.id), '[]'::jsonb))
  from chk_runs r where r.id = p_run;
$$;

-- What a trigger must look like. Returns the problem in words, or null.
create or replace function public.chk_trigger_error(t jsonb)
returns text language plpgsql immutable as $$
declare k text := t->>'kind';
begin
  if t is null or jsonb_typeof(t) <> 'object' or k is null then return 'Choose when the list starts.'; end if;
  if k not in ('manual', 'once', 'weekly', 'monthly', 'checkin', 'checkout', 'event', 'viewing', 'cleaned') then
    return 'That is not a trigger this app knows.';
  end if;
  if k = 'once' and coalesce(t->>'at', '') !~ '^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$' then
    return 'Give the date and time it should start.';
  end if;
  if k in ('weekly', 'monthly') and coalesce(t->>'time', '') !~ '^([01]\d|2[0-3]):[0-5]\d$' then
    return 'Give the time of day it should start.';
  end if;
  if k = 'weekly' and coalesce(t->>'weekday', '') !~ '^[1-7]$' then return 'Choose the day of the week.'; end if;
  if k = 'monthly' and not (coalesce(t->>'day', '') ~ '^\d{1,2}$' and (t->>'day')::int between 1 and 31) then
    return 'Choose the day of the month (1 to 31).';
  end if;
  if k = 'event' and coalesce(t->>'event_type', 'any') not in ('any', 'wedding', 'party', 'celebration', 'other', 'paybar') then
    return 'Choose which events.';
  end if;
  if k in ('checkin', 'checkout', 'event', 'viewing', 'cleaned') and t ? 'offset_min' then
    if jsonb_typeof(t->'offset_min') <> 'number' or (t->>'offset_min')::numeric <> trunc((t->>'offset_min')::numeric)
       or abs((t->>'offset_min')::numeric) > 86400 then
      return 'The time before or after must be within 60 days.';
    end if;
  end if;
  if k in ('checkin', 'checkout', 'cleaned') and t ? 'property' and jsonb_typeof(t->'property') not in ('string', 'null') then
    return 'Choose a property, or any.';
  end if;
  return null;
end $$;

-- ── Reading ─────────────────────────────────────────────────────────────────

-- Everything live, for the home page and the Checklists page. Admins also get
-- the notes nobody has read yet, and lists that were ignored or missed.
create or replace function public.chk_live()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_me uuid := auth.uid(); v_role text := chk_my_role();
begin
  if v_role is null then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object(
    'ok', true, 'now', now(),
    'me', jsonb_build_object('role', v_role, 'label', chk_person_label(v_me)),
    'runs', coalesce((
      select jsonb_agg(chk_run_json(r.id, v_role, v_me) order by r.anchor_at, r.created_at)
        from chk_runs r
       where r.status = 'open' and r.opens_at <= now() and chk_visible(r.id, v_role, v_me)), '[]'::jsonb),
    'notes', case when v_role <> 'admin' then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'item_id', i.id, 'run_id', r.id, 'run_title', r.title, 'context', r.context,
        'title', i.title, 'state', i.state, 'comment', i.comment, 'by', i.done_by_name, 'at', i.done_at)
        order by i.done_at desc)
        from chk_run_items i join chk_runs r on r.id = i.run_id
       where i.comment is not null and i.comment <> '' and i.seen_at is null and i.state <> 'open'
         and i.done_at > now() - interval '30 days'), '[]'::jsonb) end,
    'closed', case when v_role <> 'admin' then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'run_id', r.id, 'title', r.title, 'context', r.context, 'status', r.status,
        'by', r.closed_by_name, 'reason', r.reason, 'at', r.closed_at,
        'left', (select count(*) from chk_run_items i where i.run_id = r.id and i.state = 'open'))
        order by r.closed_at desc)
        from chk_runs r
       where r.status in ('ignored', 'missed') and r.seen_at is null
         and r.closed_at > now() - interval '30 days'), '[]'::jsonb) end);
end $$;

create or replace function public.chk_run_get(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_me uuid := auth.uid(); v_role text := chk_my_role();
begin
  if v_role is null then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if not exists (select 1 from chk_runs where id = p_id) then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if not chk_visible(p_id, v_role, v_me) then return jsonb_build_object('ok', false, 'error', 'not_yours'); end if;
  return jsonb_build_object('ok', true, 'run', chk_run_json(p_id, v_role, v_me));
end $$;

-- Finished, missed, cancelled and ignored lists from the last p_days.
create or replace function public.chk_past(p_days integer default 60)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_me uuid := auth.uid(); v_role text := chk_my_role();
begin
  if v_role is null then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true, 'runs', coalesce((
    select jsonb_agg(chk_run_json(x.id, v_role, v_me) order by x.closed_at desc)
      from (select r.id, r.closed_at from chk_runs r
             where r.status <> 'open'
               and r.closed_at > now() - make_interval(days => least(greatest(coalesce(p_days, 60), 1), 400))
               and chk_visible(r.id, v_role, v_me)
             order by r.closed_at desc limit 200) x), '[]'::jsonb));
end $$;

-- Who an item can go to: each office login by name, then the groups.
create or replace function public.chk_people()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if chk_my_role() is null then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true, 'people',
    coalesce((select jsonb_agg(jsonb_build_object('who', 'person:' || p.id, 'label', chk_person_label(p.id)) order by lower(p.name))
                from profiles p where p.active and p.role = 'admin'), '[]'::jsonb)
    || jsonb_build_array(
         jsonb_build_object('who', 'role:admin', 'label', 'Office'),
         jsonb_build_object('who', 'role:bar', 'label', 'Bar'),
         jsonb_build_object('who', 'role:cleaner', 'label', 'Housekeeping'),
         jsonb_build_object('who', 'anyone', 'label', 'Anyone')));
end $$;

-- ── Working through a list ──────────────────────────────────────────────────

-- p_state: 'done', 'note' (done, with a comment — the comment is required),
-- 'na' (not applicable, comment optional) or 'open' (untick: whoever ticked
-- it, or an admin). The last item finished finishes the list; an untick on a
-- finished list opens it again. Ignored, missed and cancelled lists are shut.
create or replace function public.chk_tick(p_item uuid, p_state text, p_comment text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid(); v_role text := chk_my_role();
  v_item chk_run_items%rowtype; v_run chk_runs%rowtype;
  v_comment text := nullif(trim(coalesce(p_comment, '')), '');
  v_left integer;
begin
  if v_role is null then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if p_state not in ('done', 'note', 'na', 'open') then return jsonb_build_object('ok', false, 'error', 'bad_state'); end if;
  select * into v_item from chk_run_items where id = p_item;
  if v_item.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select * into v_run from chk_runs where id = v_item.run_id for update;
  if not chk_visible(v_run.id, v_role, v_me) then return jsonb_build_object('ok', false, 'error', 'not_yours'); end if;
  if v_run.status not in ('open', 'done') then
    return jsonb_build_object('ok', false, 'error', 'closed', 'status', v_run.status);
  end if;
  if p_state = 'note' and v_comment is null then return jsonb_build_object('ok', false, 'error', 'comment_needed'); end if;
  if length(coalesce(v_comment, '')) > 1000 then return jsonb_build_object('ok', false, 'error', 'comment_too_long'); end if;

  if p_state = 'open' then
    if v_item.state = 'open' then return jsonb_build_object('ok', true, 'run', chk_run_json(v_run.id, v_role, v_me)); end if;
    if v_role <> 'admin' and v_item.done_by is distinct from v_me then
      return jsonb_build_object('ok', false, 'error', 'not_your_tick');
    end if;
    update chk_run_items set state = 'open', done_at = null, done_by = null, done_by_name = null,
                             comment = null, seen_at = null
     where id = p_item;
  else
    update chk_run_items set state = p_state, done_at = now(), done_by = v_me,
                             done_by_name = chk_person_label(v_me),
                             comment = case when p_state = 'done' then null else v_comment end,
                             seen_at = null
     where id = p_item;
  end if;

  select count(*) into v_left from chk_run_items where run_id = v_run.id and state = 'open';
  if v_left = 0 and v_run.status = 'open' then
    update chk_runs set status = 'done', closed_at = now(), closed_by = v_me, closed_by_name = chk_person_label(v_me)
     where id = v_run.id;
  elsif v_left > 0 and v_run.status = 'done' then
    update chk_runs set status = 'open', closed_at = null, closed_by = null, closed_by_name = null where id = v_run.id;
  end if;
  return jsonb_build_object('ok', true, 'run', chk_run_json(v_run.id, v_role, v_me));
end $$;

-- Set a whole list aside. Anyone on staff; their name is kept.
create or replace function public.chk_ignore(p_run uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid(); v_role text := chk_my_role(); v_run chk_runs%rowtype;
begin
  if v_role is null then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  select * into v_run from chk_runs where id = p_run for update;
  if v_run.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if not chk_visible(p_run, v_role, v_me) then return jsonb_build_object('ok', false, 'error', 'not_yours'); end if;
  if v_run.status <> 'open' then return jsonb_build_object('ok', false, 'error', 'closed', 'status', v_run.status); end if;
  update chk_runs set status = 'ignored', closed_at = now(), closed_by = v_me, closed_by_name = chk_person_label(v_me),
                      reason = left(nullif(trim(coalesce(p_reason, '')), ''), 300), seen_at = null
   where id = p_run;
  return jsonb_build_object('ok', true);
end $$;

-- An admin brings back a list that was ignored or missed.
create or replace function public.chk_restore(p_run uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_run chk_runs%rowtype;
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  select * into v_run from chk_runs where id = p_run for update;
  if v_run.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_run.status not in ('ignored', 'missed') then return jsonb_build_object('ok', false, 'error', 'not_restorable'); end if;
  update chk_runs set status = 'open', closed_at = null, closed_by = null, closed_by_name = null, reason = null, seen_at = null
   where id = p_run;
  return jsonb_build_object('ok', true);
end $$;

-- An admin has read these comments / these ignored or missed lists.
create or replace function public.chk_seen(p_items uuid[] default '{}', p_runs uuid[] default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  update chk_run_items set seen_at = now() where id = any(coalesce(p_items, '{}')) and seen_at is null;
  update chk_runs set seen_at = now() where id = any(coalesce(p_runs, '{}')) and seen_at is null;
  return jsonb_build_object('ok', true);
end $$;

-- ── Templates (admin) ───────────────────────────────────────────────────────

create or replace function public.chk_templates_list()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  return jsonb_build_object('ok', true, 'templates', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id, 'title', t.title, 'active', t.active, 'trig', t.trig, 'items', t.items,
      'default_due_min', t.default_due_min, 'fire_from', t.fire_from, 'updated_at', t.updated_at,
      'open_runs', (select count(*) from chk_runs r where r.template_id = t.id and r.status = 'open'),
      'last_fired', (select max(r.created_at) from chk_runs r where r.template_id = t.id))
      order by lower(t.title))
    from chk_templates t where not t.deleted), '[]'::jsonb));
end $$;

-- Create (no id) or replace a template. Items are
-- [{id, title, detail, who, due_min}] — who: anyone | role:admin|bar|cleaner |
-- person:<profile id>; due_min minutes from the anchor, null = the default.
create or replace function public.chk_template_save(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_id uuid; v_old chk_templates%rowtype;
  v_title text := trim(coalesce(p->>'title', ''));
  v_trig jsonb := p->'trig';
  v_err text;
  v_items jsonb := '[]'::jsonb;
  v_def integer;
  it jsonb; v_who text; v_due jsonb; n integer := 0;
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  if v_title = '' or length(v_title) > 120 then return jsonb_build_object('ok', false, 'error', 'Give the list a title (up to 120 letters).'); end if;
  v_err := chk_trigger_error(v_trig);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  if jsonb_typeof(p->'default_due_min') = 'number' then
    v_def := (p->>'default_due_min')::numeric::integer;
    if abs(v_def) > 86400 then return jsonb_build_object('ok', false, 'error', 'The usual due time must be within 60 days.'); end if;
  else v_def := 0; end if;
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then
    return jsonb_build_object('ok', false, 'error', 'Add at least one item.');
  end if;
  if jsonb_array_length(p->'items') > 40 then return jsonb_build_object('ok', false, 'error', 'Keep a list to 40 items or fewer.'); end if;

  for it in select value from jsonb_array_elements(p->'items') loop
    n := n + 1;
    if trim(coalesce(it->>'title', '')) = '' or length(trim(it->>'title')) > 200 then
      return jsonb_build_object('ok', false, 'error', 'Item ' || n || ' needs a title (up to 200 letters).');
    end if;
    if length(coalesce(it->>'detail', '')) > 1000 then
      return jsonb_build_object('ok', false, 'error', 'Item ' || n || ': the detail is too long.');
    end if;
    v_who := coalesce(it->>'who', 'anyone');
    if v_who !~ '^(anyone|role:(admin|bar|cleaner)|person:[0-9a-f-]{36})$' then
      return jsonb_build_object('ok', false, 'error', 'Item ' || n || ': choose who does it.');
    end if;
    if v_who like 'person:%' and not exists (select 1 from profiles where id::text = substr(v_who, 8) and active and role in ('admin', 'bar', 'cleaner')) then
      return jsonb_build_object('ok', false, 'error', 'Item ' || n || ': that person no longer has a login.');
    end if;
    v_due := it->'due_min';
    if v_due is not null and jsonb_typeof(v_due) <> 'null' then
      if jsonb_typeof(v_due) <> 'number' or abs((v_due::text)::numeric) > 86400 then
        return jsonb_build_object('ok', false, 'error', 'Item ' || n || ': the due time must be within 60 days.');
      end if;
      v_due := to_jsonb((v_due::text)::numeric::integer);
    else v_due := 'null'::jsonb; end if;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'id', coalesce(nullif(it->>'id', ''), substr(md5(random()::text || clock_timestamp()::text), 1, 10)),
      'title', trim(it->>'title'),
      'detail', nullif(trim(coalesce(it->>'detail', '')), ''),
      'who', v_who, 'due_min', v_due));
  end loop;

  if nullif(p->>'id', '') is null then
    insert into chk_templates (title, active, trig, items, default_due_min, created_by, updated_by)
    values (v_title, coalesce((p->>'active')::boolean, true), v_trig, v_items, v_def, v_me, v_me)
    returning id into v_id;
  else
    select * into v_old from chk_templates where id = (p->>'id')::uuid and not deleted for update;
    if v_old.id is null then return jsonb_build_object('ok', false, 'error', 'That list has been deleted.'); end if;
    update chk_templates set
      title = v_title, trig = v_trig, items = v_items, default_due_min = v_def,
      active = coalesce((p->>'active')::boolean, active),
      fire_from = case when v_old.trig is distinct from v_trig
                         or (not v_old.active and coalesce((p->>'active')::boolean, v_old.active))
                       then now() else fire_from end,
      updated_at = now(), updated_by = v_me
     where id = v_old.id;
    v_id := v_old.id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- Deleting keeps the row (lists already made still name it); live lists stay.
create or replace function public.chk_template_delete(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  update chk_templates set deleted = true, active = false, updated_at = now(), updated_by = auth.uid() where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- Copy a template's items into a new list (the worker and Start now).
create or replace function public.chk_make_items(p_run uuid, p_tpl chk_templates, p_anchor timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into chk_run_items (run_id, position, title, detail, who, who_label, due_min, due_at)
  select p_run, x.ord::integer, x.it->>'title', x.it->>'detail', x.it->>'who', chk_who_label(x.it->>'who'),
         coalesce((x.it->>'due_min')::integer, p_tpl.default_due_min),
         p_anchor + make_interval(mins => coalesce((x.it->>'due_min')::integer, p_tpl.default_due_min))
    from jsonb_array_elements(p_tpl.items) with ordinality as x(it, ord);
end $$;

-- Start a list now, whatever its trigger. Admin.
create or replace function public.chk_start_now(p_template uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_t chk_templates%rowtype; v_run uuid; v_name text;
begin
  if not wp_is_admin() then return jsonb_build_object('ok', false, 'error', 'not_admin'); end if;
  select * into v_t from chk_templates where id = p_template and not deleted;
  if v_t.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  v_name := chk_person_label(auth.uid());
  insert into chk_runs (template_id, trig_kind, anchor_key, anchor_at, opens_at, title, context, started_by_name)
  values (v_t.id, 'manual', 'manual:' || gen_random_uuid(), now(), now(), v_t.title, 'Started by ' || v_name, v_name)
  returning id into v_run;
  perform chk_make_items(v_run, v_t, now());
  return jsonb_build_object('ok', true, 'run_id', v_run);
end $$;

-- ── The worker (service role only) ──────────────────────────────────────────

create or replace function public.chk_worker_state()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'now', now(),
    'templates', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'trig', t.trig, 'fire_from', t.fire_from))
                            from chk_templates t where t.active and not t.deleted), '[]'::jsonb),
    'open_runs', coalesce((select jsonb_agg(jsonb_build_object(
                              'id', r.id, 'template_id', r.template_id, 'anchor_key', r.anchor_key,
                              'anchor_at', r.anchor_at, 'context', r.context,
                              'touched', exists (select 1 from chk_run_items i where i.run_id = r.id and i.state <> 'open')))
                            from chk_runs r where r.status = 'open' and r.template_id is not null and r.trig_kind <> 'manual'), '[]'::jsonb));
$$;

-- p: { fire: [{template_id, anchor_key, anchor_at, opens_at, context, link}],
--      retime: [{run_id, anchor_at, opens_at, context, link}],
--      cancel: [run_id] }
-- Fire: only an active template, only an anchor at or after its fire_from,
-- only once it has opened. A key already used does nothing — unless that list
-- was cancelled by the system (its booking vanished and came back), when it
-- opens again. A new weekly or monthly list marks the one before it Missed.
-- Retime and cancel touch only open lists nobody has ticked anything on.
create or replace function public.chk_worker_apply(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  f jsonb; v_t chk_templates%rowtype; v_run uuid; v_at timestamptz; v_open timestamptz;
  n_fired integer := 0; n_reopened integer := 0; n_retimed integer := 0; n_cancelled integer := 0; n_missed integer := 0; n_skipped integer := 0;
  k integer;
begin
  for f in select value from jsonb_array_elements(coalesce(p->'fire', '[]'::jsonb)) loop
    select * into v_t from chk_templates where id = (f->>'template_id')::uuid and active and not deleted;
    v_at := (f->>'anchor_at')::timestamptz; v_open := (f->>'opens_at')::timestamptz;
    if v_t.id is null or v_at is null or v_open is null or v_at < v_t.fire_from or v_open > now() + interval '2 minutes'
       or coalesce(f->>'anchor_key', '') = '' then
      n_skipped := n_skipped + 1; continue;
    end if;
    v_run := null;
    insert into chk_runs (template_id, trig_kind, anchor_key, anchor_at, opens_at, title, context, link)
    values (v_t.id, v_t.trig->>'kind', f->>'anchor_key', v_at, v_open, v_t.title,
            left(f->>'context', 300), case when jsonb_typeof(f->'link') = 'object' then f->'link' end)
    on conflict (template_id, anchor_key) where template_id is not null do nothing
    returning id into v_run;
    if v_run is not null then
      perform chk_make_items(v_run, v_t, v_at);
      n_fired := n_fired + 1;
      if v_t.trig->>'kind' in ('weekly', 'monthly') then
        update chk_runs set status = 'missed', closed_at = now(), closed_by = null, closed_by_name = 'Not finished in time',
                            reason = 'The next one started', seen_at = null
         where template_id = v_t.id and status = 'open' and id <> v_run and anchor_at < v_at;
        get diagnostics k = row_count; n_missed := n_missed + k;
      end if;
    else
      update chk_runs r set status = 'open', closed_at = null, closed_by_name = null, reason = null,
                            anchor_at = v_at, opens_at = v_open, context = left(f->>'context', 300)
       where r.template_id = v_t.id and r.anchor_key = f->>'anchor_key'
         and r.status = 'cancelled' and r.closed_by is null
         and not exists (select 1 from chk_run_items i where i.run_id = r.id and i.state <> 'open')
      returning r.id into v_run;
      if v_run is not null then
        update chk_run_items set due_at = v_at + make_interval(mins => due_min) where run_id = v_run;
        n_reopened := n_reopened + 1;
      end if;
    end if;
  end loop;

  for f in select value from jsonb_array_elements(coalesce(p->'retime', '[]'::jsonb)) loop
    v_at := (f->>'anchor_at')::timestamptz; v_open := (f->>'opens_at')::timestamptz;
    if v_at is null or v_open is null then continue; end if;
    update chk_runs r set anchor_at = v_at, opens_at = v_open,
                          context = coalesce(left(f->>'context', 300), r.context),
                          link = case when jsonb_typeof(f->'link') = 'object' then f->'link' else r.link end
     where r.id = (f->>'run_id')::uuid and r.status = 'open'
       and not exists (select 1 from chk_run_items i where i.run_id = r.id and i.state <> 'open')
    returning r.id into v_run;
    if found then
      update chk_run_items set due_at = v_at + make_interval(mins => due_min) where run_id = (f->>'run_id')::uuid;
      n_retimed := n_retimed + 1;
    end if;
  end loop;

  update chk_runs r set status = 'cancelled', closed_at = now(), closed_by = null, closed_by_name = null,
                        reason = 'What it was for has been cancelled or removed'
   where r.id in (select (value #>> '{}')::uuid from jsonb_array_elements(coalesce(p->'cancel', '[]'::jsonb)))
     and r.status = 'open' and r.trig_kind <> 'manual'
     and not exists (select 1 from chk_run_items i where i.run_id = r.id and i.state <> 'open');
  get diagnostics n_cancelled = row_count;

  return jsonb_build_object('ok', true, 'fired', n_fired, 'reopened', n_reopened, 'retimed', n_retimed,
                            'cancelled', n_cancelled, 'missed', n_missed, 'skipped', n_skipped);
end $$;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Supabase grants EXECUTE on every new function to anon AND authenticated.

revoke all on function public.wp_admin_set_pay_bar(integer, boolean) from public, anon, authenticated;
revoke all on function public.chk_my_role() from public, anon, authenticated;
revoke all on function public.chk_person_label(uuid) from public, anon, authenticated;
revoke all on function public.chk_who_label(text) from public, anon, authenticated;
revoke all on function public.chk_is_mine(text, text, uuid) from public, anon, authenticated;
revoke all on function public.chk_visible(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.chk_run_json(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.chk_trigger_error(jsonb) from public, anon, authenticated;
revoke all on function public.chk_live() from public, anon, authenticated;
revoke all on function public.chk_run_get(uuid) from public, anon, authenticated;
revoke all on function public.chk_past(integer) from public, anon, authenticated;
revoke all on function public.chk_people() from public, anon, authenticated;
revoke all on function public.chk_tick(uuid, text, text) from public, anon, authenticated;
revoke all on function public.chk_ignore(uuid, text) from public, anon, authenticated;
revoke all on function public.chk_restore(uuid) from public, anon, authenticated;
revoke all on function public.chk_seen(uuid[], uuid[]) from public, anon, authenticated;
revoke all on function public.chk_templates_list() from public, anon, authenticated;
revoke all on function public.chk_template_save(jsonb) from public, anon, authenticated;
revoke all on function public.chk_template_delete(uuid) from public, anon, authenticated;
revoke all on function public.chk_make_items(uuid, public.chk_templates, timestamptz) from public, anon, authenticated;
revoke all on function public.chk_start_now(uuid) from public, anon, authenticated;
revoke all on function public.chk_worker_state() from public, anon, authenticated;
revoke all on function public.chk_worker_apply(jsonb) from public, anon, authenticated;

grant execute on function public.wp_admin_set_pay_bar(integer, boolean) to authenticated, service_role;
grant execute on function public.chk_live() to authenticated, service_role;
grant execute on function public.chk_run_get(uuid) to authenticated, service_role;
grant execute on function public.chk_past(integer) to authenticated, service_role;
grant execute on function public.chk_people() to authenticated, service_role;
grant execute on function public.chk_tick(uuid, text, text) to authenticated, service_role;
grant execute on function public.chk_ignore(uuid, text) to authenticated, service_role;
grant execute on function public.chk_restore(uuid) to authenticated, service_role;
grant execute on function public.chk_seen(uuid[], uuid[]) to authenticated, service_role;
grant execute on function public.chk_templates_list() to authenticated, service_role;
grant execute on function public.chk_template_save(jsonb) to authenticated, service_role;
grant execute on function public.chk_template_delete(uuid) to authenticated, service_role;
grant execute on function public.chk_start_now(uuid) to authenticated, service_role;
grant execute on function public.chk_worker_state() to service_role;
grant execute on function public.chk_worker_apply(jsonb) to service_role;

commit;
