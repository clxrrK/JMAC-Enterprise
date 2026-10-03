// Deliver queued applicant emails through Brevo's transactional API.
//
// This is the second half of the outbox. The first half runs in the database:
// a trigger enqueues a row in the same transaction as the HR decision that
// justifies it. Nothing here can affect that decision -- if Brevo is down, an
// application is still rejected, an interview is still scheduled, and the row
// simply stays pending.
//
// Why Brevo's HTTP API rather than its SMTP relay, which Supabase Auth already
// uses: these are not Auth emails. Reusing resetPasswordForEmail or
// inviteUserByEmail to tell somebody their interview moved would send an
// account-recovery template to a person who has no account, and would put
// application state inside Auth's templates. They are separate concerns with
// separate failure modes, so they get separate paths.
//
// The key lives only as a Supabase secret. It is never in VITE_*, never in the
// browser bundle, never in a database row, and never in a response.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  brevoClient,
  checkProvider,
  deliverDue,
  outboxFromSupabase,
  type OutboxRow,
} from './delivery.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

const TRACK_URL = 'https://jmac-enterprise.vercel.app/track'
/** Who applicant mail comes from.
 *
 *  This was hardcoded to no-reply@jmac-enterprise.com -- an address on a domain
 *  JMAC does not own and has never authenticated with Brevo. Brevo accepted
 *  every API call and then rejected the message: "Sending has been rejected
 *  because the sender no-reply@jmac-enterprise.com is not valid". Seven
 *  applicant notifications were recorded as sent and none could ever arrive.
 *
 *  So there is no default any more. An unset sender stops the run instead of
 *  quietly substituting an address that cannot deliver -- a wrong sender is
 *  indistinguishable from success until someone reads the provider's log.
 *
 *  The display name stays applicant-facing; the address must be one Brevo has
 *  verified for this account.
 */
const SENDER_NAME = Deno.env.get('BREVO_SENDER_NAME') ?? 'JMAC Enterprise'

/** Constant-time compare, so the token cannot be discovered a byte at a time. */
function tokensMatch(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  if (ea.length !== eb.length) return false
  let diff = 0
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i]
  return diff === 0
}

/** Subject and body per event. Applicant-safe by construction: the only values
 *  available are the ones the trigger put in the payload, and the trigger puts
 *  no notes, ratings or reasons there. */
function compose(row: OutboxRow): { subject: string; heading: string; lines: string[]; action: string } {
  const p = row.payload ?? {}
  const position = p.position || 'the role you applied for'
  const when = p.scheduled_at ? `${p.scheduled_at}` : ''
  const time = p.scheduled_time ? `${p.scheduled_time}` : ''
  const place = p.meeting_link || p.location || ''
  const mode = p.mode === 'online' ? 'Online' : p.mode === 'face_to_face' ? 'In person' : ''

  // "Initial Interview" / "Final Interview" / plain "interview" if a stage ever
  // arrives that this does not know. The payload has always carried
  // interview_type and nothing read it, so an applicant with both interviews
  // received two emails that read identically and could not tell which was
  // which -- or whether the second had replaced the first.
  //
  // The stage is the only thing about the interviewer's side that an applicant
  // is told. Who runs it, and under what authority, stays internal.
  const stage =
    p.interview_type === 'initial'
      ? 'Initial Interview'
      : p.interview_type === 'final'
        ? 'Final Interview'
        : 'interview'
  const stageLower = stage === 'interview' ? 'interview' : stage.toLowerCase()

  const interviewLines = [
    when ? `Date: ${when}` : '',
    time ? `Time: ${time}` : '',
    mode ? `Format: ${mode}` : '',
    place ? `Where: ${place}` : '',
  ].filter(Boolean)

  switch (row.event_type) {
    case 'application_submitted':
      return {
        subject: 'JMAC Application Received',
        heading: 'We have your application',
        lines: [
          `Thank you for applying for ${position}.`,
          'Your application has been received and will be reviewed by our team.',
          'Please keep the reference code below — you will need it, together with this email address, to check your application at any time.',
        ],
        action: 'Track your application',
      }
    case 'application_under_review':
      return {
        subject: 'Your JMAC Enterprise application is under review',
        heading: 'Your application is under review',
        lines: [
          `We have started reviewing your application for ${position}.`,
          'Keep the reference code below — you can check your application at any time.',
        ],
        action: 'Track your application',
      }
    case 'application_shortlisted':
      return {
        subject: 'JMAC Application Update — Shortlisted',
        heading: 'Your application is moving forward',
        lines: [
          `Your application for ${position} has been shortlisted.`,
          'We will be in touch with the next steps.',
        ],
        action: 'Track your application',
      }
    case 'initial_interview_passed':
      // The one milestone no other event reports. Passing the initial interview
      // changes no application status, so without this the applicant hears
      // nothing between attending and being invited to the final round.
      //
      // Carries no rating, score, note or impression -- the evaluation that
      // produced this is HR's record. It says only that they are through.
      return {
        subject: 'JMAC Enterprise — You Passed Your Initial Interview',
        heading: 'You passed your initial interview',
        lines: [
          `Congratulations. You have successfully completed the Initial Interview for the ${position} position and will proceed to the next stage of the recruitment process.`,
          'We will notify you when your Final Interview is scheduled.',
        ],
        action: 'Track your application',
      }
    case 'interview_scheduled':
      return {
        subject: `JMAC Application Update — ${stage} Scheduled`,
        heading: `Your ${stageLower} has been scheduled`,
        lines: [
          `Your ${stageLower} for ${position} has been scheduled.`,
          ...interviewLines,
        ],
        action: 'View the latest details',
      }
    case 'interview_rescheduled':
      return {
        subject: `JMAC Application Update — ${stage} Rescheduled`,
        heading: `Your ${stageLower} has been moved`,
        lines: [
          `Your ${stageLower} for ${position} has been moved. This replaces the previous schedule.`,
          'The current schedule is:',
          ...interviewLines,
        ],
        action: 'View the latest details',
      }
    case 'interview_cancelled':
      return {
        subject: `JMAC Application Update — ${stage} Cancelled`,
        heading: `Your ${stageLower} has been cancelled`,
        lines: [
          `Your ${stageLower} for ${position} has been cancelled.`,
          // Said plainly, because a cancelled interview is the moment an
          // applicant fears the worst. Cancelling an interview is not a
          // decision on the application, and only the application's own status
          // change says otherwise.
          'This is not a decision on your application. If another interview is arranged, you will receive a new notification.',
        ],
        action: 'Track your application',
      }
    case 'offer_sent':
      return {
        subject: 'JMAC Application Update — Job Offer',
        heading: 'You have a job offer',
        lines: [
          `A job offer has been prepared for your application for ${position}.`,
          'Please review it and respond using the link below.',
        ],
        action: 'Review your offer',
      }
    case 'application_hired':
      return {
        subject: 'JMAC Application Update — Welcome to JMAC',
        heading: 'Welcome to JMAC',
        lines: [
          `We are pleased to confirm you have been hired for ${position}.`,
          'Onboarding details will follow.',
        ],
        action: 'Track your application',
      }
    case 'deployment_completed':
      return {
        subject: 'JMAC Application Update — Onboarding Complete',
        heading: 'Your onboarding is complete',
        lines: [`Your onboarding for ${position} is complete. Welcome aboard.`],
        action: 'Track your application',
      }
    case 'application_rejected':
      // Neutral and reasonless on purpose. rejection_reason is HR's internal
      // record, and this workflow has no applicant-facing reason field.
      return {
        subject: 'JMAC Application Update',
        heading: 'Update on your application',
        lines: [
          `Thank you for your interest in ${position} at JMAC Enterprise.`,
          'After careful consideration we will not be moving forward with your application at this time.',
          'We appreciate the time you took to apply, and we wish you well.',
        ],
        action: 'Track your application',
      }
    case 'application_closed':
    default:
      return {
        subject: 'JMAC Application Update',
        heading: 'Update on your application',
        lines: [`There has been an update to your application for ${position}.`],
        action: 'Track your application',
      }
  }
}

function render(row: OutboxRow) {
  const { subject, heading, lines, action } = compose(row)
  const ref = row.payload?.reference_code ?? ''
  const name = row.recipient_name || 'there'

  const text = [
    `Hello ${name},`,
    '',
    ...lines,
    '',
    ref ? `Reference: ${ref}` : '',
    `${action}: ${TRACK_URL}`,
    '',
    'You will need your reference code and this email address to view your application.',
    '',
    'JMAC Enterprise',
  ].filter((l) => l !== undefined).join('\n')

  const html = `<!doctype html><html><body style="margin:0;background:#f1f5f9;padding:24px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#0f2a43">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">
    <p style="margin:0 0 4px;font-size:18px;font-weight:800;letter-spacing:-.02em">JMAC</p>
    <p style="margin:0 0 20px;font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:#64748b">Enterprise</p>
    <h1 style="margin:0 0 14px;font-size:18px">${heading}</h1>
    <p style="margin:0 0 14px;font-size:14px">Hello ${name},</p>
    ${lines.map((l) => `<p style="margin:0 0 10px;font-size:14px;line-height:1.6">${l}</p>`).join('')}
    ${ref ? `<p style="margin:18px 0 6px;font-size:12px;color:#64748b">Reference</p>
    <p style="margin:0 0 18px;font-family:ui-monospace,monospace;font-size:15px;font-weight:600">${ref}</p>` : ''}
    <a href="${TRACK_URL}" style="display:inline-block;background:#0f2a43;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600">${action}</a>
    <p style="margin:20px 0 0;font-size:12px;color:#64748b;line-height:1.6">You will need your reference code and this email address to view your application.</p>
  </div>
</body></html>`

  return { subject, text, html }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const brevoKey = Deno.env.get('BREVO_API_KEY')

    const admin = createClient(supabaseUrl, serviceRoleKey)

    // Who may make JMAC send its queued mail.
    //
    // This used to rely on Supabase's default JWT check, which the PUBLIC anon
    // key satisfies -- so anyone who read the frontend bundle could trigger a
    // delivery run. The expected token is generated by the database into Vault
    // and read from there by both sides, so it exists in no file and no
    // browser. If it ever leaked, the worst it could do is deliver mail that
    // was already queued and already addressed.
    const { data: expectedToken, error: tokenError } = await admin.rpc('applicant_notify_token')
    if (tokenError) {
      // A failed lookup, not a missing token: one run on 2026-10-03 hit this
      // between two healthy runs, and reporting it as "not configured" sent
      // the diagnosis the wrong way. Still refused -- nothing runs unverified.
      console.error(`could not read applicant_notify_token; refusing to run: ${tokenError.message}`)
      return json({ error: 'Could not verify the delivery token.' }, 503)
    }
    if (!expectedToken) {
      console.error('applicant_notify_token is not configured; refusing to run.')
      return json({ error: 'Delivery is not configured.' }, 503)
    }

    const presented = req.headers.get('x-jmac-notify-token') ?? ''
    if (!tokensMatch(presented, expectedToken as string)) {
      console.error('notification worker token mismatch; rejecting.')
      return json({ error: 'Not authorised.' }, 401)
    }

    if (!brevoKey) {
      // Named precisely so an operator knows exactly what to add, and nothing
      // is attempted that would mark rows failed for a configuration reason.
      return json({ error: 'BREVO_API_KEY is not configured for this project.' }, 503)
    }

    const senderEmail = Deno.env.get('BREVO_SENDER_EMAIL')?.trim()
    const outbox = outboxFromSupabase(admin)
    const provider = brevoClient(brevoKey)

    // The health check: provider access, the sender, one message's delivery
    // events, and the queue as counts. Answered here -- after the token gate,
    // before anything is claimed -- so asking "is email working?" can never send
    // email. It used to run AFTER the queue had been processed, which made every
    // health check a delivery run. It also comes before the sender guard, so a
    // missing sender can be diagnosed rather than merely refused.
    const url = new URL(req.url)
    if (url.searchParams.get('diagnostics') === '1') {
      return json(
        await checkProvider({
          provider,
          counts: () => outbox.counts(new Date()),
          senderEmail: senderEmail ?? '',
          messageId: url.searchParams.get('messageId'),
        })
      )
    }

    if (!senderEmail) {
      // Same reasoning as the key: refuse rather than send from something that
      // will be rejected downstream and recorded here as a success.
      console.error('BREVO_SENDER_EMAIL is not configured; refusing to send.')
      return json({ error: 'BREVO_SENDER_EMAIL is not configured for this project.' }, 503)
    }

    const summary = await deliverDue({
      outbox,
      provider,
      sender: { name: SENDER_NAME, email: senderEmail },
      render,
    })

    if (summary.error === 'queue_unreadable') {
      return json({ error: 'Could not read the notification queue.' }, 500)
    }

    // Counts only. No addresses, no payloads, no provider text.
    const counts = {
      considered: summary.considered,
      sent: summary.sent,
      failed: summary.failed,
      parked_stale: summary.parked_stale,
      held_for_review: summary.held_for_review,
      unrecorded: summary.unrecorded,
      db_errors: summary.db_errors,
    }

    if (summary.halted) {
      // A 503, so a refusal of this server stands out in net._http_response and
      // the function log instead of reading as a quiet 200 with failed: 1.
      return json(
        {
          error:
            summary.halted === 'ip_blocked'
              ? "Brevo refused this server's IP address. Delivery is paused; no notification's attempts were spent."
              : "Brevo refused the API key. Delivery is paused; no notification's attempts were spent.",
          halted: summary.halted,
          ...counts,
        },
        503
      )
    }

    return json(counts)
  } catch (err) {
    console.error('send-applicant-notifications unhandled:', err instanceof Error ? err.message : err)
    return json({ error: 'Could not process the notification queue.' }, 500)
  }
})
