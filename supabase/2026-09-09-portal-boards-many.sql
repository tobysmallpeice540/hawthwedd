-- supabase/2026-09-09-portal-boards-many.sql
--
-- APPLIED 9 September 2026 as migration portal_boards_many.
-- Assertions: portal-boards-test.sql — 12, all passing.
--
-- One board per wedding was the wrong shape almost immediately. The farm keeps
-- boards of its own worth showing everybody, and a couple collects several —
-- flowers, tables, dresses. wp_event_meta held exactly zero rows, so this
-- replaces the single-URL pair outright rather than migrating anything.
--
-- ONE TABLE, TWO OWNERS. wp_boards.event_id is NULL for the farm's own boards
-- and the wedding's id for a couple's. That single decision is what makes
-- wp_delete_board() safe with no extra check: it deletes
--
--     where id = p_id and event_id = wp_my_event_id()
--
-- and a farm board's NULL event_id is never equal to anything, so a couple
-- cannot delete one even though they can see it. Assertion 7 pins that,
-- because it is the kind of property that reads as an accident.
--
-- THE URL RULE LIVES IN ONE PLACE, wp_is_board_url(), because it is enforced on
-- three paths and a rule written out three times is a rule that will eventually
-- disagree with itself. Only https, only Pinterest's own domains. Staff click
-- these links from the admin side, so an unchecked one is somewhere to hang a
-- phishing page wearing the farm's branding. The regex anchors the host ending
-- at pinterest.<tld> immediately before the path, which is what refuses
-- pinterest.com.evil.example.com — the one a looser pattern lets through.
--
-- LINKS, NEVER EMBEDS, in both apps. Pinterest's board widget works by loading
-- their JavaScript into the page, and the portal holds a guest list, names,
-- access needs and a live session. That is a real trade for a prettier tab.
--
-- The admin save validates every row BEFORE deleting anything, so one bad
-- address rejects the batch rather than leaving the farm with half a list.

begin;

drop function if exists public.wp_get_pinterest();
drop function if exists public.wp_set_pinterest(text);
drop table if exists public.wp_event_meta;

create table if not exists public.wp_boards (
  id         uuid primary key default gen_random_uuid(),
  -- NULL means the farm's own board, shown on every wedding's tab.
  event_id   integer,
  label      text not null,
  url        text not null,
  sort       integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists wp_boards_event on public.wp_boards (event_id);
alter table public.wp_boards enable row level security;

create or replace function public.wp_is_board_url(p_url text)
 returns boolean
 language sql
 immutable
as $function$
  select coalesce(p_url, '') ~* '^https://([a-z0-9-]+\.)*pinterest\.[a-z.]{2,6}/[^\s]*$';
$function$;

create or replace function public.wp_get_boards()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare v_event integer := wp_my_event_id();
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  return jsonb_build_object(
    'ok', true,
    'venue', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'label', b.label, 'url', b.url)
                              order by b.sort, b.created_at)
                         from wp_boards b where b.event_id is null), '[]'::jsonb),
    'mine',  coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'label', b.label, 'url', b.url)
                              order by b.sort, b.created_at)
                         from wp_boards b where b.event_id = v_event), '[]'::jsonb)
  );
end;
$function$;

create or replace function public.wp_add_board(p_label text, p_url text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_event integer := wp_my_event_id();
  v_label text := nullif(trim(coalesce(p_label, '')), '');
  v_url   text := nullif(trim(coalesce(p_url, '')), '');
  v_id    uuid;
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if v_url is null or not wp_is_board_url(v_url) then
    return jsonb_build_object('ok', false, 'error', 'not_a_pinterest_link');
  end if;
  -- Eight is more boards than anyone needs and few enough that the tab stays a
  -- tab rather than becoming a list to scroll.
  if (select count(*) from wp_boards where event_id = v_event) >= 8 then
    return jsonb_build_object('ok', false, 'error', 'too_many_boards');
  end if;

  insert into wp_boards (event_id, label, url, sort)
  values (v_event, left(coalesce(v_label, 'Our board'), 60), left(v_url, 500),
          coalesce((select max(sort) + 10 from wp_boards where event_id = v_event), 0))
  returning id into v_id;

  perform wp_log('inspiration', 'added a board');
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$function$;

-- Takes a board id, so it must prove that board is the caller's own. The
-- `event_id = v_event` clause is the whole security of this function — and it
-- is also what stops a couple deleting the FARM's boards, whose event_id is
-- null and therefore never equal to anything.
create or replace function public.wp_delete_board(p_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare v_event integer := wp_my_event_id();
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  delete from wp_boards where id = p_id and event_id = v_event;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  perform wp_log('inspiration', 'removed a board');
  return jsonb_build_object('ok', true);
end;
$function$;

create or replace function public.wp_admin_boards()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  return jsonb_build_object('ok', true,
    'boards', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'label', b.label, 'url', b.url)
                               order by b.sort, b.created_at)
                          from wp_boards b where b.event_id is null), '[]'::jsonb));
end;
$function$;

create or replace function public.wp_admin_save_boards(p_rows jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare v_n integer := 0;
begin
  if not is_staff() then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'rows_not_an_array');
  end if;
  if jsonb_array_length(p_rows) > 12 then
    return jsonb_build_object('ok', false, 'error', 'too_many_boards');
  end if;
  -- Checked before anything is deleted, so a rejected save cannot leave the
  -- farm with no boards at all.
  if exists (select 1 from jsonb_array_elements(p_rows) e
              where not wp_is_board_url(e ->> 'url')) then
    return jsonb_build_object('ok', false, 'error', 'not_a_pinterest_link');
  end if;

  delete from wp_boards where event_id is null;

  insert into wp_boards (event_id, label, url, sort)
  select null, left(coalesce(nullif(trim(e ->> 'label'), ''), 'Hawthbush Farm'), 60),
         left(trim(e ->> 'url'), 500), ord * 10
    from jsonb_array_elements(p_rows) with ordinality as t(e, ord);

  get diagnostics v_n = row_count;
  perform wp_log('admin', 'saved the farm''s boards');
  return jsonb_build_object('ok', true, 'saved', v_n);
end;
$function$;

-- Supabase grants EXECUTE to anon AND authenticated by default on every new
-- function in `public`. Revoking from `public` alone does not do it.
revoke all on function public.wp_is_board_url(text)          from public, anon, authenticated;
revoke all on function public.wp_get_boards()                from public, anon, authenticated;
revoke all on function public.wp_add_board(text, text)       from public, anon, authenticated;
revoke all on function public.wp_delete_board(uuid)          from public, anon, authenticated;
revoke all on function public.wp_admin_boards()              from public, anon, authenticated;
revoke all on function public.wp_admin_save_boards(jsonb)    from public, anon, authenticated;

grant execute on function public.wp_get_boards()             to authenticated, service_role;
grant execute on function public.wp_add_board(text, text)    to authenticated, service_role;
grant execute on function public.wp_delete_board(uuid)       to authenticated, service_role;
grant execute on function public.wp_admin_boards()           to authenticated, service_role;
grant execute on function public.wp_admin_save_boards(jsonb) to authenticated, service_role;

commit;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- drop table if exists public.wp_boards cascade;
-- and drop the five functions. The Inspiration tab then shows nothing; nothing
-- else in the portal depends on it.
