-- supabase/2026-11-07f-todo-repeat-day.sql
--
-- Repeats keep their day (Toby, 7 Nov 2026): weekly = the same day of the
-- week; monthly = the same day of the month, or the month's last day when it
-- has fewer (the 30th → 28 Feb → 30 Mar, never stuck on the 28th).
--
-- Before this, each next one counted from the previous one's day, so a
-- monthly to-do on the 31st became the 28th after February and stayed there.
-- Now every repeat carries the day it was set for (`repeat_from`, the
-- deadline as typed) and the next one is the first day the rule gives from
-- THAT, after today and after the one being ticked.
--
-- `repeat_from` is set when the to-do is added, and again whenever its
-- deadline or its rule is changed (the typed day becomes the new anchor);
-- an edit that leaves both alone keeps it — an older tab included.
--
-- Function bodies are patched by anchors read out of the catalogue (each
-- must appear exactly once). Safe to run twice: a patched body has no anchor
-- left and is skipped.

alter table public.todo_items add column if not exists repeat_from date;
update public.todo_items set repeat_from = deadline where repeat is not null and repeat_from is null;

do $m$
declare
  def text;
  fn text;
  pairs text[][];
  i int;
  done_mark text;
begin
  for fn in select unnest(array['todo_item_json', 'todo_upsert', 'todo_set_state']) loop
    select pg_get_functiondef(p.oid) into def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = fn;
    if def is null then raise exception '% is missing', fn; end if;
    if fn = 'todo_item_json' then
      done_mark := $a$'repeatFrom'$a$;
      pairs := array[array[$a$'repeat', i.repeat, 'urgent'$a$, $a$'repeat', i.repeat, 'repeatFrom', i.repeat_from, 'urgent'$a$]];
    elsif fn = 'todo_upsert' then
      done_mark := 'repeat_from';
      pairs := array[
        array[$a$priority, repeat, set_on, deadline, event_on, photos,$a$,
              $a$priority, repeat, repeat_from, set_on, deadline, event_on, photos,$a$],
        array[$a$v_priority, v_repeat, v_today, v_deadline,$a$,
              $a$v_priority, v_repeat, case when v_repeat is not null then v_deadline end, v_today, v_deadline,$a$],
        array[$a$      deadline = v_deadline, photos = v_photos, private = v_private,$a$,
              $a$      -- The day a repeat keeps (migration 2026-11-07f): the typed deadline
      -- whenever the deadline or the rule changes, otherwise the one it had.
      repeat_from = case
        when (case when p ? 'repeat' then v_repeat else v_old.repeat end) is null then null
        when v_old.repeat_from is not null and v_deadline is not distinct from v_old.deadline
             and (case when p ? 'repeat' then v_repeat else v_old.repeat end) is not distinct from v_old.repeat then v_old.repeat_from
        else v_deadline end,
      deadline = v_deadline, photos = v_photos, private = v_private,$a$]];
    else
      done_mark := 'repeat_from';
      pairs := array[
        array[$a$tags, priority, repeat, set_on, deadline,$a$,
              $a$tags, priority, repeat, repeat_from, set_on, deadline,$a$],
        array[$a$v_item.priority, v_item.repeat, v_today,$a$,
              $a$v_item.priority, v_item.repeat, coalesce(v_item.repeat_from, v_item.deadline), v_today,$a$],
        array[$a$todo_next_on(coalesce(v_item.deadline, v_today), v_item.repeat, v_today),$a$,
              $a$todo_next_on(coalesce(v_item.repeat_from, v_item.deadline, v_today), v_item.repeat,
                           greatest(v_today, coalesce(v_item.deadline, v_today))),$a$]];
    end if;
    if position(done_mark in def) > 0 then
      raise notice '% already patched', fn;
      continue;
    end if;
    for i in 1 .. array_length(pairs, 1) loop
      if (length(def) - length(replace(def, pairs[i][1], ''))) / length(pairs[i][1]) <> 1 then
        raise exception '% anchor % not found exactly once', fn, i;
      end if;
      def := replace(def, pairs[i][1], pairs[i][2]);
    end loop;
    execute def;
  end loop;
end $m$;
