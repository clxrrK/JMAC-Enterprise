-- Applicant notifications: recovering the ones that gave up.
--
-- Ten production notifications each spent five attempts on Brevo refusing the
-- Edge Function's IP address. Fixing Brevo does not restart them -- the worker
-- only takes rows under five attempts -- so they come back only by a person's
-- decision. These are the rules that decision runs under:
--
--   only named rows, at most fifty, carrying the failure the caller expects
--   never a row Brevo may already have (sent, accepted, or in a worker's hands)
--   never a row the worker is still retrying on its own
--   the same notification afterwards -- id, dedupe key, event and payload --
--   with its prior state copied to a log first
--   an outdated notice can be withheld, and a withheld one is not swept back
--   an [acceptance_unknown] row Brevo turns out to have can be recorded as sent
--   none of it is reachable from a browser session
--
-- Run (with the migration applied):
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/applicant_notification_recovery_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written, and nothing
-- leaves: pg_net only sends what a committed transaction queued.

begin;

do $$
declare
  admin_id uuid; applicant_id uuid; posting_id uuid; app_id uuid;
  dept_id uuid; pos_id uuid;
  ip_row uuid; key_row uuid; sent_row uuid; accepted_row uuid;
  retrying_row uuid; stale_row uuid; outdated_row uuid;
  r record; n integer; txt text;
  queue_mark bigint; queued_after integer;
  before public.applicant_notification_outbox;
  after_ public.applicant_notification_outbox;
  tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  -- Brevo's words, as the production rows carry them (IP from the
  -- documentation range, not a real one).
  ip_error text := 'HTTP 401: {"message":"We have detected you are using an unrecognised IP address 2001:db8::7. If you performed this action make sure to add the new IP address in this link: https://app.brevo.com/security/authorised_ips","code":"unauthorized"}';
  key_error text := 'HTTP 401: {"message":"Key not found","code":"unauthorized"}';
  parked timestamptz := now() + interval '365 days';
begin
  select id into admin_id from public.profiles where role = 'admin' and status = 'active' limit 1;
  select p.id, p.department_id into pos_id, dept_id from public.positions p limit 1;
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);

  insert into public.applicants (first_name, last_name, email)
  values ('ZZ', 'Recovery ' || tag, 'zz.recovery.' || tag || '@jmac-test.invalid')
  returning id into applicant_id;
  insert into public.job_postings (department_id, position_id, description)
  values (dept_id, pos_id, 'ZZ recovery posting') returning id into posting_id;
  insert into public.applications (applicant_id, job_posting_id, status)
  values (applicant_id, posting_id, 'submitted') returning id into app_id;

  -- One row per state worth refusing or accepting. Direct inserts: these are
  -- states the worker leaves behind, not notifications anyone is sending.
  insert into public.applicant_notification_outbox
    (application_id, event_type, dedupe_key, recipient_email, recipient_name,
     status, attempts, last_error, next_attempt_at, payload)
  values (app_id, 'interview_scheduled', 'zz-ip-' || tag, 'zz@jmac-test.invalid', 'ZZ',
          'failed', 5, ip_error, parked, '{"reference_code":"REF-ZZ","position":"Cashier"}')
  returning id into ip_row;

  insert into public.applicant_notification_outbox
    (application_id, event_type, dedupe_key, recipient_email, recipient_name,
     status, attempts, last_error, next_attempt_at)
  values (app_id, 'application_shortlisted', 'zz-key-' || tag, 'zz@jmac-test.invalid', 'ZZ',
          'failed', 5, key_error, parked)
  returning id into key_row;

  insert into public.applicant_notification_outbox
    (application_id, event_type, dedupe_key, recipient_email, recipient_name,
     status, attempts, sent_at, provider_message_id)
  values (app_id, 'offer_sent', 'zz-sent-' || tag, 'zz@jmac-test.invalid', 'ZZ',
          'sent', 1, now() - interval '1 hour', '<zz-sent@smtp-relay.brevo.com>')
  returning id into sent_row;

  -- Inconsistent on purpose: failed, yet Brevo gave it a message id.
  insert into public.applicant_notification_outbox
    (application_id, event_type, dedupe_key, recipient_email, recipient_name,
     status, attempts, last_error, next_attempt_at, provider_message_id)
  values (app_id, 'application_hired', 'zz-accepted-' || tag, 'zz@jmac-test.invalid', 'ZZ',
          'failed', 5, ip_error, parked, '<zz-accepted@smtp-relay.brevo.com>')
  returning id into accepted_row;

  insert into public.applicant_notification_outbox
    (application_id, event_type, dedupe_key, recipient_email, recipient_name,
     status, attempts, last_error, next_attempt_at)
  values (app_id, 'interview_rescheduled', 'zz-retrying-' || tag, 'zz@jmac-test.invalid', 'ZZ',
          'failed', 2, ip_error, now() + interval '5 minutes')
  returning id into retrying_row;

  insert into public.applicant_notification_outbox
    (application_id, event_type, dedupe_key, recipient_email, recipient_name,
     status, attempts, last_error, next_attempt_at, claimed_at)
  values (app_id, 'interview_cancelled', 'zz-stale-' || tag, 'zz@jmac-test.invalid', 'ZZ',
          'failed', 1,
          '[acceptance_unknown] A worker claimed this notification and stopped before recording what Brevo said.',
          parked, now() - interval '2 hours')
  returning id into stale_row;

  insert into public.applicant_notification_outbox
    (application_id, event_type, dedupe_key, recipient_email, recipient_name,
     status, attempts, last_error, next_attempt_at)
  values (app_id, 'application_rejected', 'zz-outdated-' || tag, 'zz@jmac-test.invalid', 'ZZ',
          'failed', 5, ip_error, parked)
  returning id into outdated_row;

  -- ======================================================================
  -- 1. A recovery is a reviewed list, not a sweep
  -- ======================================================================
  begin
    perform public.requeue_applicant_notifications(array[ip_row], '%', 'retry after Brevo fix');
    raise exception 'FAIL 1a a bare wildcard was accepted as the expected error';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  begin
    perform public.requeue_applicant_notifications(array[ip_row], '%%_%%', 'retry after Brevo fix');
    raise exception 'FAIL 1a a pattern of only wildcards was accepted';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  raise notice 'PASS  1a "requeue everything that failed" cannot be expressed';

  begin
    perform public.requeue_applicant_notifications(
      (select array_agg(gen_random_uuid()) from generate_series(1, 51)),
      '%unrecognised IP%', 'retry after Brevo fix');
    raise exception 'FAIL 1b fifty-one notifications were taken in one call';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  raise notice 'PASS  1b at most fifty per call';

  begin
    perform public.requeue_applicant_notifications(array[ip_row], '%unrecognised IP%', '  ');
    raise exception 'FAIL 1c a requeue with no reason was accepted';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  raise notice 'PASS  1c a requeue must say why';

  -- ======================================================================
  -- 2. What it refuses, and leaves exactly as it was
  -- ======================================================================
  select * into before from public.applicant_notification_outbox where id = ip_row;
  select * into r from public.requeue_applicant_notifications(
    array[ip_row], '%Key not found%', 'wrong failure named');
  if r.requeued or r.detail not like '%not the one named%' then
    raise exception 'FAIL 2a a row with a different error was requeued: %', r.detail;
  end if;
  select * into after_ from public.applicant_notification_outbox where id = ip_row;
  if after_.attempts <> 5 or after_.status <> 'failed' or after_.last_error <> before.last_error then
    raise exception 'FAIL 2a a refused row was changed anyway';
  end if;
  raise notice 'PASS  2a only the failure the caller named is requeued; others are untouched';

  select * into r from public.requeue_applicant_notifications(
    array[sent_row], '%unrecognised IP%', 'should not happen');
  if r.requeued or r.detail not like '%provider message id%' then
    raise exception 'FAIL 2b a sent notification was requeued: %', r.detail;
  end if;
  select * into r from public.requeue_applicant_notifications(
    array[accepted_row], '%unrecognised IP%', 'should not happen');
  if r.requeued or r.detail not like '%provider message id%' then
    raise exception 'FAIL 2b a notification Brevo accepted was requeued: %', r.detail;
  end if;
  raise notice 'PASS  2b nothing Brevo already has is requeued -- that would send it twice';

  select * into r from public.requeue_applicant_notifications(
    array[retrying_row], '%unrecognised IP%', 'should not happen');
  if r.requeued or r.detail not like '%still being retried%' then
    raise exception 'FAIL 2c a row inside its retry window was reset: %', r.detail;
  end if;
  raise notice 'PASS  2c a row the worker is still retrying is left to the worker';

  select * into r from public.requeue_applicant_notifications(
    array[gen_random_uuid()], '%unrecognised IP%', 'should not happen');
  if r.requeued or r.detail <> 'no such notification' then
    raise exception 'FAIL 2d an unknown id was not reported: %', r.detail;
  end if;
  raise notice 'PASS  2d an unknown id is reported, not ignored';

  -- ======================================================================
  -- 3. Requeueing: the same notification, a fresh budget, a record kept
  -- ======================================================================
  select * into before from public.applicant_notification_outbox where id = ip_row;
  -- Clear the once-per-transaction nudge guard the application insert above
  -- set, so this call's own nudge is observable.
  perform set_config('jmac.notify_nudged', '', true);
  select coalesce(max(id), 0) into queue_mark from net.http_request_queue;

  select * into r from public.requeue_applicant_notifications(
    array[ip_row], '%unrecognised IP%', 'Brevo unknown-IP blocking lifted for API keys');
  if not r.requeued then raise exception 'FAIL 3a the expected row was refused: %', r.detail; end if;

  select * into after_ from public.applicant_notification_outbox where id = ip_row;
  if after_.status <> 'pending' or after_.attempts <> 0 or after_.last_error is not null
     or after_.next_attempt_at > now() or after_.claimed_at is not null then
    raise exception 'FAIL 3a the requeued row is not due with a fresh budget';
  end if;
  if after_.dedupe_key <> before.dedupe_key or after_.event_type <> before.event_type
     or after_.payload <> before.payload or after_.application_id <> before.application_id
     or after_.recipient_email <> before.recipient_email then
    raise exception 'FAIL 3a requeueing changed what the notification is';
  end if;
  raise notice 'PASS  3a due now with a fresh budget -- and still the same notification';

  select count(*) into n from public.applicant_notification_recovery_log l
   where l.outbox_id = ip_row and l.action = 'requeued' and l.prior_status = 'failed'
     and l.prior_attempts = 5 and l.prior_last_error = ip_error
     and l.prior_next_attempt_at = before.next_attempt_at
     and l.reason = 'Brevo unknown-IP blocking lifted for API keys'
     and l.acted_by = current_user;
  if n <> 1 then raise exception 'FAIL 3b the prior state was not recorded'; end if;
  raise notice 'PASS  3b its five attempts and Brevo''s error are kept in the log';

  select count(*) into queued_after from net.http_request_queue where id > queue_mark;
  if queued_after <> 1 then
    raise exception 'FAIL 3c the requeue queued % worker request(s), expected 1', queued_after;
  end if;
  select count(*) into n from net.http_request_queue
   where id > queue_mark and url like '%/functions/v1/send-applicant-notifications'
     and headers::text like '%x-jmac-notify-token%';
  if n <> 1 then raise exception 'FAIL 3c the nudge did not go to the protected worker'; end if;
  raise notice 'PASS  3c it asks the worker to run, through the same protected path as an HR action';

  -- What the worker's own filter sees: due, under budget, claimable.
  select count(*) into n from public.applicant_notification_outbox
   where id = ip_row and status in ('pending', 'failed')
     and next_attempt_at <= now() and attempts < 5;
  if n <> 1 then raise exception 'FAIL 3d the worker would not pick the row up'; end if;
  raise notice 'PASS  3d the worker''s due filter now takes it';

  select * into r from public.requeue_applicant_notifications(
    array[ip_row], '%unrecognised IP%', 'twice');
  if r.requeued then raise exception 'FAIL 3e a pending row was requeued a second time'; end if;
  raise notice 'PASS  3e requeueing is not repeatable on a row already waiting';

  -- ======================================================================
  -- 4. Withholding an outdated notice
  -- ======================================================================
  select * into r from public.withhold_applicant_notifications(
    array[outdated_row], 'superseded: application has since moved on');
  if not r.withheld then raise exception 'FAIL 4a the outdated row was not withheld: %', r.detail; end if;
  select * into after_ from public.applicant_notification_outbox where id = outdated_row;
  if after_.status <> 'failed' or after_.last_error not like '[withheld] superseded%'
     or after_.next_attempt_at < now() + interval '50 years' then
    raise exception 'FAIL 4a the withheld row is not parked with its reason';
  end if;
  select count(*) into n from public.applicant_notification_recovery_log
   where outbox_id = outdated_row and action = 'withheld' and prior_last_error = ip_error;
  if n <> 1 then raise exception 'FAIL 4a the withholding was not logged with the prior error'; end if;
  raise notice 'PASS  4a an outdated notice is withheld, with the reason written down';

  select * into r from public.requeue_applicant_notifications(
    array[outdated_row], '%unrecognised IP%', 'sweep');
  if r.requeued then
    raise exception 'FAIL 4b a withheld notice was swept back by the IP recovery';
  end if;
  raise notice 'PASS  4b a withheld notice is not swept back up by the same recovery';

  select * into r from public.withhold_applicant_notifications(array[sent_row], 'pointless');
  if r.withheld then raise exception 'FAIL 4c a sent notification was withheld'; end if;
  raise notice 'PASS  4c a sent notification cannot be withheld';

  -- ======================================================================
  -- 5. Recording an acceptance found in Brevo's log
  -- ======================================================================
  txt := public.record_applicant_notification_accepted(
    stale_row, '<zz-found@smtp-relay.brevo.com>', now() - interval '2 hours',
    'found in Brevo transactional log');
  if txt <> 'recorded as accepted' then raise exception 'FAIL 5a %', txt; end if;
  select * into after_ from public.applicant_notification_outbox where id = stale_row;
  if after_.status <> 'sent' or after_.provider_message_id <> '<zz-found@smtp-relay.brevo.com>'
     or after_.last_error is not null or after_.sent_at is null then
    raise exception 'FAIL 5a the found acceptance was not recorded';
  end if;
  select count(*) into n from public.applicant_notification_recovery_log
   where outbox_id = stale_row and action = 'recorded_accepted'
     and prior_last_error like '[acceptance_unknown]%';
  if n <> 1 then raise exception 'FAIL 5a the reconciliation was not logged'; end if;
  raise notice 'PASS  5a an [acceptance_unknown] row found in Brevo''s log reads as sent, and why';

  txt := public.record_applicant_notification_accepted(
    key_row, '<zz-guess@smtp-relay.brevo.com>', now() - interval '1 hour', 'a guess');
  if txt not like 'only a notification parked as [acceptance_unknown]%' then
    raise exception 'FAIL 5b an ordinary failure was marked sent: %', txt;
  end if;
  raise notice 'PASS  5b only an outcome that was genuinely unknown can be recorded this way';

  begin
    perform public.record_applicant_notification_accepted(
      key_row, '<zz@x>', now() + interval '1 day', 'future');
    raise exception 'FAIL 5c an acceptance in the future was recorded';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  raise notice 'PASS  5c an acceptance cannot be dated in the future';

  -- ======================================================================
  -- 6. None of it from a browser session
  -- ======================================================================
  set local role authenticated;
  begin
    perform public.requeue_applicant_notifications(array[key_row], '%Key not found%', 'x');
    raise exception 'FAIL 6a a signed-in user requeued a notification';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.withhold_applicant_notifications(array[key_row], 'x');
    raise exception 'FAIL 6a a signed-in user withheld a notification';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.record_applicant_notification_accepted(key_row, '<x>', now(), 'x');
    raise exception 'FAIL 6a a signed-in user recorded a delivery';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.applicant_notification_recovery_log limit 1;
    raise exception 'FAIL 6b a signed-in user read the recovery log';
  exception when insufficient_privilege then null;
  end;
  reset role;
  raise notice 'PASS  6a-b requeue, withhold, record and the log are not reachable by a session';

  perform set_config('request.jwt.claims', '', true);
  set local role anon;
  begin
    perform public.requeue_applicant_notifications(array[key_row], '%Key not found%', 'x');
    raise exception 'FAIL 6c anon requeued a notification';
  exception when insufficient_privilege then null;
  end;
  reset role;
  raise notice 'PASS  6c nor by anon';

  if not has_function_privilege('service_role',
       'public.requeue_applicant_notifications(uuid[], text, text)', 'execute') then
    raise exception 'FAIL 6d the service role cannot run the recovery';
  end if;
  raise notice 'PASS  6d the service role can, for a scripted recovery';

  select string_agg(column_name, ', ' order by column_name) into txt
    from information_schema.columns
   where table_schema = 'public' and table_name = 'applicant_notification_recovery_log'
     and column_name in ('recipient_email', 'recipient_name', 'payload');
  if txt is not null then raise exception 'FAIL 6e the recovery log copies: %', txt; end if;
  raise notice 'PASS  6e the log holds no recipient, name or message content';
end $$;

rollback;
