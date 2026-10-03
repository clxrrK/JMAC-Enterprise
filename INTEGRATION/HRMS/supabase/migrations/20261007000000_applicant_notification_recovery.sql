-- Applicant notifications: recovering the ones that gave up
--
-- Ten notifications in production each spent all five attempts on one cause:
-- Brevo refusing the Edge Function's IP address (HTTP 401, "unrecognised IP
-- address"). Edge Functions have no fixed egress IP, so once Brevo's
-- unknown-IP blocking was on, the worker's requests were refused from every
-- new address -- and the worker, unable to tell a refusal of the server from a
-- failure of the message, retried each row until its budget was gone. The
-- worker now stops on such a refusal without charging the row. This file is
-- for the rows it already charged.
--
-- Fixing Brevo does not restart them. The worker only takes rows with fewer
-- than five attempts, so an exhausted row stays exhausted until a person
-- decides otherwise. That decision is what these functions record.
--
-- The rules they enforce:
--
--   Only named rows. Each call takes explicit ids -- never "all failed" -- and
--   at most fifty, so a recovery is a list somebody read, not a sweep.
--
--   Only the expected failure. The caller states the error they expect each
--   row to carry, and a row whose recorded error does not match is refused. A
--   bare wildcard is refused too.
--
--   Never anything Brevo may already have. A row with a provider message id,
--   a sent time, or a sent status is refused: requeueing it would send it twice.
--
--   Nothing is lost. Each row keeps its id, its dedupe key, its event type and
--   its payload. What it looked like before -- status, attempts, the provider's
--   error -- is copied into a log first, so resetting it for a retry erases
--   nothing an operator might need later.
--
-- Outdated notices -- an interview time that has since moved, an offer since
-- withdrawn -- are WITHHELD, not requeued: recorded as a decision, with a
-- reason, so a later recovery cannot sweep them up by accident.
--
-- Nothing here sends anything. Requeueing makes a row due and asks the worker
-- to run, exactly as an HR action does; the worker's own claim, token and
-- provider checks all still apply.

-- ----------------------------------------------------------- the record
create table if not exists public.applicant_notification_recovery_log (
  id bigint generated always as identity primary key,
  outbox_id uuid not null
    references public.applicant_notification_outbox(id) on delete cascade,
  action text not null check (action in ('requeued', 'withheld', 'recorded_accepted')),
  reason text not null check (length(btrim(reason)) > 0),
  -- The row as it stood before the decision. No recipient, name or payload:
  -- the outbox row still holds those, and this table exists so nobody needs to
  -- copy them anywhere else.
  prior_status public.applicant_notification_status not null,
  prior_attempts integer not null,
  prior_last_error text,
  prior_next_attempt_at timestamptz,
  prior_claimed_at timestamptz,
  prior_provider_message_id text,
  acted_at timestamptz not null default now(),
  -- The database role that ran it. Recovery is an operator action from the SQL
  -- editor or a service-role client, not something a signed-in user does.
  acted_by text not null default current_user
);

create index if not exists idx_applicant_notification_recovery_log_outbox
  on public.applicant_notification_recovery_log (outbox_id);

comment on table public.applicant_notification_recovery_log is
  'Operator decisions on applicant notifications the worker gave up on: requeued, withheld, '
  'or recorded as accepted after checking Brevo. Holds each row''s prior state. No recipient '
  'or message content.';

-- Operators only. RLS on with no policy, and no grant to the API roles.
alter table public.applicant_notification_recovery_log enable row level security;
revoke all on public.applicant_notification_recovery_log from public, anon, authenticated;
grant select on public.applicant_notification_recovery_log to service_role;

-- ------------------------------------------------------------ shared guard
--
-- What every decision first checks. Returns null when the row may be acted on,
-- or the reason it may not.
create or replace function public.applicant_notification_recovery_refusal(
  _row public.applicant_notification_outbox
)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select case
    when _row.provider_message_id is not null then
      'Brevo already accepted this notification (it has a provider message id); acting on it again could send it twice'
    when _row.sent_at is not null or _row.status = 'sent' then
      'this notification is recorded as sent'
    when _row.status = 'processing' then
      'a worker holds this notification right now'
    else null
  end;
$fn$;

revoke all on function public.applicant_notification_recovery_refusal(public.applicant_notification_outbox)
  from public, anon, authenticated;

-- ---------------------------------------------------------------- requeue
create or replace function public.requeue_applicant_notifications(
  _ids uuid[],
  _expected_error text,
  _reason text
)
returns table (outbox_id uuid, requeued boolean, detail text)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _id uuid;
  _row public.applicant_notification_outbox;
  _refusal text;
  _any boolean := false;
begin
  if _reason is null or length(btrim(_reason)) = 0 then
    raise exception 'Say why these notifications are being requeued.';
  end if;
  if _ids is null or cardinality(_ids) = 0 then
    raise exception 'Name the notifications to requeue.';
  end if;
  if cardinality(_ids) > 50 then
    raise exception 'At most fifty notifications per call; recovery is a reviewed list, not a sweep.';
  end if;
  -- The expected failure must actually say something. '%' would match every
  -- error there is, which is the "requeue all failed" this exists to prevent.
  if _expected_error is null or length(replace(replace(_expected_error, '%', ''), '_', '')) < 5 then
    raise exception 'State the error these notifications are expected to carry, e.g. %%unrecognised IP%%.';
  end if;

  foreach _id in array (select array_agg(distinct x) from unnest(_ids) x) loop
    select * into _row from public.applicant_notification_outbox o where o.id = _id for update;

    if not found then
      outbox_id := _id; requeued := false; detail := 'no such notification';
      return next; continue;
    end if;

    _refusal := public.applicant_notification_recovery_refusal(_row);
    if _refusal is null and _row.status <> 'failed' then
      _refusal := format('status is %s; only a failed notification can be requeued', _row.status);
    end if;
    -- Still inside its normal retry window: the worker will try it itself.
    if _refusal is null and _row.attempts < 5 and _row.next_attempt_at <= now() + interval '1 day' then
      _refusal := 'it is still being retried by the worker';
    end if;
    if _refusal is null and (_row.last_error is null or _row.last_error not ilike _expected_error) then
      _refusal := 'its recorded error is not the one named for this recovery';
    end if;

    if _refusal is not null then
      outbox_id := _id; requeued := false; detail := _refusal;
      return next; continue;
    end if;

    insert into public.applicant_notification_recovery_log (
      outbox_id, action, reason, prior_status, prior_attempts, prior_last_error,
      prior_next_attempt_at, prior_claimed_at, prior_provider_message_id)
    values (
      _row.id, 'requeued', btrim(_reason), _row.status, _row.attempts, _row.last_error,
      _row.next_attempt_at, _row.claimed_at, _row.provider_message_id);

    -- A fresh budget, due now. id, dedupe_key, event_type and payload are
    -- untouched, so this is the same notification, not a new one.
    update public.applicant_notification_outbox o
       set status = 'pending',
           attempts = 0,
           last_error = null,
           next_attempt_at = now(),
           claimed_at = null
     where o.id = _row.id;

    _any := true;
    outbox_id := _id; requeued := true; detail := 'requeued';
    return next;
  end loop;

  -- One nudge for the batch, under the same once-per-transaction guard the
  -- enqueue path uses. Like every nudge it leaves only when this commits.
  if _any and coalesce(current_setting('jmac.notify_nudged', true), '') <> 'on' then
    perform set_config('jmac.notify_nudged', 'on', true);
    perform public.request_applicant_notification_run();
  end if;
end;
$fn$;

-- ---------------------------------------------------------------- withhold
create or replace function public.withhold_applicant_notifications(
  _ids uuid[],
  _reason text
)
returns table (outbox_id uuid, withheld boolean, detail text)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _id uuid;
  _row public.applicant_notification_outbox;
  _refusal text;
begin
  if _reason is null or length(btrim(_reason)) = 0 then
    raise exception 'Say why these notifications are being withheld.';
  end if;
  if _ids is null or cardinality(_ids) = 0 then
    raise exception 'Name the notifications to withhold.';
  end if;
  if cardinality(_ids) > 50 then
    raise exception 'At most fifty notifications per call.';
  end if;

  foreach _id in array (select array_agg(distinct x) from unnest(_ids) x) loop
    select * into _row from public.applicant_notification_outbox o where o.id = _id for update;

    if not found then
      outbox_id := _id; withheld := false; detail := 'no such notification';
      return next; continue;
    end if;

    _refusal := public.applicant_notification_recovery_refusal(_row);
    if _refusal is not null then
      outbox_id := _id; withheld := false; detail := _refusal;
      return next; continue;
    end if;

    insert into public.applicant_notification_recovery_log (
      outbox_id, action, reason, prior_status, prior_attempts, prior_last_error,
      prior_next_attempt_at, prior_claimed_at, prior_provider_message_id)
    values (
      _row.id, 'withheld', btrim(_reason), _row.status, _row.attempts, _row.last_error,
      _row.next_attempt_at, _row.claimed_at, _row.provider_message_id);

    -- Failed, because it was not delivered -- and parked well beyond any retry,
    -- with the decision written where the next operator will read it. HR's
    -- view never shows last_error.
    update public.applicant_notification_outbox o
       set status = 'failed',
           last_error = '[withheld] ' || btrim(_reason),
           next_attempt_at = now() + interval '100 years'
     where o.id = _row.id;

    outbox_id := _id; withheld := true; detail := 'withheld';
    return next;
  end loop;
end;
$fn$;

-- ---------------------------------------------- recording a found acceptance
--
-- For a row parked as [acceptance_unknown] that an operator has since found in
-- Brevo's log. It went out; this says so, with the provider's own message id,
-- instead of leaving HR looking at "Failed" for an email that arrived.
create or replace function public.record_applicant_notification_accepted(
  _id uuid,
  _provider_message_id text,
  _accepted_at timestamptz,
  _reason text
)
returns text
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _row public.applicant_notification_outbox;
  _refusal text;
begin
  if _reason is null or length(btrim(_reason)) = 0 then
    raise exception 'Say where the acceptance was found.';
  end if;
  if _provider_message_id is null or length(btrim(_provider_message_id)) = 0 then
    raise exception 'Give the message id Brevo''s log shows for it.';
  end if;
  if _accepted_at is null or _accepted_at > now() then
    raise exception 'Give the time Brevo accepted it.';
  end if;

  select * into _row from public.applicant_notification_outbox o where o.id = _id for update;
  if not found then
    return 'no such notification';
  end if;

  _refusal := public.applicant_notification_recovery_refusal(_row);
  if _refusal is null and (_row.last_error is null or _row.last_error not like '[acceptance_unknown]%') then
    _refusal := 'only a notification parked as [acceptance_unknown] can be recorded this way';
  end if;
  if _refusal is not null then
    return _refusal;
  end if;

  insert into public.applicant_notification_recovery_log (
    outbox_id, action, reason, prior_status, prior_attempts, prior_last_error,
    prior_next_attempt_at, prior_claimed_at, prior_provider_message_id)
  values (
    _row.id, 'recorded_accepted', btrim(_reason), _row.status, _row.attempts, _row.last_error,
    _row.next_attempt_at, _row.claimed_at, _row.provider_message_id);

  update public.applicant_notification_outbox o
     set status = 'sent',
         sent_at = _accepted_at,
         provider_message_id = left(btrim(_provider_message_id), 200),
         last_error = null
   where o.id = _row.id;

  return 'recorded as accepted';
end;
$fn$;

-- Operator tools. Not for the API roles a browser can hold.
revoke all on function public.requeue_applicant_notifications(uuid[], text, text)
  from public, anon, authenticated;
revoke all on function public.withhold_applicant_notifications(uuid[], text)
  from public, anon, authenticated;
revoke all on function public.record_applicant_notification_accepted(uuid, text, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.requeue_applicant_notifications(uuid[], text, text) to service_role;
grant execute on function public.withhold_applicant_notifications(uuid[], text) to service_role;
grant execute on function public.record_applicant_notification_accepted(uuid, text, timestamptz, text)
  to service_role;
