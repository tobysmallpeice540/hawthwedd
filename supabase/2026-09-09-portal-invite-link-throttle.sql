-- supabase/2026-09-09-portal-invite-link-throttle.sql
--
-- APPLIED 9 September 2026.
--
-- WHY
--
-- Sign-in links are minted and sent by netlify/functions/portal-auth.js rather
-- than by Supabase's own mailer, which is unbranded, heavily rate-limited and
-- lands in spam often enough that a couple would simply never get in.
--
-- That function needs one question answered before it sends anything:
--
--   "Does this address have portal access, and have we sent it a link in the
--    last minute?"
--
-- It has to be answered in the database, not in the function, for two reasons.
-- The sign-in form is public, so the answer decides whether a stranger can make
-- us send email to an arbitrary address — and the throttle has to survive a
-- concurrent second request, which only a row update can do.
--
-- WHAT IT ANSWERS, AND WHAT THE CALLER DOES WITH IT
--
--   {ok:false, reason:'not_invited'}   no access row, or it was revoked
--   {ok:false, reason:'too_soon'}      a link went out less than p_min_seconds ago
--   {ok:true,  event_id:<int>}         send it, and log it against this event
--
-- The public sign-in path answers the browser identically whichever of these
-- comes back, so the form cannot be used to discover which addresses are on the
-- system. The staff invite path shows the reason, because staff are allowed to
-- know and need to be told why nothing was sent.
--
-- last_link_sent_at is written BEFORE the email is attempted, deliberately. A
-- send that fails therefore still costs the minute. Two links in a row is the
-- worse outcome: the first invalidates the second, so a couple clicking an
-- older email gets a dead link and no explanation.
--
-- SECURITY. service_role only — the function runs behind the service key. It is
-- not callable by anon or authenticated, verified below. Supabase's default
-- privileges grant EXECUTE on every new function in `public` to anon AND
-- authenticated, so both are revoked by name; revoking from `public` alone does
-- not do it. See CLAUDE.md.

begin;

alter table public.wp_access add column if not exists last_link_sent_at timestamptz;

create or replace function public.wp_may_send_link(p_email text, p_min_seconds integer default 60)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  a wp_access%rowtype;
begin
  select * into a from wp_access
   where email = v_email and revoked_at is null
   order by invited_at desc limit 1;

  if a.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_invited');
  end if;
  if a.last_link_sent_at is not null
     and a.last_link_sent_at > now() - make_interval(secs => greatest(1, p_min_seconds)) then
    return jsonb_build_object('ok', false, 'reason', 'too_soon');
  end if;

  update wp_access set last_link_sent_at = now() where id = a.id;
  return jsonb_build_object('ok', true, 'event_id', a.event_id);
end;
$function$;

revoke all on function public.wp_may_send_link(text, integer) from public;
revoke all on function public.wp_may_send_link(text, integer) from anon;
revoke all on function public.wp_may_send_link(text, integer) from authenticated;
grant execute on function public.wp_may_send_link(text, integer) to service_role;

do $verify$
declare n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='wp_access' and column_name='last_link_sent_at';
  if n <> 1 then raise exception 'wp_access.last_link_sent_at missing'; end if;

  if has_function_privilege('anon', 'public.wp_may_send_link(text,integer)', 'execute')
     or has_function_privilege('authenticated', 'public.wp_may_send_link(text,integer)', 'execute') then
    raise exception 'wp_may_send_link is callable by a browser - refusing';
  end if;
  if not has_function_privilege('service_role', 'public.wp_may_send_link(text,integer)', 'execute') then
    raise exception 'service_role cannot execute wp_may_send_link';
  end if;

  raise notice 'verified: wp_may_send_link is service_role only';
end
$verify$;

commit;

-- ── Rollback ────────────────────────────────────────────────────────────────
-- Dropping the function stops every sign-in link, including for couples already
-- using the portal. There is no gentle version of this.
--
-- begin;
--   drop function if exists public.wp_may_send_link(text, integer);
--   alter table public.wp_access drop column if exists last_link_sent_at;
-- commit;
