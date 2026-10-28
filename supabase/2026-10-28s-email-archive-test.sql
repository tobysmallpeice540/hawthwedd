-- supabase/2026-10-28s-email-archive-test.sql
--
-- Assertions for 2026-10-28s-email-archive.sql. Run against a SCRATCH database
-- AFTER the migration, with stand-ins for the roles (anon, authenticated,
-- service_role), airbnb_mail_state, and wp_is_admin() reading the session
-- setting t.role ('admin' | 'bar' | ''). Each block raises on failure; all
-- passing prints "email archive: all assertions passed".

do $t$
declare v jsonb; n int;
begin
  delete from email_messages; delete from email_archive_seen; delete from email_archive_addresses;

  -- 1. Ingest stores messages, seen ids and finished addresses; twice is once.
  v := email_ingest(jsonb_build_object(
    'messages', jsonb_build_array(
      jsonb_build_object('gmail_id', 'g1', 'thread_id', 't1', 'rfc_id', '<a@x>', 'sent_at', '2025-03-01T10:00:00Z',
        'direction', 'in', 'from_addr', 'Amy@Example.com', 'from_name', 'Amy', 'to_addrs', jsonb_build_array('hello@hawthbushfarm.co.uk'),
        'addrs', jsonb_build_array('Amy@Example.com'), 'subject', 'Our wedding', 'body', 'Hello',
        'attachments', jsonb_build_array(jsonb_build_object('part', '1', 'name', 'plan.pdf', 'mime', 'application/pdf', 'size', 90000))),
      jsonb_build_object('gmail_id', 'g2', 'thread_id', 't1', 'sent_at', '2025-03-02T10:00:00Z', 'direction', 'out',
        'from_addr', 'hawthbushfarm@gmail.com', 'addrs', jsonb_build_array('amy@example.com'), 'subject', 'Re: Our wedding',
        'body', 'Thanks', 'body_html', '<p>not kept</p>'),
      jsonb_build_object('gmail_id', 'app:9', 'sent_at', '2025-03-03T10:00:00Z', 'direction', 'app', 'addrs', jsonb_build_array('bob@example.com'),
        'subject', 'Your booking', 'body', 'Booked', 'body_html', '<p>Booked</p>', 'kind', 'booking_confirmed', 'ref', 'A123'),
      jsonb_build_object('gmail_id', 'bad', 'sent_at', '2025-03-03T10:00:00Z', 'direction', 'sideways')),
    'seen', jsonb_build_array('s1', 's2'),
    'addresses_done', jsonb_build_array(jsonb_build_object('addr', 'AMY@example.com', 'found', 2))));
  if (v->>'messages')::int <> 3 or (v->>'seen')::int <> 2 or (v->>'addresses')::int <> 1 then raise exception '1 ingest counts %', v; end if;
  v := email_ingest(jsonb_build_object('messages', jsonb_build_array(jsonb_build_object('gmail_id', 'g1', 'sent_at', '2025-03-01T10:00:00Z', 'direction', 'in', 'subject', 'changed'))));
  if (v->>'messages')::int <> 0 or (select subject from email_messages where gmail_id = 'g1') <> 'Our wedding' then raise exception '1b a stored message was changed'; end if;
  if (select addrs from email_messages where gmail_id = 'g1') <> array['amy@example.com'] then raise exception '1c addresses not lower-cased'; end if;
  if (select body_html from email_messages where gmail_id = 'g2') is not null then raise exception '1d html kept for a Gmail email'; end if;
  if (select addr from email_archive_addresses) <> 'amy@example.com' then raise exception '1e address not lower-cased'; end if;

  -- 2. The same email under another Gmail id (a forwarded or second copy) is skipped.
  v := email_ingest(jsonb_build_object('messages', jsonb_build_array(jsonb_build_object('gmail_id', 'g1-copy', 'rfc_id', '<a@x>',
        'sent_at', '2025-03-01T10:00:00Z', 'direction', 'in', 'addrs', jsonb_build_array('amy@example.com')))));
  if (v->>'messages')::int <> 0 then raise exception '2 second copy stored'; end if;

  -- 3. Only an admin reads; a bar login is staff but not admin.
  perform set_config('t.role', 'bar', true);
  if (email_admin_messages(array['amy@example.com'])->>'ok')::boolean then raise exception '3 bar login read emails'; end if;
  if (email_admin_status()->>'ok')::boolean then raise exception '3b bar login read status'; end if;
  perform set_config('t.role', 'admin', true);
  v := email_admin_messages(array[' Amy@Example.COM ']);
  if jsonb_array_length(v->'messages') <> 2 then raise exception '3c wrong emails: %', v; end if;
  if v->'messages'->0->>'id' <> 'g2' then raise exception '3d not newest first'; end if;
  if v->'messages'->1->'atts'->0->>'name' <> 'plan.pdf' then raise exception '3e attachments missing'; end if;
  -- by booking id, for the app's own emails
  v := email_admin_messages(array[]::text[], 'A123');
  if jsonb_array_length(v->'messages') <> 1 or v->'messages'->0->>'html' <> '<p>Booked</p>' then raise exception '3f by ref: %', v; end if;
  v := email_admin_messages(array['nobody@example.com']);
  if jsonb_array_length(v->'messages') <> 0 then raise exception '3g a stranger''s emails'; end if;
  v := email_admin_status();
  if (v->>'messages')::int <> 2 or (v->>'app_messages')::int <> 1 or (v->>'addresses_done')::int <> 1 then raise exception '3h status %', v; end if;

  -- 4. Purge: two years, and never anybody on the keep list.
  insert into email_messages (gmail_id, sent_at, direction, addrs) values
    ('old-enq', now() - interval '800 days', 'in', array['gone@example.com']),
    ('old-kept', now() - interval '800 days', 'in', array['amy@example.com', 'gone@example.com']),
    ('old-ref', now() - interval '800 days', 'app', array['x@example.com']),
    ('new-enq', now() - interval '100 days', 'in', array['gone@example.com']);
  update email_messages set ref = 'A123' where gmail_id = 'old-ref';
  insert into email_archive_seen (gmail_id, seen_at) values ('s-old', now() - interval '90 days');
  begin
    perform email_purge(array[]::text[], now() - interval '730 days');
    raise exception '4 purged with an empty keep list';
  exception when others then
    if sqlerrm not like '%addresses to keep%' then raise; end if;
  end;
  begin
    perform email_purge(array['amy@example.com'], now() - interval '30 days');
    raise exception '4b purged younger than two years';
  exception when others then
    if sqlerrm not like '%two years%' then raise; end if;
  end;
  n := email_purge(array['AMY@example.com', 'A123'], now() - interval '730 days');
  if n <> 1 or exists (select 1 from email_messages where gmail_id = 'old-enq') then raise exception '4c purge removed % (wanted old-enq only)', n; end if;
  if not exists (select 1 from email_messages where gmail_id = 'old-kept') or not exists (select 1 from email_messages where gmail_id = 'old-ref')
     or not exists (select 1 from email_messages where gmail_id = 'new-enq') then raise exception '4d purge removed a kept email'; end if;
  if exists (select 1 from email_archive_seen where gmail_id = 's-old') or not exists (select 1 from email_archive_seen where gmail_id = 's1') then raise exception '4e seen ids'; end if;

  -- 5. Grants: nothing for a client but the two admin reads.
  if has_function_privilege('authenticated', 'email_ingest(jsonb)', 'execute') then raise exception '5 ingest open'; end if;
  if has_function_privilege('anon', 'email_admin_messages(text[],text)', 'execute') then raise exception '5b anon read'; end if;
  if has_table_privilege('authenticated', 'email_messages', 'select') then raise exception '5c table open'; end if;

  raise notice 'email archive: all assertions passed';
end $t$;
