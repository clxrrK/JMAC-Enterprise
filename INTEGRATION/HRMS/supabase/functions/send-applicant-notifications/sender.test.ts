/** The recruitment sender — contract tests.
 *
 * Written after every applicant email silently failed. The sender was hardcoded
 * to no-reply@jmac-enterprise.com, a domain JMAC does not own and never
 * authenticated with Brevo. Brevo accepted each API call, returned 2xx, and
 * then rejected the message: "Sending has been rejected because the sender
 * no-reply@jmac-enterprise.com is not valid".
 *
 * The outbox recorded seven sends. The applicant received nothing. Nothing in
 * JMAC could have shown the difference, because a wrong sender looks exactly
 * like success at the point where success is recorded.
 *
 * These check the rules that make that impossible to repeat.
 *
 * Run: npx vitest run supabase/functions/send-applicant-notifications/sender.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
/** The send, the claim and the retry rules live here now, extracted so their
 *  failure handling can be tested for behaviour (delivery.test.ts). These
 *  contract checks read both files, so moving a rule cannot drop it. */
const delivery = readFileSync(join(__dirname, 'delivery.ts'), 'utf8')

/** The address that could not deliver. */
const INVALID_SENDER = 'no-reply@jmac-enterprise.com'

/** Strip comments so the checks below read executable code only. Historical
 *  references in comments are allowed and wanted; a live one is the defect. */
function executableCode(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

const entry = executableCode(source)
const code = `${entry}\n${executableCode(delivery)}`

describe('the recruitment sender', () => {
  it('is not the unverified jmac-enterprise.com address', () => {
    expect(code).not.toContain(INVALID_SENDER)
  })

  it('mentions that address only as history', () => {
    // The explanation is worth keeping; it is why the rule exists.
    expect(source).toContain(INVALID_SENDER)
  })

  it('comes from server-side configuration', () => {
    expect(code).toContain("Deno.env.get('BREVO_SENDER_EMAIL')")
    expect(code).toContain("Deno.env.get('BREVO_SENDER_NAME')")
  })

  it('has no fallback address of any kind', () => {
    // A default sender is the whole bug: it substitutes something plausible
    // for something verified, and the failure surfaces days later.
    const senderLine = code.split('\n').find((l) => l.includes("Deno.env.get('BREVO_SENDER_EMAIL')"))
    expect(senderLine).toBeDefined()
    expect(senderLine).not.toMatch(/\?\?\s*['"]/)
    // No bare email literal survives anywhere in executable code.
    expect(code).not.toMatch(/email:\s*['"][^'"]+@[^'"]+['"]/)
  })

  it('fails closed when the sender is not configured', () => {
    expect(entry).toContain('BREVO_SENDER_EMAIL is not configured')
    // Refused before the delivery loop runs, so nothing is attempted and
    // nothing is recorded as sent.
    const guard = entry.indexOf('BREVO_SENDER_EMAIL is not configured')
    const send = entry.indexOf('deliverDue(')
    expect(guard).toBeGreaterThan(-1)
    expect(send).toBeGreaterThan(guard)
  })

  it('keeps the applicant-facing display name', () => {
    expect(code).toContain("'JMAC Enterprise'")
  })
})

describe('what the worker records', () => {
  it('only marks a row sent when the provider accepted it', () => {
    expect(code).toContain('if (res.ok)')
    const ok = code.indexOf('if (res.ok)')
    const marksSent = code.indexOf("status: 'sent'")
    expect(marksSent).toBeGreaterThan(ok)
  })

  it('records a provider failure as failed, not sent', () => {
    expect(code).toContain("status: 'failed'")
    expect(code).toContain('HTTP ${res.status}')
  })

  it('stores the provider message id for later diagnosis', () => {
    expect(code).toContain('provider_message_id')
    expect(code).toContain('messageId')
  })

  it('still sends to the applicant, not to the sender', () => {
    expect(code).toContain('to: [{ email: row.recipient_email, name: row.recipient_name }]')
  })
})

describe('the delivery machinery is preserved', () => {
  it('keeps the worker token gate', () => {
    expect(code).toContain('x-jmac-notify-token')
    expect(code).toContain('tokensMatch')
  })

  it('keeps retry and backoff bounded', () => {
    expect(code).toContain('BACKOFF_MINUTES')
    expect(code).toContain('MAX_ATTEMPTS')
  })

  it('claims only rows that still need sending', () => {
    expect(code).toContain("in('status', ['pending', 'failed'])")
  })

  it('tells a failed token lookup from a missing token, and refuses both', () => {
    // One production run failed its lookup between two healthy runs and was
    // reported as "not configured" -- the wrong diagnosis.
    expect(entry).toContain('Could not verify the delivery token.')
    expect(entry).toContain('Delivery is not configured.')
    expect(entry).toMatch(/could not read applicant_notify_token[^`]*\$\{tokenError\.message\}/)
    // Both before the gate, so neither path runs anything unverified.
    const gate = entry.indexOf('tokensMatch(presented')
    expect(entry.indexOf('Could not verify the delivery token.')).toBeLessThan(gate)
    expect(entry.indexOf('Delivery is not configured.')).toBeLessThan(gate)
  })

  it('answers the health check before anything is claimed or sent', () => {
    // diagnostics=1 used to run AFTER the queue had been processed, so a
    // health check was a delivery run. It must return first -- and only after
    // the token gate, since it reads the provider account.
    const gate = entry.indexOf('tokensMatch(presented')
    const check = entry.indexOf("searchParams.get('diagnostics')")
    const answered = entry.indexOf('await checkProvider(')
    const deliver = entry.indexOf('deliverDue(')
    expect(gate).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(gate)
    expect(answered).toBeGreaterThan(check)
    expect(deliver).toBeGreaterThan(answered)
    // And the branch returns rather than falling through into delivery.
    expect(entry.slice(check, deliver)).toMatch(/return json\(\s*await checkProvider\(/)
  })

  it('never puts a secret in the response', () => {
    expect(code).not.toMatch(/json\(\{[^}]*brevoKey/)
    expect(code).not.toMatch(/json\(\{[^}]*serviceRoleKey/)
    expect(code).not.toMatch(/json\(\{[^}]*expectedToken/)
  })
})
