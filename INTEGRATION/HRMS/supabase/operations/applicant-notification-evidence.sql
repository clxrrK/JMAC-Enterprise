-- Applicant notification delivery: the evidence, read-only.
--
-- Every statement here is a SELECT. Nothing is sent, claimed, requeued or
-- changed. Run it in the Supabase SQL editor for project joffopwzqmlqpsrbivfq
-- (or `supabase db query --linked -f` from an account with access), section by
-- section. Sections 4 and 5 need pg_cron and pg_net, which exist in the hosted
-- project and not in a local stack.
--
-- What it deliberately does not select: recipient_email, recipient_name and
-- payload. Nothing below needs an applicant's identity, so none of it can leak
-- into a ticket, a chat or a report. last_error is selected: it holds Brevo's
-- message, which names Supabase's egress IP, not the applicant.

-- --------------------------------------------------------------------------
-- 1. Where the queue stands
-- --------------------------------------------------------------------------
select
    status,
    count(*) as notifications,
    count(*) filter (where last_error ilike '%unrecognised IP%') as brevo_ip_rejections,
    count(*) filter (where last_error like '[provider_%') as provider_refusals_not_charged,
    count(*) filter (where last_error like '[acceptance_unknown]%') as outcome_unknown,
    count(*) filter (where last_error like '[withheld]%') as withheld,
    count(*) filter (where attempts >= 5) as exhausted_attempts,
    count(*) filter (where provider_message_id is not null) as with_provider_message_id,
    max(sent_at) as latest_sent_at
from public.applicant_notification_outbox
group by status
order by status;

-- --------------------------------------------------------------------------
-- 2. Every notification that has not gone out
-- --------------------------------------------------------------------------
select
    id,
    application_id,
    event_type,
    status,
    attempts,
    last_error,
    next_attempt_at,
    created_at,
    claimed_at,
    sent_at,
    provider_message_id
from public.applicant_notification_outbox
where status <> 'sent'
order by created_at;

-- --------------------------------------------------------------------------
-- 3. When the refusals started, and whether anything got through after
-- --------------------------------------------------------------------------
-- If sends kept succeeding after the first refusal, some egress addresses were
-- authorised and others were not. If they stopped dead, blocking switched on
-- at a point in time -- which is what Brevo does on its own after an API key
-- sees no new IP for 30 days. Compare these times with Brevo's "blocked IP"
-- notification emails to the account owner.
with refused as (
    select id, created_at, updated_at, attempts,
           substring(last_error from 'unrecognised IP address ([0-9A-Fa-f:.]+)') as refused_ip
    from public.applicant_notification_outbox
    where last_error ilike '%unrecognised IP%'
)
select
    (select min(created_at) from refused) as first_refused_row_queued,
    (select max(updated_at) from refused) as last_refused_attempt,
    (select max(sent_at) from public.applicant_notification_outbox
      where sent_at < (select min(created_at) from refused)) as last_send_before_refusals,
    (select count(*) from public.applicant_notification_outbox
      where status = 'sent' and sent_at > (select min(created_at) from refused)) as sends_after_first_refusal,
    (select count(distinct refused_ip) from refused) as distinct_refused_ips;

-- Each refused row keeps only its LAST attempt's error, so this is the address
-- of each row's final attempt, not every address Brevo refused.
select refused_ip, count(*) as rows_whose_last_attempt_used_it, max(updated_at) as last_seen
from (
    select substring(last_error from 'unrecognised IP address ([0-9A-Fa-f:.]+)') as refused_ip, updated_at
    from public.applicant_notification_outbox
    where last_error ilike '%unrecognised IP%'
) r
group by refused_ip
order by last_seen desc;

-- --------------------------------------------------------------------------
-- 4. The schedule: is cron asking, and does it succeed?
-- --------------------------------------------------------------------------
-- A 'succeeded' run here means only that the request was QUEUED for pg_net;
-- the worker's answer is in section 5.
select jobid, jobname, schedule, active, command
from cron.job
where jobname = 'applicant-notification-delivery';

select status, count(*) as runs, min(start_time) as first_run, max(start_time) as last_run
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'applicant-notification-delivery')
  and start_time > now() - interval '24 hours'
group by status;

select runid, status, left(return_message, 200) as return_message, start_time, end_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'applicant-notification-delivery')
order by start_time desc
limit 20;

-- --------------------------------------------------------------------------
-- 5. What the worker answered (pg_net keeps roughly the last six hours)
-- --------------------------------------------------------------------------
-- net._http_response has no URL column. The worker's answers are recognisable
-- by their body: {"considered": ...} on a run, {"error":"Not authorised."} on a
-- token mismatch, {"error":"Delivery is not configured."} when the Vault token
-- is missing, and -- after this fix -- a 503 carrying "halted" when Brevo
-- refuses the server.
select
    status_code,
    timed_out,
    case
        when content like '%"considered"%' and content like '%"halted"%' then 'worker: provider refused server'
        when content like '%"considered"%' then 'worker: ran'
        when content like '%Not authorised%' then 'worker: TOKEN MISMATCH'
        when content like '%Delivery is not configured%' then 'worker: VAULT TOKEN MISSING'
        when content like '%BREVO_%is not configured%' then 'worker: BREVO SECRET MISSING'
        when error_msg is not null then 'transport error'
        else 'other caller or unrecognised'
    end as what_it_was,
    count(*) as responses,
    max(created) as latest
from net._http_response
where created > now() - interval '6 hours'
group by 1, 2, 3
order by latest desc;

select id, status_code, timed_out, left(content, 240) as content, left(error_msg, 240) as error_msg, created
from net._http_response
where status_code is null or status_code >= 400 or timed_out
order by created desc
limit 20;

-- --------------------------------------------------------------------------
-- 6. The worker token exists (its value is never selected)
-- --------------------------------------------------------------------------
-- Both the caller (pg_cron and the enqueue nudge) and the worker read this one
-- Vault secret, so they agree by construction. A mismatch would show in
-- section 5 as 'worker: TOKEN MISMATCH'.
select name, created_at, updated_at
from vault.secrets
where name = 'applicant_notify_token';
