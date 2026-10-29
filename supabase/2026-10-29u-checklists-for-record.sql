-- 2026-10-29u — a letting's or event's own checklists.
--
-- Every list started by a letting, an event, a ticketed event or a clean
-- carries `link` = { kind, id } (netlify/functions/checklists/plan.js). This
-- reads them back for one record, so the letting and the event form can show
-- the lists that record started, live and finished.
--
-- Staff only, visibility as everywhere else (chk_visible). Lists the system
-- cancelled (a booking moved or went) are left out; lists not yet open are
-- included, so the office can see what is coming.

begin;

create index if not exists chk_runs_link on public.chk_runs ((link->>'kind'), (link->>'id'))
  where link is not null;

create or replace function public.chk_for_record(p_kind text, p_id text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_me uuid := auth.uid(); v_role text := chk_my_role();
begin
  if v_role is null then return jsonb_build_object('ok', false, 'error', 'not_staff'); end if;
  if p_kind is null or p_kind not in ('accom', 'event', 'box', 'enquiry') or coalesce(p_id, '') = '' then
    return jsonb_build_object('ok', false, 'error', 'bad_record');
  end if;
  return jsonb_build_object('ok', true, 'now', now(), 'runs', coalesce((
    select jsonb_agg(chk_run_json(x.id, v_role, v_me) order by x.anchor_at, x.created_at)
      from (select r.id, r.anchor_at, r.created_at from chk_runs r
             where r.link is not null
               and r.link->>'kind' = p_kind and r.link->>'id' = p_id
               and r.status <> 'cancelled'
               and chk_visible(r.id, v_role, v_me)
             order by r.anchor_at desc
             limit 100) x), '[]'::jsonb));
end $$;

-- Supabase grants EXECUTE on every new function to anon AND authenticated.
revoke all on function public.chk_for_record(text, text) from public, anon, authenticated;
grant execute on function public.chk_for_record(text, text) to authenticated, service_role;

commit;
