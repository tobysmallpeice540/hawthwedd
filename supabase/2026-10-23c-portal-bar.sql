-- supabase/2026-10-23c-portal-bar.sql
--
-- The evening bar gets its own portal tab, separate from the drinks packages
-- and corkage.
--
--   * wp_drinks gains pay_bar (the client's "we would like a pay bar" tick)
--     and bar_usage (less / average / more than average — what the bar is
--     staffed from, alongside the evening adults).
--   * wp_save_bar_prefs() saves those and the bar rules, one at a time, as the
--     client changes them. There is no Save button on that page.
--   * Money behind the bar is no longer typed in by the client: they press
--     "Add now", pay on Stripe, and the page shows what staff have recorded as
--     received. wp_save_bar_tab is left in place for the old front end.
--   * A new section, 'bar', after 'drinks'. Every event type that showed
--     Drinks now shows the bar. Drinks itself is switched off as standard for
--     everything except weddings, because the packages are for weddings only
--     and the tab would otherwise be empty. Per-event Drinks ticks are copied
--     onto the bar.
--   * 'bar' can be marked "we're done" (wp_section_status) and logs under its
--     own change-log area, so "changed since" on the bar is about the bar.
--   * Corkage rounding, Toby 23 Oct: the allowance is rounded UP to a full
--     bottle without charge. Bringing 25 bottles of fizz against an allowance
--     of 146 drinks (24.3 bottles) costs nothing; a 26th is charged. Before,
--     the part bottle over was charged as a bottle. wp_drinks_summary is the
--     one place that arithmetic lives, so the client tab, staff panel and Xero
--     lines all follow.
--
-- Live functions are patched from the catalogue, never pasted: each anchor
-- must appear exactly once, and a patch already applied is skipped.
--
-- Order: push the front end FIRST. The current live portal draws a tab for
-- every visible section by name, and has no name for 'bar'.

begin;

-- ── columns ─────────────────────────────────────────────────────────────────
alter table public.wp_drinks add column if not exists pay_bar boolean;
alter table public.wp_drinks add column if not exists bar_usage text;
do $c$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.wp_drinks'::regclass
                  and conname = 'wp_drinks_bar_usage_check') then
    alter table public.wp_drinks add constraint wp_drinks_bar_usage_check
      check (bar_usage is null or bar_usage in ('less', 'average', 'more'));
  end if;
end $c$;

-- "We're done with this" on the bar.
alter table public.wp_section_status drop constraint if exists wp_section_status_section_check;
alter table public.wp_section_status add constraint wp_section_status_section_check
  check (section in ('guests','timeline','suppliers','layout','details','items','food','music','drinks','bar','uploads'));


-- ── patches to live functions ───────────────────────────────────────────────
do $patch$
declare
  v_def text;
  v_n   int;

  -- one patch: function, anchor, replacement, marker that says it is done
  rec record;
begin
  for rec in
    select * from (values
      ('public.wp_section_keys()'::regprocedure,
       $a$'guests','food','drinks','checklist',$a$,
       $b$'guests','food','drinks','bar','checklist',$b$,
       $m$'drinks','bar'$m$),
      ('public.wp_section_area(text)'::regprocedure,
       $a$    when 'drinks'    then 'drinks'
$a$,
       $b$    when 'drinks'    then 'drinks'
    when 'bar'       then 'bar'
$b$,
       $m$when 'bar'$m$),
      ('public.wp_get_drinks()'::regprocedure,
       $a$'bar_paid_amount', d.bar_paid_amount, 'bar_paid_at', d.bar_paid_at,$a$,
       $b$'bar_paid_amount', d.bar_paid_amount, 'bar_paid_at', d.bar_paid_at,
      'pay_bar', d.pay_bar, 'bar_usage', d.bar_usage,$b$,
       $m$'pay_bar', d.pay_bar$m$),
      -- Corkage: round the allowance up to a full bottle, free. The bottle
      -- that runs past the allowance is not charged; only whole bottles
      -- beyond it are.
      ('public.wp_drinks_summary(integer)'::regprocedure,
       $a$v_line_over := ceil((l.qty * l.drinks_per_unit - v_left) / l.drinks_per_unit);$a$,
       $b$v_line_over := floor((l.qty * l.drinks_per_unit - v_left) / l.drinks_per_unit);$b$,
       $m$v_line_over := floor($m$),
      ('public.wp_drinks_summary(integer)'::regprocedure,
       $a$            v_left := 0;
            if l.unit_price is null then$a$,
       $b$            v_left := 0;
            if v_line_over = 0 then
              null;  -- only the part bottle that finished the allowance: on us
            elsif l.unit_price is null then$b$,
       $m$if v_line_over = 0 then$m$),
      ('public.wp_drinks_summary(integer)'::regprocedure,
       $a$A part-bottle over is charged as a bottle.$a$,
       $b$The bottle that runs past the allowance is free (we round up to a full bottle); only whole bottles beyond it are charged.$b$,
       $m$we round up to a full bottle$m$)
    ) as t(fn, anchor, replacement, marker)
  loop
    v_def := pg_get_functiondef(rec.fn);
    if position(rec.marker in v_def) > 0 then
      raise notice '% already patched, skipped', rec.fn;
      continue;
    end if;
    v_n := (length(v_def) - length(replace(v_def, rec.anchor, ''))) / length(rec.anchor);
    if v_n <> 1 then
      raise exception 'patch anchor for % found % times, expected exactly 1 — nothing changed', rec.fn, v_n;
    end if;
    execute replace(v_def, rec.anchor, rec.replacement);
  end loop;
end $patch$;


-- ── client: the bar choices ─────────────────────────────────────────────────
-- NULL leaves a field alone, so each control saves just itself. An empty
-- usage or rules clears it. Not part of the drinks lock: the bar is planned
-- and topped up up to the day.
create or replace function public.wp_save_bar_prefs(p_pay_bar boolean default null,
    p_usage text default null, p_rules text default null)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_event integer := wp_my_event_id();
begin
  if v_event is null then return jsonb_build_object('ok', false, 'error', 'no_access'); end if;
  if p_usage is not null and p_usage not in ('', 'less', 'average', 'more') then
    return jsonb_build_object('ok', false, 'error', 'bad_usage');
  end if;
  insert into wp_drinks (event_id, updated_at, updated_by)
  values (v_event, now(), lower(coalesce(auth.jwt() ->> 'email', '')))
  on conflict (event_id) do nothing;
  update wp_drinks set
    pay_bar   = coalesce(p_pay_bar, pay_bar),
    bar_usage = case when p_usage is null then bar_usage else nullif(p_usage, '') end,
    bar_rules = case when p_rules is null then bar_rules
                     else left(nullif(trim(p_rules), ''), 500) end,
    updated_at = now(),
    updated_by = lower(coalesce(auth.jwt() ->> 'email', ''))
  where event_id = v_event;
  perform wp_log('bar',
    case when p_pay_bar is true then 'would like a pay bar'
         when p_pay_bar is false then 'does not want a pay bar'
         when p_usage is not null then 'expects ' || coalesce(nullif(p_usage, ''), 'no particular') || ' bar use'
         else 'changed the bar rules' end);
  return jsonb_build_object('ok', true);
end $function$;

do $grants$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'wp_save_bar_prefs'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $grants$;


-- ── sections: the bar gets its own tab ──────────────────────────────────────
-- Only on the first run. Running this again must not undo a choice Toby has
-- since made in Sections (for instance switching Drinks back on for parties).
do $sections$
begin
  if exists (select 1 from wp_section_defaults where section = 'bar') then
    raise notice 'bar section already set up, skipped';
    return;
  end if;

  insert into wp_section_defaults (event_type, section, shown)
  select event_type, 'bar', shown from wp_section_defaults where section = 'drinks'
  on conflict (event_type, section) do nothing;

  update wp_section_defaults set shown = false
   where section = 'drinks' and event_type <> 'Wedding';

  insert into wp_event_sections (event_id, section, shown)
  select event_id, 'bar', shown from wp_event_sections where section = 'drinks'
  on conflict (event_id, section) do nothing;
end $sections$;

commit;
