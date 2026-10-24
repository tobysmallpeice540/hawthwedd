-- supabase/2026-10-24k-checklist-fixed-dates.sql
--
-- A checklist item can fall on the same day each year rather than so many days
-- before the wedding (`due_md`, "MM-DD"). Its date is the last such day BEFORE
-- the wedding: an interim payment on 15 January, for a June wedding, is the
-- 15 January of that year; for a January 10th wedding, the year before.
--
-- Adds "Interim payment due" on 15 January to the template, and to the three
-- events that already have their checklist. Patched in place; safe to re-run.

begin;

create or replace function pg_temp.patch_fn(p_sig regprocedure, p_find text, p_repl text)
returns void language plpgsql as $$
declare d text := pg_get_functiondef(p_sig); n integer;
begin
  if position(p_repl in d) > 0 then
    raise notice 'patch of % already applied — skipped', p_sig;
    return;
  end if;
  n := (length(d) - length(replace(d, p_find, ''))) / length(p_find);
  if n <> 1 then
    raise exception 'patch of % expected the anchor exactly once, found % times: %', p_sig, n, p_find;
  end if;
  execute replace(d, p_find, p_repl);
end $$;

alter table wp_checklist_template add column if not exists due_md text
  check (due_md is null or due_md ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$');

-- The last MM-DD strictly before the event. 29 Feb in a common year falls on
-- 28 Feb rather than erroring.
create or replace function public.wp_fixed_due(p_event date, p_md text)
returns date language sql immutable set search_path = public as $$
  select case when p_event is null or p_md is null then null else (
    select case when d < p_event then d else
             make_date(y - 1, m, least(dd, extract(day from (make_date(y - 1, m, 1) + interval '1 month - 1 day'))::int)) end
      from (select y, m, dd,
                   make_date(y, m, least(dd, extract(day from (make_date(y, m, 1) + interval '1 month - 1 day'))::int)) as d
              from (select extract(year from p_event)::int as y, split_part(p_md, '-', 1)::int as m,
                           split_part(p_md, '-', 2)::int as dd) a) b) end
$$;
revoke all on function public.wp_fixed_due(date, text) from public, anon, authenticated;

select pg_temp.patch_fn('public.wp_get_checklist()'::regprocedure,
  $f$case when v_date is null then null else v_date - t.days_before end$f$,
  $r$case when v_date is null then null when t.due_md is not null then wp_fixed_due(v_date, t.due_md) else v_date - t.days_before end$r$);

select pg_temp.patch_fn('public.wp_admin_templates()'::regprocedure,
  $f$'days_before', c.days_before, 'sort', c.sort)$f$,
  $r$'days_before', c.days_before, 'due_md', c.due_md, 'sort', c.sort)$r$);

select pg_temp.patch_fn('public.wp_admin_save_checklist_template(jsonb)'::regprocedure,
  $f$  delete from wp_checklist_template;$f$,
  $r$  if exists (select 1 from jsonb_array_elements(p_rows) e
              where nullif(trim(coalesce(e ->> 'due_md', '')), '') is not null
                and (e ->> 'due_md') !~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$')
  then
    return jsonb_build_object('ok', false, 'error', 'bad_due_md');
  end if;

  delete from wp_checklist_template;$r$);
select pg_temp.patch_fn('public.wp_admin_save_checklist_template(jsonb)'::regprocedure,
  $f$  insert into wp_checklist_template (id, title, detail, days_before, sort)$f$,
  $r$  insert into wp_checklist_template (id, title, detail, days_before, sort, due_md)$r$);
select pg_temp.patch_fn('public.wp_admin_save_checklist_template(jsonb)'::regprocedure,
  $f$         coalesce((e ->> 'sort')::int, ord * 10)$f$,
  $r$         coalesce((e ->> 'sort')::int, ord * 10),
         nullif(trim(coalesce(e ->> 'due_md', '')), '')$r$);

insert into wp_checklist_template (id, title, detail, days_before, sort, due_md)
select coalesce((select max(id) from wp_checklist_template), 0) + 1, 'Interim payment due', null, 0, 65, '01-15'
 where not exists (select 1 from wp_checklist_template where title = 'Interim payment due');

-- Events whose checklist is already seeded get it too, dated from their own day.
insert into wp_checklist (event_id, title, detail, due_on, source, locked, sort)
select c.event_id, 'Interim payment due', null,
       wp_fixed_due((select nullif(e ->> 'date', '')::date
                       from app_data d, lateral jsonb_array_elements(d.value) e
                      where d.key = 'hawthbush_bookings_v6' and (e ->> 'id')::int = c.event_id limit 1), '01-15'),
       'venue', true, 65
  from (select distinct event_id from wp_checklist where source = 'venue') c
 where not exists (select 1 from wp_checklist x where x.event_id = c.event_id and x.title = 'Interim payment due');

do $check$
begin
  if wp_fixed_due('2027-06-12', '01-15') <> '2027-01-15' then raise exception 'fixed due: June'; end if;
  if wp_fixed_due('2027-01-10', '01-15') <> '2026-01-15' then raise exception 'fixed due: early January'; end if;
  if wp_fixed_due('2027-01-15', '01-15') <> '2026-01-15' then raise exception 'fixed due: same day'; end if;
  if wp_fixed_due('2027-06-12', '02-29') <> '2027-02-28' then raise exception 'fixed due: leap day'; end if;
end $check$;

commit;
