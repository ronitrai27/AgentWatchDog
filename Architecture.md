# AgentWatchdog architecture


## 1. What it is

AgentWatchdog is an autonomous, self-hosted first responder built for **individual developers and solo builders** to run on their own apps (with production-grade guardrails). You connect your own GitHub, Sentry, Linear, Slack, TestSprite, or custom MCP tools. When a production signal arrives (a Sentry error, a failed deploy, a traffic or latency alert) — or a concrete runtime failure on a pull request (failed CI check, failed preview deploy, or failed TestSprite E2E run) — the agent investigates, reproduces the failure in an air-gapped sandbox, writes a fix, proves the fix with deterministic tests and optional TestSprite E2E verification, opens a pull request on its own branch, files a Linear issue and reports to Slack (plus any connected MCP apps). **You always merge.**

It is **not** a code-review bot. It never leaves style comments on `pull_request.opened`. It triggers only on runtime signals: production errors/alerts (primary), post-merge `main` smoke regressions, and failed CI/preview/TestSprite checks on PRs (opt-in, ignoring `awd/*` branches to prevent loops).

Four rules define the product:

1. **No reproduction, no PR.** A fix is only published if a test that failed before the fix passes after it.
2. **Stops are enforced in code.** Budgets, path policies, branch restrictions, and the kill switch live in the harness, never in a prompt.
3. **Human merges, agent proposes.** No tool for merge, push-to-main, or production deploy exists in the runtime.
4. **Every run leaves a trace.** Every webhook, model call, tool decision, sandbox hash, and approval is logged durably.

### Two agents, one database

- **The pipeline** (`pipeline/`) is the autonomous agent: the fix agent in `pipeline/agent` (cloned from `Tests/Agent_2`), its shared checks and sandbox code in `pipeline/src`, the sandbox image in `pipeline/sandbox`, and the Temporal worker and workflows in `pipeline/temporal`. Only triggers start it (webhooks in `src/app/api/webhooks/*`, or `pnpm lab`). No model decides whether a run starts. Temporal and the sandbox belong to the pipeline alone.
- **The chat agent** (`agent/`) answers the user. It never runs the pipeline: it reads what the pipeline wrote.
- **The trace** is the `runs` table (one row per run: who started it, how, the event, status, outcome, pull request, duration, tokens, cost) and `run_events` (every step, in order). The pipeline writes both through `pipeline/src/events.ts` and `pipeline/src/runs.ts`. Each new event is announced with `pg_notify('run_events', ...)` for a live SSE view.
- Webhook handlers live in `src/lib/webhooks/<source>.ts`; their routes in `src/app/api/webhooks/<source>/route.ts`.

