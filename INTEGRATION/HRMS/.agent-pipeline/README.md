# JMAC Agent Pipeline v1

Purpose: automate the handoff loop between Claude Code (builder) and Codex (QA) while preserving human approval at production-write boundaries.

## Roles

- **Claude Code**: implement/fix and run implementation verification within the current risk policy.
- **Codex**: read-only QA, exploratory workflow testing, UX-confusion review, regression verification. Never fixes code.
- **Supervisor**: launches each agent, captures reports/logs, parses verdicts, advances or loops, and stops at human gates.
- **User**: approves sensitive production writes, destructive operations, payment/disbursement completion, rollbacks, and other explicit gates.

## Files

Tracked configuration/templates:

- `config.json` — agent CLI commands, iteration limit and risk policies.
- `state.example.json` — template for local runtime state.
- `tasks/claude-task.example.md` — Claude task template.
- `tasks/codex-task.example.md` — Codex task template.
- `prompts/claude-system.md` — builder contract.
- `prompts/codex-system.md` — QA contract.
- `run-agent-pipeline.mjs` — local supervisor.

Local runtime files created by `init` and ignored by Git:

- `state.json`
- `tasks/claude-task.md`
- `tasks/codex-task.md`
- `reports/claude-report.md`
- `reports/codex-report.md`
- `logs/*.log`

This keeps agent handoff state out of production commits while preserving reusable policy/templates in the repository.

## Safety model

Every task starts with:

```text
PIPELINE_PHASE: <phase>
PIPELINE_RISK: LOCAL_ONLY|COMMIT_ALLOWED|DEPLOY_ALLOWED|PRODUCTION_WRITE_GATE
```

Policies:

- `LOCAL_ONLY` — Claude may edit/test locally, but no commit/push/deploy/production business writes.
- `COMMIT_ALLOWED` — local implementation and commit allowed, no push/deploy/production business writes.
- `DEPLOY_ALLOWED` — commit/push/deploy allowed only when the task explicitly requires it; production business-data writes remain prohibited.
- `PRODUCTION_WRITE_GATE` — stop before the sensitive write and ask the user.

Codex always runs with its CLI `read-only` sandbox in this v1 pipeline.

Claude runs in Claude Code `auto` permission mode rather than bypassing permissions. The task wrapper still applies the stricter JMAC risk policy.

Never automate by default:

- destructive/reset DB operations
- production business-data repair
- completion of supplier/reimbursement/payroll payments
- production payroll disbursement
- production rollback
- force push
- rewriting already-applied migrations

## First-time setup on Windows

From your existing checkout:

```powershell
cd C:\Projects\JMAC
git fetch origin
git switch automation/agent-pipeline-v1
cd INTEGRATION\HRMS
npm run agents:init
npm run agents:doctor
```

`agents:doctor` checks that Node, Git, Claude Code and Codex CLI are visible to the same shell and that the project is a Git repository.

If `claude` or `codex` is not found, fix the CLI/PATH/authentication first. Do not change the supervisor to bypass the missing tool.

## Choose the starting direction

Normal implementation flow:

```powershell
npm run agents:run
```

Sequence:

```text
Claude implementation
→ Codex QA
→ PASS = finish
→ FAIL = findings automatically fed to Claude
→ repeat up to maxIterations
```

QA-first flow (useful when Claude already deployed something and Codex should inspect it first):

```powershell
npm run agents:qa
```

Sequence:

```text
Codex QA first
→ PASS = finish
→ FAIL = findings fed to Claude
→ Claude fix
→ Codex retest
→ repeat
```

That is the recommended entry point for the current F7 acceptance work.

## Prepare tasks

After `npm run agents:init`, edit the ignored local files:

```text
.agent-pipeline/tasks/claude-task.md
.agent-pipeline/tasks/codex-task.md
```

For a QA-first run, `codex-task.md` should contain the complete acceptance/exploratory scope. `claude-task.md` should describe the authority and constraints for fixing any findings Codex may return.

Keep the risk line explicit. Example:

```text
PIPELINE_PHASE: F7
PIPELINE_RISK: LOCAL_ONLY
```

If you later want Claude to commit a fix automatically, change only the Claude task to:

```text
PIPELINE_RISK: COMMIT_ALLOWED
```

Do not use `DEPLOY_ALLOWED` casually. Production deployment should remain an intentional phase decision.

## Human gates

The supervisor stops immediately when either agent returns:

```text
PIPELINE_VERDICT: HUMAN_GATE
```

It also stops when the configured iteration limit is reached.

Use a human gate immediately before any acceptance step that would record real production money movement or another explicitly sensitive production write.

## Report contract

Both agents must end their final message with:

```text
PIPELINE_VERDICT: PASS|FAIL|HUMAN_GATE
PIPELINE_SEVERITY: NONE|LOW|MEDIUM|HIGH|BLOCKER
PIPELINE_SUMMARY: <one concise line>
```

Supervisor behavior:

- Claude `PASS` → Codex QA
- Claude `FAIL` → stop for inspection
- Claude `HUMAN_GATE` → stop for user
- Codex `PASS` → pipeline finishes successfully
- Codex `FAIL` → Codex report is automatically included in the next Claude prompt
- Codex `HUMAN_GATE` → stop for user

If an agent omits this contract, the supervisor treats the run as a failure rather than guessing.

## Runtime inspection

Current state:

```powershell
npm run agents:status
```

Latest reports:

```text
.agent-pipeline/reports/claude-report.md
.agent-pipeline/reports/codex-report.md
```

Per-iteration stdout/stderr logs:

```text
.agent-pipeline/logs/
```

## v1 limitation

This first version intentionally orchestrates local CLI sessions rather than trying to control the visible VS Code chat panels. The repository, task files and reports are the handoff protocol. That is more reliable and auditable than screen-scraping Claude Code or Codex UI output.

A later v2 can add worktrees, structured JSON schemas, GitHub PR/check integration, notifications, and explicit production-approval resume commands after this local loop is proven stable.
