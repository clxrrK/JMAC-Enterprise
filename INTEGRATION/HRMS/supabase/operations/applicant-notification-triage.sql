-- Applicant notification recovery: which parked notifications are still worth
-- sending. Read-only.
--
-- A notification that failed days ago is not automatically worth sending now.
-- An interview time may have moved, an offer may have been accepted, an
-- application may have been rejected since. Sending the old notice then would
-- tell an applicant something that is no longer true -- worse than silence.
--
-- So each parked notification gets a recommendation, judged against the
-- application's and the interview's CURRENT state:
--
--   send      still true, and nothing later has already reached the applicant
--   withhold  no longer true, or overtaken by a later notice that was delivered
--   review    needs a person: the outcome is unknown, or the case is unusual
--
-- It is a recommendation for the person running the recovery, not a decision:
-- the recovery functions take explicit ids, and a person picks them from this.
--
-- "Parked" means the worker will not retry it on its own: five attempts used,
-- or held far in the future. Rows already withheld are left out. No recipient
-- address, name or payload is selected.

with parked as (
    select o.*
    from public.applicant_notification_outbox o
    where o.status = 'failed'
      and o.provider_message_id is null
      and (o.attempts >= 5 or o.next_attempt_at > now() + interval '1 day')
      and coalesce(o.last_error, '') not like '[withheld]%'
),
ctx as (
    select
        p.id,
        p.application_id,
        p.event_type,
        p.created_at,
        p.attempts,
        p.last_error,
        a.status::text as application_status,
        i.status::text as interview_status,
        i.scheduled_at as interview_at,
        -- A reschedule notice is keyed '<interview id>@<epoch of the new time>'.
        case when p.event_type = 'interview_rescheduled'
             then split_part(p.dedupe_key, '@', 2) end as notice_time,
        extract(epoch from i.scheduled_at)::bigint::text as interview_time_now,
        -- Anything about this application that DID reach Brevo after this row
        -- was queued. Every notice carries the reference code, so a later
        -- delivered one also means the applicant already has it.
        exists (
            select 1 from public.applicant_notification_outbox later
            where later.application_id = p.application_id
              and later.created_at > p.created_at
              and later.status = 'sent'
        ) as later_notice_delivered,
        -- This interview was moved or cancelled after this notice was queued.
        exists (
            select 1 from public.applicant_notification_outbox later
            where later.event_type in ('interview_rescheduled', 'interview_cancelled')
              and split_part(later.dedupe_key, '@', 1) = split_part(p.dedupe_key, '@', 1)
              and later.created_at > p.created_at
        ) as interview_changed_since
    from parked p
    join public.applications a on a.id = p.application_id
    left join public.interviews i
      on p.event_type in ('interview_scheduled', 'interview_rescheduled',
                          'interview_cancelled', 'initial_interview_passed')
     and i.id::text = split_part(p.dedupe_key, '@', 1)
),
judged as (
    select ctx.*,
        case
            -- The outcome was never established. Brevo's log decides, not this.
            when last_error like '[acceptance_unknown]%' then
                'review|Brevo may already have accepted it. Check its transactional log first.'

            when application_status in ('rejected', 'closed')
                 and event_type not in ('application_rejected', 'application_closed') then
                'withhold|The application has since been ' || application_status || '; this notice is no longer true.'

            when event_type in ('interview_scheduled', 'interview_rescheduled', 'interview_cancelled')
                 and interview_status is null then
                'review|The interview this notice is about no longer exists.'

            when event_type = 'interview_scheduled' and interview_status <> 'scheduled' then
                'withhold|The interview is now ' || interview_status || '.'
            when event_type = 'interview_scheduled' and interview_at <= now() then
                'withhold|The interview time has already passed.'
            when event_type = 'interview_scheduled' and interview_changed_since then
                'withhold|Overtaken: the interview was moved or cancelled after this notice was queued.'
            when event_type = 'interview_scheduled' then
                'send|The interview is still scheduled for the time this notice gives, and still ahead.'

            when event_type = 'interview_rescheduled' and interview_status <> 'scheduled' then
                'withhold|The interview is now ' || interview_status || '.'
            when event_type = 'interview_rescheduled' and interview_at <= now() then
                'withhold|The interview time has already passed.'
            when event_type = 'interview_rescheduled' and notice_time is distinct from interview_time_now then
                'withhold|The interview has moved again since this notice; it gives the wrong time.'
            when event_type = 'interview_rescheduled' then
                'send|This notice gives the current time, which is still ahead.'

            when event_type = 'interview_cancelled' and interview_status <> 'cancelled' then
                'withhold|The interview is no longer cancelled.'
            when event_type = 'interview_cancelled' and later_notice_delivered then
                'review|A later notice reached the applicant after this cancellation was queued.'
            when event_type = 'interview_cancelled' and interview_at <= now() then
                'review|Cancelled, but its time has passed; decide whether telling them now still helps.'
            when event_type = 'interview_cancelled' then
                'send|Still cancelled, its time still ahead, and the applicant has not been told.'

            when event_type = 'initial_interview_passed' and interview_status is distinct from 'passed' then
                'withhold|The interview is no longer recorded as passed.'
            when event_type = 'initial_interview_passed' and later_notice_delivered then
                'withhold|Overtaken by a later notice that was delivered.'
            when event_type = 'initial_interview_passed' then
                'send|Still passed, and nothing later has reached the applicant.'

            when event_type = 'application_submitted' and later_notice_delivered then
                'withhold|A later notice, carrying the same reference code, was delivered.'
            when event_type = 'application_submitted' and application_status in ('submitted', 'under_review') then
                'send|The applicant has no notice with their reference code yet.'
            when event_type = 'application_submitted' then
                'review|The application has moved on, and nothing later was delivered either.'

            when event_type = 'application_under_review'
                 and application_status = 'under_review' and not later_notice_delivered then
                'send|Still under review.'
            when event_type = 'application_under_review' then
                'withhold|The application has moved on since.'

            when event_type = 'application_shortlisted'
                 and application_status = 'qualified' and not later_notice_delivered then
                'send|Still shortlisted, and nothing later has reached the applicant.'
            when event_type = 'application_shortlisted' then
                'withhold|The application has moved on since.'

            when event_type = 'offer_sent' and application_status = 'offered' then
                'send|The offer is still open.'
            when event_type = 'offer_sent' then
                'withhold|The offer is no longer open (the application is now ' || application_status || ').'

            when event_type = 'application_hired' and application_status = 'hired' then
                'send|Still hired.'
            when event_type = 'application_hired' and application_status = 'deployed' then
                'review|Since deployed; decide whether the hire notice still adds anything.'
            when event_type = 'application_hired' then
                'withhold|No longer hired (now ' || application_status || ').'

            when event_type = 'deployment_completed' and application_status = 'deployed' then
                'send|Still deployed.'
            when event_type = 'deployment_completed' then
                'withhold|No longer deployed (now ' || application_status || ').'

            when event_type = 'application_rejected' and application_status = 'rejected' then
                'send|The decision stands, and the applicant has not been told.'
            when event_type = 'application_rejected' then
                'withhold|The decision has changed (now ' || application_status || ').'

            when event_type = 'application_closed' and application_status = 'closed' then
                'send|Still closed, and the applicant has not been told.'
            when event_type = 'application_closed' then
                'withhold|No longer closed (now ' || application_status || ').'

            else 'review|Not a case this triage knows.'
        end as judgement
    from ctx
)
select
    id,
    application_id,
    event_type,
    created_at,
    attempts,
    application_status,
    interview_status,
    interview_at,
    split_part(judgement, '|', 1) as recommendation,
    split_part(judgement, '|', 2) as why
from judged
order by
    case split_part(judgement, '|', 1) when 'send' then 1 when 'review' then 2 else 3 end,
    created_at;
