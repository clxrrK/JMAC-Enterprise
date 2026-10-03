# Applicant notifications: Brevo IP refusal — recovery runbook

For whoever holds access to the JMAC-Enterprise Supabase project
(`joffopwzqmlqpsrbivfq`) and the Brevo account that sends applicant mail.

## What happened

The worker `send-applicant-notifications` sends applicant mail through Brevo's
HTTP API (`POST https://api.brevo.com/v3/smtp/email`, authenticated with
`BREVO_API_KEY` — an API call, not SMTP). A read-only inspection on 2026-10-03
found 10 notifications failed, each with **five** attempts used, each with
Brevo's `HTTP 401` reading *"We have detected you are using an unrecognised IP
address …"*, naming several different IPv6 addresses.

Supabase Edge Functions have no fixed outbound IP. With Brevo's unknown-IP
blocking active for API keys, a request from any address not on the authorised
list is refused. Brevo turns that blocking on **by itself**: a new API key runs a
"learning phase" that authorises the IPs it sees, and after 30 days without a
new IP it activates blocking and emails the account owner each blocked address.

The old worker could not tell "Brevo refuses this server" from "this message
failed", so it retried each row 1, 5, 30, 120 and 480 minutes later until every
row had spent its budget on a problem no retry can fix. Exhausted rows are never
retried, so fixing Brevo alone restarts nothing.

Supabase Auth's password-reset and invitation mail use a separate SMTP
integration. That mail working says nothing about this path, and this runbook
does not touch it.

## Order of operations

The order matters: deploy the worker **before** changing Brevo or requeueing
anything, so any refusal from here on costs no notification an attempt.

| # | Step | Writes? |
|---|------|---------|
| 1 | Refresh the evidence | No |
| 2 | Compare the deployed worker with the repository | No |
| 3 | Deploy the worker | Function only |
| 4 | Apply the recovery migration | Schema only |
| 5 | Change the Brevo setting | Brevo |
| 6 | Run the read-only health check | No |
| 7 | Controlled end-to-end test | Test data only |
| 8 | Triage the parked notifications | No |
| 9 | Requeue one, verify, then the rest; withhold the outdated | Named rows only |

### 1. Refresh the evidence

Run [`supabase/operations/applicant-notification-evidence.sql`](../supabase/operations/applicant-notification-evidence.sql)
in the SQL editor, section by section. Everything in it is a `SELECT`, and it
never selects a recipient address, name or payload. Record:

- the counts by status (section 1) — do not assume the 40 / 30 / 10 from the
  inspection still hold;
- when refusals started and whether any send succeeded after (section 3);
- whether cron is active and running every five minutes (section 4);
- what the worker has been answering (section 5). `TOKEN MISMATCH` or `VAULT
  TOKEN MISSING` there would be a second, separate fault.

Then check the Brevo account owner's inbox for Brevo's "blocked IP" emails and
compare their times and addresses with section 3.

### 2. Compare the deployed worker with the repository

```
supabase functions list --project-ref joffopwzqmlqpsrbivfq
supabase functions download send-applicant-notifications --project-ref joffopwzqmlqpsrbivfq
```

Download into an empty scratch directory and diff it against
`supabase/functions/send-applicant-notifications/index.ts` as of the commit
**before** this fix. Version 17 was the last one inspected. If they differ,
stop and reconcile before deploying.

### 3. Deploy the worker

```
supabase functions deploy send-applicant-notifications --project-ref joffopwzqmlqpsrbivfq
```

`verify_jwt = false` is set in `supabase/config.toml`; the worker's own Vault
token check is what authenticates it, and it is unchanged. Confirm with
`supabase functions list` that the version number went up.

**Do not call `?diagnostics=1` before this step.** On the old worker it is not
read-only: it processes the queue first, and can send mail.

### 4. Apply the recovery migration

```
supabase migration list --linked
```

Only `20261007000000_applicant_notification_recovery` should be pending. If
anything else is, stop — `db push` applies every pending migration. Then:

```
supabase db push --linked
```

It adds one log table and three operator functions. It sends nothing and
changes no existing row.

### 5. Change the Brevo setting

Only the Brevo account owner, or a user with the **SMTP & API – Authorized
IPs** permission, can do this. Two ways; choose one.

**A. Deactivate unknown-IP blocking for API keys — recommended, free.**
In Brevo: account menu → **Settings → Security → Authorized IPs**
(<https://app.brevo.com/security/authorised_ips>). Blocking is controlled
separately for **API keys** and **SMTP keys**. For **API keys**, if the status
reads *Activated*, click **Deactivate blocking**. Leave the SMTP-keys setting
and the authorised-IP list exactly as they are — Supabase Auth's mail depends
on them.

Consequence, in Brevo's words: it "reduces the security of your API keys".
Anyone holding the key can call Brevo from anywhere, so the key itself is the
only control. Mitigations that cost nothing: keep the key only as a Supabase
function secret (it already is — never in a `VITE_` variable, the bundle, the
database or a response); use a key dedicated to this worker so it can be
rotated alone; rotate it if it is ever exposed.

**B. Keep IP blocking — route the worker through a fixed IP.**
Supabase recommends an outbound proxy with a static IP for exactly this.
Options: a managed static-IP proxy (a paid subscription; price varies by
provider — get a quote), or a small server you run with an authenticated
forward proxy (a recurring hosting cost plus upkeep). Either needs a code
change to send Brevo requests through the proxy, a new secret for the proxy
credentials, and authorising the proxy's IP in Brevo. Not implemented here:
it is paid infrastructure and the account owner's decision.

**Not a fix:** authorising the addresses in the error messages. They change;
the next run comes from another. The database's IP is not the function's
either, and guessed cloud ranges authorise far more than JMAC.

### 6. Run the read-only health check

After step 3, `?diagnostics=1` returns before anything is claimed. Ask the
database to call it, so the token never leaves Vault:

```sql
select net.http_post(
  url := 'https://joffopwzqmlqpsrbivfq.supabase.co/functions/v1/send-applicant-notifications?diagnostics=1',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-jmac-notify-token', public.applicant_notify_token()),
  body := '{}'::jsonb,
  timeout_milliseconds := 30000) as request_id;

-- a few seconds later, with that id:
select status_code, content from net._http_response where id = <request_id>;
```

The answer must contain `"mode":"read_only"` — if it does not, the new worker
is not deployed; stop. Then expect:

| Field | Healthy | If not |
|---|---|---|
| `provider_access` | `ok` | `ip_blocked`: step 5 not in effect. `credentials`: `BREVO_API_KEY` is wrong, revoked or for another account. |
| `sender` | `found: true, active: true` | `BREVO_SENDER_EMAIL` is not a verified, active Brevo sender. Fix before sending anything. |
| `plans` | credits remaining | A spent daily allowance looks like delivery failure. |
| `queue` | counts only | — |

To check one accepted message's delivery events, add
`&messageId=<provider_message_id>` (URL-encoded) to the URL. Events come back
as names, dates and reasons only — `delivered`, `softBounces`, `blocked` and so
on. **An accepted message is not a delivered one;** this is how to tell.

Secrets can be checked without printing them:
`supabase secrets list --project-ref joffopwzqmlqpsrbivfq` shows names and
digests only — `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME`
should all be present.

### 7. Controlled end-to-end test

Before any real notification is requeued. Use a test applicant and a mailbox the
team owns; do not change any real applicant's application to test email.

1. Apply through the public form as the test applicant. Expect one new
   `application_submitted` row (evidence section 2, filtered to that
   application), claimed within seconds, `sent` with a `provider_message_id`.
2. On the **test** application only: shortlist it, schedule an interview,
   reschedule it, make an offer, then record a final outcome. Each action
   should produce exactly one new row, each sent with a message id.
3. For each message id: health check with `messageId` shows `delivered` (or a
   specific rejection reason). The email is in the test inbox — check spam —
   with the right reference code, a working tracking link, and the right
   event details (interview stage, date, time, place).
4. Repeat the worker without `diagnostics`; the reply's `considered` is `0`
   and the inbox gets no duplicates.
5. Wait ten minutes without invoking anything; evidence sections 4–5 show cron
   runs and worker replies (`worker: ran`) on their own.
6. Request a password reset for a team account; it still arrives (the
   separate SMTP path, untouched).

### 8. Triage the parked notifications

Run [`supabase/operations/applicant-notification-triage.sql`](../supabase/operations/applicant-notification-triage.sql).
For each parked notification it recommends, against the application's and
interview's **current** state:

- **send** — still true, and nothing later has reached the applicant;
- **withhold** — no longer true (offer since accepted, application since
  rejected, interview since moved or past) or overtaken by a delivered notice;
- **review** — needs a person, including any `[acceptance_unknown]` row.

It is a recommendation. Read every row.

### 9. Recover

Take a snapshot first (evidence section 2, saved somewhere access-controlled).
The functions also copy each row's prior state into
`applicant_notification_recovery_log` before changing it.

**One first.** Pick one `send` row:

```sql
select * from public.requeue_applicant_notifications(
  array['<one id>']::uuid[],
  '%unrecognised IP%',
  'Brevo unknown-IP blocking deactivated for API keys on <date>; controlled test passed');
```

It refuses anything sent, accepted, in a worker's hands, still being retried,
or not carrying the named error; it never takes more than 50 ids or a bare
wildcard. A requeued row keeps its id, dedupe key, event and payload; its
attempts restart at 0 and the worker is asked to run. Within a minute:
evidence section 2 shows it `sent` with a `provider_message_id`; the health
check with that id shows the delivery event.

**Then the rest** of the `send` rows, the same call with all their ids.

**Withhold** the `withhold` rows, with a reason the next person will understand:

```sql
select * from public.withhold_applicant_notifications(
  array['<id>', '<id>']::uuid[],
  'superseded: <what changed>, per triage on <date>');
```

A withheld row stays `failed`, parked, with `[withheld] <reason>`, and the
`%unrecognised IP%` requeue will not pick it up again.

**`[acceptance_unknown]` rows:** search Brevo's transactional log for the
recipient around the row's `claimed_at`. If Brevo has it, record it:

```sql
select public.record_applicant_notification_accepted(
  '<id>', '<message id from Brevo>', '<accepted at, from Brevo>'::timestamptz,
  'found in Brevo transactional log on <date>');
```

If Brevo does not have it, requeue it with `'%acceptance_unknown%'` as the
expected error.

Report: requeued, accepted (has a message id), delivery-confirmed (a
`delivered` event), failed, withheld — each a count, no identities.

## What changed in the worker

- A Brevo refusal of the server — `401` naming an unrecognised IP, any other
  `401`, or `403` — no longer spends the row's attempt. The run stops after one
  probe, records `[provider_ip_blocked]` or `[provider_credentials]` with
  Brevo's message, retries in five minutes, and answers `503` so it stands out
  in `net._http_response`.
- Every database error — claim, record, sweep — is logged; a failed claim is
  no longer mistaken for "another worker took it". An acceptance that cannot
  be recorded is retried, then logged with Brevo's message id and left claimed,
  so it is never resent.
- A claim abandoned for 15 minutes is parked as `[acceptance_unknown]` instead
  of sitting at "Sending" forever, and is never resent automatically.
- Each request carries the row id as Brevo's `idempotencyKey`; Brevo refuses a
  repeat for 30 minutes, and that refusal is held for review, not retried.
- `?diagnostics=1` is read-only and returns before anything is claimed.

Delivery is at-least-once with a 30-minute duplicate guard, not exactly-once.

## Rollback

- **Worker:** deploy the previous version from git
  (`git checkout <commit-before-this-fix> -- supabase/functions/send-applicant-notifications`
  in a scratch worktree, then `supabase functions deploy`). The old worker
  needs nothing from the migration.
- **Migration:** export `applicant_notification_recovery_log` first, then:

  ```sql
  drop function if exists public.requeue_applicant_notifications(uuid[], text, text);
  drop function if exists public.withhold_applicant_notifications(uuid[], text);
  drop function if exists public.record_applicant_notification_accepted(uuid, text, timestamptz, text);
  drop function if exists public.applicant_notification_recovery_refusal(public.applicant_notification_outbox);
  drop table if exists public.applicant_notification_recovery_log;
  ```

- **Brevo:** Settings → Security → Authorized IPs → reactivate blocking for API
  keys. Refusals resume; with the new worker they cost no attempts.
- A requeued notification that was sent cannot be unsent; the recovery log
  keeps what each row looked like before.
