/**
 * Applicant notification delivery: the loop, the provider, the read-only check.
 *
 * Extracted from the Edge Function so its failure handling can be tested for
 * what it does rather than for what its source text contains. No imports: it
 * runs unchanged in Deno (the function) and in Node (vitest), the same way the
 * PayMongo signature check does.
 *
 * Why it exists. Ten notifications each burned all five attempts on a single
 * cause -- Brevo refusing the Edge Function's IP address with HTTP 401. Edge
 * Functions have no fixed egress IP, so once Brevo's unknown-IP blocking was on,
 * any request from a new address was refused. The old loop could not tell that
 * apart from a flaky network: it retried each row 1, 5, 30, 120 and 480 minutes
 * later, until every queued notification had spent its whole budget on a
 * problem no retry could fix. It also ignored every database error after the
 * initial read.
 *
 * What it guarantees, and what it does not. The claim is a compare-and-set, so
 * two overlapping runs never send one row twice. Each request carries the row's
 * id as Brevo's idempotency key, which Brevo honours for thirty minutes. Beyond
 * that window nothing here is exactly-once: a row whose outcome is unknown is
 * parked for a person rather than retried, which trades a possible missing
 * email for a guaranteed absence of silent duplicates.
 */

export const MAX_ATTEMPTS = 5

/** Backoff in minutes, indexed by attempt. Slow enough to ride out an outage,
 *  short enough that a real interview notice is not days late. */
export const BACKOFF_MINUTES = [1, 5, 30, 120, 480]

/** How soon a refused-credentials or refused-IP row is probed again. The fix
 *  is a setting someone may already have changed, so this is short -- and it
 *  costs one request per run, not one per queued notification. */
export const CONFIG_RETRY_MINUTES = 5

/** A claim older than this was abandoned. An Edge Function runs for at most a
 *  few hundred seconds, so a quarter of an hour is never a send in flight. */
export const STALE_AFTER_MINUTES = 15

/** Marks a row whose provider outcome is unknown. Requeueing one needs a person
 *  to have checked Brevo's log first. */
export const ACCEPTANCE_UNKNOWN = '[acceptance_unknown]'

export const STALE_NOTE =
  `${ACCEPTANCE_UNKNOWN} A worker claimed this notification and stopped before recording what ` +
  `Brevo said. It may already have been accepted. Check Brevo's transactional log for this ` +
  `recipient around the claim time before requeueing it; never requeue it blindly.`

const PARK_DAYS = 365
const BATCH_SIZE = 25
const RECORD_TRIES = 3

const BREVO_SEND_URL = 'https://api.brevo.com/v3/smtp/email'
const BREVO_API = 'https://api.brevo.com/v3'

// ------------------------------------------------------------------- types

export interface OutboxRow {
  id: string
  event_type: string
  recipient_email: string
  recipient_name: string
  attempts: number
  payload: Record<string, string>
}

export interface OutboxUpdate {
  status?: 'pending' | 'processing' | 'sent' | 'failed'
  attempts?: number
  last_error?: string | null
  next_attempt_at?: string
  sent_at?: string
  provider_message_id?: string | null
}

/** The outbox as the loop needs it. Every method reports its error instead of
 *  throwing, because each failure has a different correct response. */
export interface Outbox {
  parkStale(cutoff: Date, now: Date, note: string): Promise<{ ids: string[]; error: string | null }>
  due(now: Date, limit: number): Promise<{ rows: OutboxRow[]; error: string | null }>
  claim(id: string, now: Date): Promise<{ claimed: boolean; error: string | null }>
  record(id: string, fields: OutboxUpdate): Promise<{ error: string | null }>
}

export interface QueueCounts {
  pending: number
  processing: number
  failed_retrying: number
  failed_parked: number
  sent: number
  sent_without_provider_id: number
}

export interface ProviderResponse {
  ok: boolean
  status: number
  body: string
}

export interface Provider {
  /** Throws only when no HTTP response arrived at all. */
  send(message: Record<string, unknown>): Promise<ProviderResponse>
  get(path: string): Promise<ProviderResponse>
}

/** Refusals about this SERVER, not about a message. */
export type Rejection = 'ip_blocked' | 'credentials'

export interface RunSummary {
  considered: number
  sent: number
  failed: number
  /** Abandoned claims found this run and parked for reconciliation. */
  parked_stale: number
  /** Brevo refused a repeated idempotency key: possibly already delivered. */
  held_for_review: number
  /** Accepted by Brevo, but the database would not record it. Logged with the
   *  message id; never resent. */
  unrecorded: number
  db_errors: number
  /** Set when the provider refused this server; the run stopped there. */
  halted: Rejection | null
  error?: 'queue_unreadable'
}

// ---------------------------------------------------------- classification

/**
 * Brevo answers HTTP 401 both for a key it does not know and for an IP address
 * it will not accept. They have different fixes -- rotate a key, or change the
 * Authorised IPs setting -- so only the message can tell them apart. Brevo
 * writes "unrecognised"; the American spelling is matched too.
 */
export function classifyRejection(status: number, body: string): Rejection | null {
  if (status === 401 && /unrecogni[sz]ed ip/i.test(body)) return 'ip_blocked'
  if (status === 401 || status === 403) return 'credentials'
  return null
}

/** Brevo's answer to a second request with an idempotency key it saw in the
 *  last thirty minutes. The first one may well have been accepted. */
function isRepeatedKey(body: string): boolean {
  return /duplicate_parameter/i.test(body)
}

function messageIdFrom(body: string): string | null {
  // Parsing must never fail the send: the message is already accepted, and
  // treating an unreadable body as failure would deliver it twice.
  try {
    const accepted = JSON.parse(body)
    const id = accepted?.messageId ?? accepted?.messageIds?.[0]
    return typeof id === 'string' ? id.slice(0, 200) : null
  } catch {
    return null
  }
}

// ----------------------------------------------------------------- the loop

export interface DeliverDeps {
  outbox: Outbox
  provider: Provider
  sender: { name: string; email: string }
  render: (row: OutboxRow) => { subject: string; text: string; html: string }
  now?: () => Date
  log?: Pick<Console, 'error' | 'warn' | 'log'>
  sleep?: (ms: number) => Promise<void>
}

export async function deliverDue(deps: DeliverDeps): Promise<RunSummary> {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? console
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  const summary: RunSummary = {
    considered: 0,
    sent: 0,
    failed: 0,
    parked_stale: 0,
    held_for_review: 0,
    unrecorded: 0,
    db_errors: 0,
    halted: null,
  }

  const at = (ms: number) => new Date(now().getTime() + ms).toISOString()
  const parked = () => at(PARK_DAYS * 86_400_000)
  const failure = (attempts: number, reason: string): OutboxUpdate => ({
    status: 'failed',
    attempts,
    last_error: reason,
    // Parked on the last attempt whichever way it failed. The network path
    // used to schedule a retry the attempts filter would never honour.
    next_attempt_at:
      attempts >= MAX_ATTEMPTS
        ? parked()
        : at(BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)] * 60_000),
  })

  /** A write that matters is tried more than once before it is given up on. */
  const persist = async (id: string, fields: OutboxUpdate): Promise<string | null> => {
    let error: string | null = null
    for (let tryNo = 1; tryNo <= RECORD_TRIES; tryNo++) {
      error = (await deps.outbox.record(id, fields)).error
      if (!error) return null
      if (tryNo < RECORD_TRIES) await sleep(250 * tryNo)
    }
    return error
  }

  // 1. Claims nobody finished. Their outcome is unknown, so they are parked
  //    with an explanation rather than sent again or left reading "Sending".
  const t0 = now()
  const stale = await deps.outbox.parkStale(
    new Date(t0.getTime() - STALE_AFTER_MINUTES * 60_000),
    t0,
    STALE_NOTE
  )
  if (stale.error) {
    summary.db_errors += 1
    log.error(`stale-claim sweep failed; continuing with due notifications: ${stale.error}`)
  } else if (stale.ids.length > 0) {
    summary.parked_stale = stale.ids.length
    log.warn(
      `parked ${stale.ids.length} abandoned claim(s) for reconciliation, provider outcome unknown: ${stale.ids.join(', ')}`
    )
  }

  // 2. What is due. An unreadable queue is reported, not mistaken for an
  //    empty one.
  const due = await deps.outbox.due(now(), BATCH_SIZE)
  if (due.error) {
    log.error(`outbox read failed: ${due.error}`)
    return { ...summary, error: 'queue_unreadable' }
  }
  summary.considered = due.rows.length

  for (const row of due.rows) {
    // The claim is a compare-and-set: the row only becomes ours if it was
    // still pending or failed when the update landed. A failed claim is a
    // database error and says so; an empty one means another run took it.
    const claim = await deps.outbox.claim(row.id, now())
    if (claim.error) {
      summary.db_errors += 1
      log.error(`notification ${row.id}: claim failed, so it was not sent: ${claim.error}`)
      continue
    }
    if (!claim.claimed) continue

    const { subject, text, html } = deps.render(row)
    const attempts = row.attempts + 1

    let res: ProviderResponse
    try {
      res = await deps.provider.send({
        sender: deps.sender,
        to: [{ email: row.recipient_email, name: row.recipient_name }],
        subject,
        textContent: text,
        htmlContent: html,
        // Findable in Brevo's log as applicant mail, whatever the event.
        tags: ['applicant-notification'],
        // The row id is a UUID, which is what Brevo requires. A retry inside
        // thirty minutes of a request that did land is refused, not resent.
        headers: { idempotencyKey: row.id },
      })
    } catch (err) {
      // No response at all: DNS, a refused connection, a reset. The key above
      // covers the case where the request landed and the answer was lost.
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, 300)
      const recordError = await persist(row.id, failure(attempts, reason))
      summary.failed += 1
      log.error(`notification ${row.id} threw (attempt ${attempts}): ${reason}`)
      if (recordError) {
        summary.db_errors += 1
        log.error(`notification ${row.id}: could not record that failure: ${recordError}`)
      }
      continue
    }

    if (res.ok) {
      const providerMessageId = messageIdFrom(res.body)
      summary.sent += 1
      const recordError = await persist(row.id, {
        status: 'sent',
        sent_at: now().toISOString(),
        attempts,
        last_error: null,
        provider_message_id: providerMessageId,
      })
      if (recordError) {
        // Accepted, and unrecordable. Sending it again would be a duplicate,
        // so it stays claimed -- no run will pick it up -- and the one piece of
        // evidence that it went out goes where an operator will find it.
        summary.unrecorded += 1
        log.error(
          `notification ${row.id} WAS ACCEPTED by Brevo as ${providerMessageId ?? '(no message id returned)'} ` +
            `but could not be recorded (${recordError}). Do not requeue it; record it as sent.`
        )
      }
      continue
    }

    const body = res.body.slice(0, 300)

    if (isRepeatedKey(res.body)) {
      const recordError = await persist(row.id, {
        status: 'failed',
        attempts,
        last_error:
          `${ACCEPTANCE_UNKNOWN} Brevo refused a repeat of this notification's idempotency key ` +
          `(HTTP ${res.status}: ${body}). An earlier attempt reached it within thirty minutes ` +
          `and may have been accepted. Check Brevo's log before requeueing.`,
        next_attempt_at: parked(),
      })
      summary.held_for_review += 1
      log.warn(`notification ${row.id}: Brevo already had this request; held for review, not retried`)
      if (recordError) {
        summary.db_errors += 1
        log.error(`notification ${row.id}: could not record the hold: ${recordError}`)
      }
      continue
    }

    const rejection = classifyRejection(res.status, res.body)
    if (rejection) {
      // A refusal of this server, not of this message. Charging it to the
      // row is what exhausted ten notifications; trying the rest of the batch
      // would only collect nine more identical refusals.
      const recordError = await persist(row.id, {
        status: 'failed',
        attempts: row.attempts,
        last_error: `[provider_${rejection}] HTTP ${res.status}: ${body}`,
        next_attempt_at: at(CONFIG_RETRY_MINUTES * 60_000),
      })
      summary.failed += 1
      summary.halted = rejection
      log.error(
        rejection === 'ip_blocked'
          ? `Brevo refused this server's IP address (HTTP ${res.status}). Delivery is paused and no ` +
              `notification's attempts were spent. Fix: Brevo > Settings > Security > Authorized IPs.`
          : `Brevo refused the API key (HTTP ${res.status}). Delivery is paused and no notification's ` +
              `attempts were spent. Check BREVO_API_KEY.`
      )
      if (recordError) {
        summary.db_errors += 1
        log.error(`notification ${row.id}: could not record the refusal: ${recordError}`)
      }
      break
    }

    const recordError = await persist(row.id, failure(attempts, `HTTP ${res.status}: ${body}`))
    summary.failed += 1
    log.error(`notification ${row.id} failed (attempt ${attempts}): HTTP ${res.status}`)
    if (recordError) {
      summary.db_errors += 1
      log.error(`notification ${row.id}: could not record that failure: ${recordError}`)
    }
  }

  return summary
}

// ------------------------------------------------------ the read-only check

export interface CheckDeps {
  provider: Provider
  counts: () => Promise<QueueCounts>
  senderEmail: string
  messageId?: string | null
}

export interface HealthReport {
  mode: 'read_only'
  provider_access: 'ok' | Rejection | 'unreachable' | `http_${number}`
  plans?: { type: unknown; credits: unknown; creditsType: unknown }[]
  sender: { email: string; found: boolean | null; active: boolean | null }
  message_events?: { event: unknown; date: unknown; reason: unknown }[] | { error: string }
  queue: QueueCounts | { error: string }
}

const parse = (body: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

/**
 * What an operator needs to know, without sending or claiming anything.
 *
 * Deliberately has no outbox writer to call: the old diagnostics ran after the
 * queue had been processed, so asking "is email working?" could send email.
 * This takes the provider and a count function and nothing else.
 */
export async function checkProvider(deps: CheckDeps): Promise<HealthReport> {
  const report: HealthReport = {
    mode: 'read_only',
    provider_access: 'unreachable',
    sender: { email: deps.senderEmail, found: null, active: null },
    queue: { error: 'not read' },
  }

  try {
    const res = await deps.provider.get('/account')
    if (res.ok) {
      report.provider_access = 'ok'
      const plans = parse(res.body)?.plan
      // Plan shape only -- no keys, no addresses, no account identifiers.
      report.plans = (Array.isArray(plans) ? plans : []).map((pl: Record<string, unknown>) => ({
        type: pl?.type ?? null,
        credits: pl?.credits ?? null,
        creditsType: pl?.creditsType ?? null,
      }))
    } else {
      report.provider_access = classifyRejection(res.status, res.body) ?? `http_${res.status}`
    }
  } catch {
    report.provider_access = 'unreachable'
  }

  try {
    const res = await deps.provider.get('/senders')
    if (res.ok) {
      const senders = parse(res.body)?.senders
      const match = (Array.isArray(senders) ? senders : []).find(
        (s: Record<string, unknown>) =>
          typeof s?.email === 'string' && s.email.toLowerCase() === deps.senderEmail.toLowerCase()
      )
      report.sender = {
        email: deps.senderEmail,
        found: Boolean(match),
        active: match ? Boolean(match.active) : null,
      }
    }
  } catch {
    // Unknown stays unknown.
  }

  if (deps.messageId) {
    try {
      const res = await deps.provider.get(
        `/smtp/statistics/events?messageId=${encodeURIComponent(deps.messageId)}&limit=50`
      )
      if (res.ok) {
        const events = parse(res.body)?.events
        // Event names, times and reasons only -- no recipient, no subject.
        report.message_events = (Array.isArray(events) ? events : []).map(
          (ev: Record<string, unknown>) => ({
            event: ev?.event ?? null,
            date: ev?.date ?? null,
            reason: ev?.reason ?? null,
          })
        )
      } else {
        report.message_events = { error: `HTTP ${res.status}` }
      }
    } catch {
      report.message_events = { error: 'provider unreachable' }
    }
  }

  try {
    report.queue = await deps.counts()
  } catch (err) {
    report.queue = { error: err instanceof Error ? err.message : 'queue unreadable' }
  }

  return report
}

// ---------------------------------------------------------------- adapters

/** Brevo's transactional API. The key travels as a header, never in a body. */
export function brevoClient(
  apiKey: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init)
): Provider {
  const text = async (res: Response) => {
    try {
      return await res.text()
    } catch {
      return ''
    }
  }
  return {
    async send(message) {
      const res = await fetchImpl(BREVO_SEND_URL, {
        method: 'POST',
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(message),
      })
      return { ok: res.ok, status: res.status, body: await text(res) }
    },
    async get(path) {
      const res = await fetchImpl(`${BREVO_API}${path}`, {
        headers: { 'api-key': apiKey, accept: 'application/json' },
      })
      return { ok: res.ok, status: res.status, body: await text(res) }
    },
  }
}

/** The query builder, typed only as far as this file uses it -- a structural
 *  type, so neither Deno's esm.sh client nor Node's npm one has to be named. */
// deno-lint-ignore no-explicit-any
type Query = any
export interface SupabaseLike {
  from(table: string): Query
}

/** The outbox, read and written through the service-role client. */
export function outboxFromSupabase(db: SupabaseLike): Outbox & { counts(now: Date): Promise<QueueCounts> } {
  const table = () => db.from('applicant_notification_outbox')
  const message = (error: { message?: string } | null) => (error ? error.message ?? 'unknown error' : null)

  return {
    async parkStale(cutoff, now, note) {
      const c = cutoff.toISOString()
      const { data, error } = await table()
        .update({
          status: 'failed',
          last_error: note,
          next_attempt_at: new Date(now.getTime() + PARK_DAYS * 86_400_000).toISOString(),
        })
        .eq('status', 'processing')
        // Quoted: a timestamp carries the dots and colons PostgREST reserves.
        .or(`claimed_at.lt."${c}",and(claimed_at.is.null,updated_at.lt."${c}")`)
        .select('id')
      return { ids: ((data ?? []) as { id: string }[]).map((r) => r.id), error: message(error) }
    },

    async due(now, limit) {
      const { data, error } = await table()
        .select('id, event_type, recipient_email, recipient_name, attempts, payload')
        .in('status', ['pending', 'failed'])
        .lte('next_attempt_at', now.toISOString())
        .lt('attempts', MAX_ATTEMPTS)
        .order('created_at', { ascending: true })
        .limit(limit)
      return { rows: (data ?? []) as OutboxRow[], error: message(error) }
    },

    async claim(id, now) {
      // claimed_at is stamped in the same statement, so it records when the
      // row was actually picked up. created_at -> claimed_at is queue wait;
      // claimed_at -> sent_at is Brevo.
      const { data, error } = await table()
        .update({ status: 'processing', claimed_at: now.toISOString() })
        .eq('id', id)
        .in('status', ['pending', 'failed'])
        .select('id')
      return { claimed: !error && Array.isArray(data) && data.length > 0, error: message(error) }
    },

    async record(id, fields) {
      const { error } = await table().update(fields).eq('id', id)
      return { error: message(error) }
    },

    async counts(now) {
      const parkedAfter = new Date(now.getTime() + 86_400_000).toISOString()
      const count = async (build: (q: Query) => Query): Promise<number> => {
        const { count: n, error } = await build(table().select('id', { count: 'exact', head: true }))
        if (error) throw new Error(error.message ?? 'count failed')
        return n ?? 0
      }
      const [pending, processing, failed_retrying, failed_parked, sent, sent_without_provider_id] =
        await Promise.all([
          count((q) => q.eq('status', 'pending')),
          count((q) => q.eq('status', 'processing')),
          count((q) => q.eq('status', 'failed').lte('next_attempt_at', parkedAfter).lt('attempts', MAX_ATTEMPTS)),
          count((q) =>
            q.eq('status', 'failed').or(`next_attempt_at.gt."${parkedAfter}",attempts.gte.${MAX_ATTEMPTS}`)
          ),
          count((q) => q.eq('status', 'sent')),
          count((q) => q.eq('status', 'sent').is('provider_message_id', null)),
        ])
      return { pending, processing, failed_retrying, failed_parked, sent, sent_without_provider_id }
    },
  }
}
