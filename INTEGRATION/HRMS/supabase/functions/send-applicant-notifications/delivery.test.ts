/** The delivery loop -- behaviour, not source text.
 *
 * Written after ten applicant notifications burned all five attempts on one
 * cause: Brevo refusing the Edge Function's IP address. Supabase Edge Functions
 * have no fixed egress IP, so once Brevo's unknown-IP blocking was on, every
 * request from a new address got HTTP 401 -- and the worker treated that like
 * a flaky network, retrying each row 1, 5, 30, 120 and 480 minutes later until
 * each had used its whole budget on a problem no retry could fix.
 *
 * These pin the rules that stop that recurring, plus the database-failure
 * paths the old loop silently ignored.
 *
 * Run: npx vitest run supabase/functions/send-applicant-notifications/delivery.test.ts
 */
import { describe, expect, it } from 'vitest'
import {
  ACCEPTANCE_UNKNOWN,
  MAX_ATTEMPTS,
  STALE_AFTER_MINUTES,
  brevoClient,
  checkProvider,
  classifyRejection,
  deliverDue,
  type Outbox,
  type OutboxRow,
  type Provider,
  type ProviderResponse,
} from './delivery'

// ------------------------------------------------------------------ fakes

const NOW = new Date('2026-10-03T08:00:00.000Z')

/** Brevo's own words for the two different 401s, as recorded in production
 *  and in a public client that had to tell them apart. */
const IP_BLOCKED_BODY = JSON.stringify({
  code: 'unauthorized',
  message:
    'We have detected you are using an unrecognised IP address 2001:db8::7. If you performed this action make sure to add the new IP address in this link: https://app.brevo.com/security/authorised_ips',
})
const BAD_KEY_BODY = JSON.stringify({ code: 'unauthorized', message: 'Key not found' })

interface StoredRow extends OutboxRow {
  status: 'pending' | 'processing' | 'sent' | 'failed'
  next_attempt_at: string
  claimed_at: string | null
  updated_at: string
  last_error: string | null
  sent_at: string | null
  provider_message_id: string | null
}

function stored(id: string, over: Partial<StoredRow> = {}): StoredRow {
  return {
    id,
    event_type: 'application_submitted',
    recipient_email: `${id}@example.test`,
    recipient_name: `Applicant ${id}`,
    attempts: 0,
    payload: { reference_code: `REF-${id}`, position: 'Cashier' },
    status: 'pending',
    next_attempt_at: new Date(NOW.getTime() - 60_000).toISOString(),
    claimed_at: null,
    updated_at: new Date(NOW.getTime() - 60_000).toISOString(),
    last_error: null,
    sent_at: null,
    provider_message_id: null,
    ...over,
  }
}

/** An in-memory outbox that behaves like the real one -- the claim is a
 *  compare-and-set on status -- and can be told to fail. */
function fakeOutbox(rows: StoredRow[], faults: {
  claim?: Set<string>
  /** How many times a record() for this id fails before succeeding. */
  record?: Map<string, number>
  due?: boolean
  parkStale?: boolean
} = {}) {
  const store = new Map(rows.map((r) => [r.id, { ...r }]))
  const recordFaults = new Map(faults.record ?? [])
  const calls = { claims: [] as string[], records: [] as string[], writes: 0 }

  const outbox: Outbox = {
    async parkStale(cutoff, now, note) {
      calls.writes += 1
      if (faults.parkStale) return { ids: [], error: 'stale sweep: connection reset' }
      const ids: string[] = []
      for (const r of store.values()) {
        const since = r.claimed_at ?? r.updated_at
        if (r.status === 'processing' && new Date(since) < cutoff) {
          r.status = 'failed'
          r.last_error = note
          r.next_attempt_at = new Date(now.getTime() + 365 * 86_400_000).toISOString()
          ids.push(r.id)
        }
      }
      return { ids, error: null }
    },
    async due(now, limit) {
      if (faults.due) return { rows: [], error: 'relation does not exist' }
      const rows = [...store.values()]
        .filter((r) => (r.status === 'pending' || r.status === 'failed')
          && new Date(r.next_attempt_at) <= now
          && r.attempts < MAX_ATTEMPTS)
        .slice(0, limit)
        .map(({ id, event_type, recipient_email, recipient_name, attempts, payload }) =>
          ({ id, event_type, recipient_email, recipient_name, attempts, payload }))
      return { rows, error: null }
    },
    async claim(id, now) {
      calls.claims.push(id)
      calls.writes += 1
      if (faults.claim?.has(id)) return { claimed: false, error: 'could not serialize access' }
      const r = store.get(id)
      if (!r || (r.status !== 'pending' && r.status !== 'failed')) return { claimed: false, error: null }
      r.status = 'processing'
      r.claimed_at = now.toISOString()
      return { claimed: true, error: null }
    },
    async record(id, fields) {
      calls.records.push(id)
      calls.writes += 1
      const left = recordFaults.get(id) ?? 0
      if (left > 0) {
        recordFaults.set(id, left - 1)
        return { error: 'connection terminated unexpectedly' }
      }
      const r = store.get(id)
      if (r) Object.assign(r, fields)
      return { error: null }
    },
  }
  return { outbox, store, calls }
}

type Responder = (message: Record<string, unknown>, call: number) => ProviderResponse | Error

function fakeProvider(respond: Responder) {
  const sent: Record<string, unknown>[] = []
  const provider: Provider = {
    async send(message) {
      sent.push(message as Record<string, unknown>)
      const out = respond(message as Record<string, unknown>, sent.length)
      if (out instanceof Error) throw out
      return out
    },
    async get() {
      throw new Error('the delivery loop must not read from the provider')
    },
  }
  return { provider, sent }
}

const accepted = (id = 'msg-1'): ProviderResponse =>
  ({ ok: true, status: 201, body: JSON.stringify({ messageId: `<${id}@smtp-relay.brevo.com>` }) })
const refused = (status: number, body: string): ProviderResponse => ({ ok: false, status, body })

function silentLog() {
  const lines: string[] = []
  const push = (...a: unknown[]) => { lines.push(a.map(String).join(' ')) }
  return { log: { error: push, warn: push, log: push }, lines }
}

function run(outbox: Outbox, provider: Provider, log = silentLog().log) {
  return deliverDue({
    outbox,
    provider,
    sender: { name: 'JMAC Enterprise', email: 'careers@jmac.test' },
    render: (row) => ({ subject: `s:${row.event_type}`, text: 't', html: '<p>h</p>' }),
    now: () => NOW,
    log,
    sleep: async () => {},
  })
}

// ------------------------------------------------------- classification

describe('telling a refusal from a failure', () => {
  it('reads an IP refusal from the message, because the status is the same', () => {
    // Brevo answers 401 for an unknown key AND for an unknown IP. Only the
    // message tells them apart, and they have different fixes.
    expect(classifyRejection(401, IP_BLOCKED_BODY)).toBe('ip_blocked')
    expect(classifyRejection(401, BAD_KEY_BODY)).toBe('credentials')
  })

  it('accepts either spelling of the word Brevo uses', () => {
    expect(classifyRejection(401, 'unrecognized IP address 203.0.113.9')).toBe('ip_blocked')
  })

  it('treats a 403 as the account refusing, not the message', () => {
    expect(classifyRejection(403, '{"code":"permission_denied"}')).toBe('credentials')
  })

  it('leaves ordinary failures to the per-notification retry', () => {
    expect(classifyRejection(500, 'Internal Server Error')).toBeNull()
    expect(classifyRejection(429, 'Too Many Requests')).toBeNull()
    expect(classifyRejection(400, '{"code":"invalid_parameter"}')).toBeNull()
  })
})

// ------------------------------------------------ the incident, prevented

describe('a provider that refuses this server', () => {
  it('does not spend any notification\'s attempts on it', () => {
    // The incident: five attempts each, burned on an IP block.
    const { outbox, store } = fakeOutbox([stored('a', { attempts: 2 })])
    const { provider } = fakeProvider(() => refused(401, IP_BLOCKED_BODY))
    return run(outbox, provider).then(() => {
      const row = store.get('a')!
      expect(row.attempts).toBe(2)
      expect(row.status).toBe('failed')
    })
  })

  it('stops the run after the first refusal instead of trying every row', async () => {
    // Every other row would be refused identically. One probe per run is
    // enough to know, and to notice when it is fixed.
    const { outbox, store, calls } = fakeOutbox([stored('a'), stored('b'), stored('c')])
    const { provider, sent } = fakeProvider(() => refused(401, IP_BLOCKED_BODY))
    const summary = await run(outbox, provider)

    expect(sent).toHaveLength(1)
    expect(calls.claims).toEqual(['a'])
    expect(store.get('b')!.status).toBe('pending')
    expect(store.get('c')!.status).toBe('pending')
    expect(summary.halted).toBe('ip_blocked')
  })

  it('names the cause where an operator will look', async () => {
    const { outbox, store } = fakeOutbox([stored('a')])
    const { provider } = fakeProvider(() => refused(401, IP_BLOCKED_BODY))
    await run(outbox, provider)

    const error = store.get('a')!.last_error!
    expect(error.startsWith('[provider_ip_blocked]')).toBe(true)
    // The provider's own text survives, IP and all: it is the evidence.
    expect(error).toContain('unrecognised IP address')
  })

  it('tries again soon, because the fix is a setting and may already be made', async () => {
    const { outbox, store } = fakeOutbox([stored('a')])
    const { provider } = fakeProvider(() => refused(401, IP_BLOCKED_BODY))
    await run(outbox, provider)

    const next = new Date(store.get('a')!.next_attempt_at).getTime()
    expect(next - NOW.getTime()).toBeLessThanOrEqual(10 * 60_000)
    expect(next).toBeGreaterThan(NOW.getTime())
  })

  it('handles a key Brevo does not know the same way, under its own name', async () => {
    const { outbox, store } = fakeOutbox([stored('a', { attempts: 1 }), stored('b')])
    const { provider, sent } = fakeProvider(() => refused(401, BAD_KEY_BODY))
    const summary = await run(outbox, provider)

    expect(summary.halted).toBe('credentials')
    expect(sent).toHaveLength(1)
    expect(store.get('a')!.attempts).toBe(1)
    expect(store.get('a')!.last_error!.startsWith('[provider_credentials]')).toBe(true)
  })

  it('sends normally once the block is lifted', async () => {
    const { outbox, store } = fakeOutbox([stored('a')])
    let blocked = true
    const { provider } = fakeProvider(() => (blocked ? refused(401, IP_BLOCKED_BODY) : accepted('m-a')))

    await run(outbox, provider)
    blocked = false
    // The retry window has passed.
    store.get('a')!.next_attempt_at = new Date(NOW.getTime() - 1).toISOString()
    const summary = await run(outbox, provider)

    expect(summary.sent).toBe(1)
    expect(store.get('a')!.status).toBe('sent')
    expect(store.get('a')!.attempts).toBe(1)
  })
})

// ------------------------------------- ordinary failures keep their budget

describe('a notification the provider will not take', () => {
  it('retries with backoff and counts the attempt', async () => {
    const { outbox, store } = fakeOutbox([stored('a')])
    const { provider } = fakeProvider(() => refused(500, 'upstream timeout'))
    const summary = await run(outbox, provider)

    const row = store.get('a')!
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(1)
    expect(row.last_error).toBe('HTTP 500: upstream timeout')
    expect(new Date(row.next_attempt_at).getTime()).toBe(NOW.getTime() + 60_000)
    expect(summary.failed).toBe(1)
  })

  it('moves on to the next notification rather than stopping', async () => {
    const { outbox, store } = fakeOutbox([stored('a'), stored('b')])
    const { provider } = fakeProvider((_m, call) => (call === 1 ? refused(500, 'x') : accepted('m-b')))
    await run(outbox, provider)

    expect(store.get('a')!.status).toBe('failed')
    expect(store.get('b')!.status).toBe('sent')
  })

  it('gives up after the last attempt and parks it for a person', async () => {
    const { outbox, store } = fakeOutbox([stored('a', { attempts: MAX_ATTEMPTS - 1 })])
    const { provider } = fakeProvider(() => refused(500, 'x'))
    await run(outbox, provider)

    const row = store.get('a')!
    expect(row.attempts).toBe(MAX_ATTEMPTS)
    expect(new Date(row.next_attempt_at).getTime() - NOW.getTime()).toBeGreaterThan(300 * 86_400_000)
  })

  it('parks a network failure on its last attempt too, not just an HTTP one', async () => {
    // The thrown path used to schedule a retry the attempts filter would never
    // honour -- a row that looked due and never was.
    const { outbox, store } = fakeOutbox([stored('a', { attempts: MAX_ATTEMPTS - 1 })])
    const { provider } = fakeProvider(() => new Error('error sending request: connection refused'))
    await run(outbox, provider)

    const row = store.get('a')!
    expect(row.attempts).toBe(MAX_ATTEMPTS)
    expect(new Date(row.next_attempt_at).getTime() - NOW.getTime()).toBeGreaterThan(300 * 86_400_000)
  })
})

// ---------------------------------------------- what a sent message carries

describe('the request to Brevo', () => {
  it('goes to the applicant, from the configured sender', async () => {
    const { outbox } = fakeOutbox([stored('a')])
    const { provider, sent } = fakeProvider(() => accepted())
    await run(outbox, provider)

    expect(sent[0].to).toEqual([{ email: 'a@example.test', name: 'Applicant a' }])
    expect(sent[0].sender).toEqual({ name: 'JMAC Enterprise', email: 'careers@jmac.test' })
  })

  it('carries the notification id as Brevo\'s idempotency key', async () => {
    // Brevo refuses a second request with the same key for thirty minutes, so
    // a retry after an ambiguous failure cannot become a second email inside
    // that window. Outside it, nothing here pretends to be exactly-once.
    const { outbox } = fakeOutbox([stored('3f2b8c1e-0d4a-4c55-9d7e-2a1b3c4d5e6f')])
    const { provider, sent } = fakeProvider(() => accepted())
    await run(outbox, provider)

    expect(sent[0].headers).toEqual({ idempotencyKey: '3f2b8c1e-0d4a-4c55-9d7e-2a1b3c4d5e6f' })
  })

  it('is tagged, so applicant mail can be found in Brevo\'s log', async () => {
    const { outbox } = fakeOutbox([stored('a')])
    const { provider, sent } = fakeProvider(() => accepted())
    await run(outbox, provider)
    expect(sent[0].tags).toEqual(['applicant-notification'])
  })

  it('records Brevo\'s message id, the key to its delivery log', async () => {
    const { outbox, store } = fakeOutbox([stored('a')])
    const { provider } = fakeProvider(() => accepted('m-77'))
    await run(outbox, provider)

    const row = store.get('a')!
    expect(row.status).toBe('sent')
    expect(row.provider_message_id).toBe('<m-77@smtp-relay.brevo.com>')
    expect(row.last_error).toBeNull()
    expect(row.sent_at).toBe(NOW.toISOString())
  })

  it('still records an acceptance whose body it cannot read', async () => {
    // Treating an unreadable 2xx as failure would send the message twice.
    const { outbox, store } = fakeOutbox([stored('a')])
    const { provider } = fakeProvider(() => ({ ok: true, status: 201, body: 'not json' }))
    await run(outbox, provider)

    expect(store.get('a')!.status).toBe('sent')
    expect(store.get('a')!.provider_message_id).toBeNull()
  })
})

// ------------------------------------------------ the database can fail too

describe('when the database does not answer', () => {
  it('logs a failed claim and does not send that notification', async () => {
    // A failed claim used to read exactly like "another worker took it".
    const { outbox, store } = fakeOutbox([stored('claim-1'), stored('claim-2')], {
      claim: new Set(['claim-1']),
    })
    const { provider, sent } = fakeProvider(() => accepted())
    const { log, lines } = silentLog()
    const summary = await run(outbox, provider, log)

    expect(sent.map((m) => (m.headers as { idempotencyKey: string }).idempotencyKey)).toEqual(['claim-2'])
    expect(store.get('claim-1')!.status).toBe('pending')
    expect(summary.db_errors).toBe(1)
    expect(lines.some((l) => l.includes('claim-1') && l.includes('could not serialize access'))).toBe(true)
  })

  it('skips a notification another worker already took, quietly', async () => {
    const { outbox, store } = fakeOutbox([stored('a', { status: 'processing', claimed_at: NOW.toISOString() })])
    const { provider, sent } = fakeProvider(() => accepted())
    const summary = await run(outbox, provider)
    expect(sent).toHaveLength(0)
    expect(summary.db_errors).toBe(0)
    expect(store.get('a')!.status).toBe('processing')
  })

  it('keeps trying to record an accepted message rather than resending it', async () => {
    const { outbox, store } = fakeOutbox([stored('a')], { record: new Map([['a', 2]]) })
    const { provider, sent } = fakeProvider(() => accepted('m-a'))
    const summary = await run(outbox, provider)

    expect(sent).toHaveLength(1)
    expect(store.get('a')!.status).toBe('sent')
    expect(store.get('a')!.provider_message_id).toBe('<m-a@smtp-relay.brevo.com>')
    expect(summary.unrecorded).toBe(0)
  })

  it('never resends an accepted message it could not record, and says which', async () => {
    // Accepted by Brevo, then the write failed every time. Sending again would
    // be a duplicate; the message id goes to the log so it can be reconciled.
    const { outbox, store } = fakeOutbox([stored('rec-1')], { record: new Map([['rec-1', 99]]) })
    const { provider, sent } = fakeProvider(() => accepted('m-a'))
    const { log, lines } = silentLog()
    const summary = await run(outbox, provider, log)

    expect(sent).toHaveLength(1)
    expect(summary.unrecorded).toBe(1)
    // Left claimed, so no worker will pick it up and send it again.
    expect(store.get('rec-1')!.status).toBe('processing')
    expect(lines.some((l) => l.includes('rec-1') && l.includes('<m-a@smtp-relay.brevo.com>'))).toBe(true)

    // And a second run does not touch it either.
    const again = await run(outbox, provider, log)
    expect(sent).toHaveLength(1)
    expect(again.considered).toBe(0)
  })

  it('logs a failure it could not record', async () => {
    const { outbox } = fakeOutbox([stored('rec-2')], { record: new Map([['rec-2', 99]]) })
    const { provider } = fakeProvider(() => refused(500, 'x'))
    const { log, lines } = silentLog()
    const summary = await run(outbox, provider, log)

    expect(summary.db_errors).toBeGreaterThan(0)
    expect(lines.some((l) => l.includes('rec-2') && l.includes('connection terminated'))).toBe(true)
  })

  it('reports a queue it cannot read instead of pretending it was empty', async () => {
    const { outbox } = fakeOutbox([stored('a')], { due: true })
    const { provider, sent } = fakeProvider(() => accepted())
    const summary = await run(outbox, provider)

    expect(summary.error).toBe('queue_unreadable')
    expect(sent).toHaveLength(0)
  })
})

// ------------------------------------------- claims that were never finished

describe('a notification a worker claimed and never finished', () => {
  const longAgo = new Date(NOW.getTime() - (STALE_AFTER_MINUTES + 5) * 60_000).toISOString()

  it('is parked for a person instead of being sent again', async () => {
    // It may or may not have reached Brevo before the worker stopped. Resending
    // risks a duplicate; leaving it "Sending" forever hides it. So: say so.
    const { outbox, store } = fakeOutbox([stored('a', { status: 'processing', claimed_at: longAgo })])
    const { provider, sent } = fakeProvider(() => accepted())
    const summary = await run(outbox, provider)

    const row = store.get('a')!
    expect(sent).toHaveLength(0)
    expect(row.status).toBe('failed')
    expect(row.last_error!.startsWith(ACCEPTANCE_UNKNOWN)).toBe(true)
    expect(new Date(row.next_attempt_at).getTime() - NOW.getTime()).toBeGreaterThan(300 * 86_400_000)
    expect(summary.parked_stale).toBe(1)
  })

  it('leaves a claim that is still plausibly in flight alone', async () => {
    const recent = new Date(NOW.getTime() - 60_000).toISOString()
    const { outbox, store } = fakeOutbox([stored('a', { status: 'processing', claimed_at: recent })])
    const { provider } = fakeProvider(() => accepted())
    await run(outbox, provider)
    expect(store.get('a')!.status).toBe('processing')
  })

  it('still delivers the rest if the sweep itself fails', async () => {
    const { outbox, store } = fakeOutbox([stored('a')], { parkStale: true })
    const { provider } = fakeProvider(() => accepted())
    const summary = await run(outbox, provider)

    expect(store.get('a')!.status).toBe('sent')
    expect(summary.db_errors).toBe(1)
  })

  it('treats Brevo refusing a repeated key as possible delivery, not failure', async () => {
    // Brevo says it already has a request with this notification's key from
    // the last thirty minutes. That earlier request may well have been
    // accepted -- so this is held for a person, never retried automatically.
    const { outbox, store } = fakeOutbox([stored('a', { attempts: 1 })])
    const { provider } = fakeProvider(() =>
      refused(400, '{"code":"duplicate_parameter","message":"idempotencyKey already used"}'))
    const summary = await run(outbox, provider)

    const row = store.get('a')!
    expect(row.status).toBe('failed')
    expect(row.last_error!.startsWith(ACCEPTANCE_UNKNOWN)).toBe(true)
    expect(new Date(row.next_attempt_at).getTime() - NOW.getTime()).toBeGreaterThan(300 * 86_400_000)
    expect(summary.held_for_review).toBe(1)
  })
})

// ---------------------------------------------------- the read-only check

describe('the health check', () => {
  function provider(routes: Record<string, ProviderResponse>): Provider {
    return {
      async send() { throw new Error('the health check must not send') },
      async get(path: string) {
        const key = Object.keys(routes).find((p) => path.startsWith(p))
        if (!key) throw new Error(`unexpected read ${path}`)
        return routes[key]
      },
    }
  }

  const counts = async () => ({ pending: 1, processing: 0, failed_retrying: 0, failed_parked: 10, sent: 30, sent_without_provider_id: 6 })

  it('sends nothing and claims nothing', async () => {
    const report = await checkProvider({
      counts,
      provider: provider({
        '/account': { ok: true, status: 200, body: JSON.stringify({ plan: [{ type: 'free', credits: 296, creditsType: 'sendLimit' }] }) },
        '/senders': { ok: true, status: 200, body: JSON.stringify({ senders: [{ email: 'careers@jmac.test', active: true }] }) },
      }),
      senderEmail: 'careers@jmac.test',
    })
    expect(report.mode).toBe('read_only')
    expect(report.provider_access).toBe('ok')
  })

  it('reports an IP block for what it is', async () => {
    const report = await checkProvider({
      counts,
      provider: provider({
        '/account': refused(401, IP_BLOCKED_BODY),
        '/senders': refused(401, IP_BLOCKED_BODY),
      }),
      senderEmail: 'careers@jmac.test',
    })
    expect(report.provider_access).toBe('ip_blocked')
  })

  it('says whether the configured sender is one Brevo will use', async () => {
    const report = await checkProvider({
      counts,
      provider: provider({
        '/account': { ok: true, status: 200, body: '{"plan":[]}' },
        '/senders': { ok: true, status: 200, body: JSON.stringify({ senders: [{ email: 'Careers@JMAC.test', active: false }] }) },
      }),
      senderEmail: 'careers@jmac.test',
    })
    expect(report.sender).toEqual({ email: 'careers@jmac.test', found: true, active: false })
  })

  it('reports the queue as counts only', async () => {
    const report = await checkProvider({
      counts,
      provider: provider({
        '/account': { ok: true, status: 200, body: '{"plan":[]}' },
        '/senders': { ok: true, status: 200, body: '{"senders":[]}' },
      }),
      senderEmail: 'careers@jmac.test',
    })
    expect(report.queue).toEqual(await counts())
    expect(JSON.stringify(report)).not.toContain('@example.test')
  })

  it('looks up one message\'s delivery events when asked, and only reads', async () => {
    const report = await checkProvider({
      counts,
      provider: provider({
        '/account': { ok: true, status: 200, body: '{"plan":[]}' },
        '/senders': { ok: true, status: 200, body: '{"senders":[]}' },
        '/smtp/statistics/events': {
          ok: true,
          status: 200,
          body: JSON.stringify({ events: [{ event: 'delivered', date: '2026-10-03T08:01:00Z', email: 'x@example.test', subject: 'secret' }] }),
        },
      }),
      senderEmail: 'careers@jmac.test',
      messageId: '<m-1@smtp-relay.brevo.com>',
    })
    expect(report.message_events).toEqual([{ event: 'delivered', date: '2026-10-03T08:01:00Z', reason: null }])
  })
})

// ------------------------------------------------------- the HTTP client

describe('the Brevo client', () => {
  it('posts to the transactional endpoint with the key in a header, never the body', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return new Response('{"messageId":"<x>"}', { status: 201 })
    }) as unknown as typeof fetch

    const res = await brevoClient('xkeysib-test', fetchImpl).send({ subject: 'hi' })

    expect(seen[0].url).toBe('https://api.brevo.com/v3/smtp/email')
    expect(seen[0].init.method).toBe('POST')
    expect((seen[0].init.headers as Record<string, string>)['api-key']).toBe('xkeysib-test')
    expect(String(seen[0].init.body)).not.toContain('xkeysib-test')
    expect(res).toEqual({ ok: true, status: 201, body: '{"messageId":"<x>"}' })
  })
})
