## Guardrails:

⚡ Pro tip: Write guardrails as code that runs outside the model, never as instructions inside the prompt. "Please don't refund more than $500" is a suggestion a model can be talked out of. A function that raises an error at $501 is a wall. Only one of those survives a determined edge case.

# Link - https://promptabcd.com/blog/building-guardrails-for-ai-agents

In early AI implementations, guardrails usually referred to model-safety measures: mechanisms intended to prevent offensive language, hallucinations, or the disclosure of PII. Those measures are still necessary, but they are not enough for agentic systems that can invoke shells, modify databases, or interact with third-party APIs.
In production systems, guardrails need to be understood as a runtime architecture that defines the operational boundaries of an autonomous system. They are the mechanisms that determine:

Permission boundaries: which tools, data, and credentials the agent can access.
Interruption points: the moments when execution must stop for approval, validation, or policy checks.
Routing logic: whether an issue should go to a human, a deterministic rule, or a narrower fallback path.
State and recovery: how the system tracks progress, avoids duplicate actions, and resumes safely after failure.

# Link - https://www.codebridge.tech/articles/ai-agent-guardrails-for-production-kill-switches-escalation-paths-and-safe-recovery


Guardrails
Destructive or irreversible actions (delete, send, pay, deploy, overwrite) require confirmation, or are blocked by policy enforced in code. Not in the prompt. In code.

Live Monitoring
A real-time view of what the agent is doing right now and why: current step, tool calls, decisions, cost so far. Dashboard, terminal UI or stream, your call.

Kill Switch
One action stops everything, immediately, mid-run. Pending tool calls are cancelled, not finished. Show it working in your demo.

Audit Trail
Every action logged with enough detail that a human can reconstruct and replay what happened after the fact.



According to OWASP’s 2025 Top 10 for LLM Applications, prompt injection remains the number-one vulnerability in deployed LLM systems. As AI agents move from prototypes to production, your validation layers need to sit between user input and your LLM, between your LLM and your tools, and between your agent’s output and your end user.

# Link - https://mastra.ai/articles/guardrails

## TestSprite Architecture & Sandbox Integration

- **What TestSprite actually is:** An autonomous cloud-executed QA platform (`@testsprite/testsprite-cli` and `@testsprite/testsprite-mcp`) authenticated via `TESTSPRITE_API_KEY`.
- **Two test types:**
  1. **Backend / API tests:** Functional API workflows, contract/schema validation, data integrity across requests, error handling, and basic auth validation.
  2. **Frontend / E2E tests:** Real browser (Playwright) journeys executed in TestSprite's cloud runner — navigation, forms, visual/DOM state, auth flows, and UI error handling. Returns structured failure bundles (`--output json`) and deterministic exit codes (`0` pass, `1` fail).
- **Local / sandbox server testing:** Because TestSprite executes tests from its cloud sandboxes, testing an un-deployed app running inside a local container requires an encrypted outbound reverse tunnel (`testsprite tunnel start` or automatic loopback tunnel via CLI/MCP) using `run:tunnel` API key scope.
- **Architectural consequence for AgentWatchdog:** The code-execution sandbox itself must remain **network-isolated (`--network=none`) and secretless** (`TESTSPRITE_API_KEY` must never enter the sandbox). Therefore, TestSprite must run from the **host-side Tool Proxy**, tunneling *only* to the patched app's single mapped local HTTP port (`127.0.0.1:<ephemeral-port>`), and must be treated as an **optional connection** with graceful fallback to the repo's local unit/integration/Playwright test suite.

## Official Remote MCP Servers & Extensible Connections

- **Linear (`https://mcp.linear.app/mcp`):** Official remote MCP over Streamable HTTP with OAuth 2.1 (plus read-only endpoint `/readonly` or API token). Creates/updates issues, projects, comments.
- **Slack (`https://mcp.slack.com/mcp`):** Official remote MCP with OAuth (`xoxp-` user/bot scoped tokens respecting workspace channel permissions). Reads threads, posts reports. Interactive approvals use Slack Block Kit webhooks back to the Agent API.
- **Sentry (`https://mcp.sentry.dev/mcp` or `@sentry/mcp-server`):** Official MCP for pulling issue details, stack traces, breadcrumbs, and events.
- **Zero-trust rule for any added MCP server:** Connecting a new MCP server (Jira, Notion, PagerDuty, Datadog, Postgres read-only) must never auto-expose raw write tools to the LLM. On startup, the Tool Proxy runs `listTools()` and classifies each tool into a strict manifest (`read`, `zone3_templated_write`, `approve`, or `deny` by default).

## Enterprise Trust, Long-Running Durability & Easy Stranger Setup

- **Durable execution & queue:** Webhooks must return `202 Accepted` immediately and enqueue work in Postgres (`SKIP LOCKED` + worker lease/heartbeat). LangGraph `PostgresSaver` checkpoints every node; side-effecting nodes use an idempotency outbox table so crash-resumes never duplicate PRs, Linear issues, or Slack posts.
- **LangGraph `interrupt()` pitfall:** When a paused graph resumes with `Command(resume=...)`, the interrupted node **re-runs from the beginning**. Therefore, sending an approval prompt (e.g., Slack Block Kit message) must live in a node *before* the `interrupt()` node (or be guarded by an idempotency key) so resuming does not re-notify humans.
- **Two-phase sandbox build:** An air-gapped `--network=none` sandbox cannot run `pnpm install` / `npm install`. Dependencies must be pre-baked in a separate **Builder** phase (keyed by lockfile hash) before the zero-network ephemeral run container executes build, repro, fix, and tests.
- **One-click GitHub App Manifest flow:** Self-hosted tools eliminate manual PEM/webhook/permission setup by submitting a `<form POST>` with a JSON manifest to `https://github.com/settings/apps/new` and exchanging the returned temporary `code` at `/app-manifests/{code}/conversions` for App ID, Webhook Secret, and Private Key automatically.
- **Local webhook relay for strangers:** Pairing setup with an optional tunnel (`awd tunnel` via Cloudflare Quick Tunnel or `smee.io`) lets a stranger test real GitHub/Sentry/Slack webhooks on a laptop in minutes without DNS or reverse-proxy setup.
