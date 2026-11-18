# Decision log

Every change to this repo that involves a choice gets an entry here, written in the same change as the code.

## How to add an entry

Copy this block to the bottom of the log and fill it in.

```
## D-000 Short title
Date: YYYY-MM-DD | Status: Proposed / Agreed / Superseded by D-xxx
Files: paths this decision touched

**Your decision:** what the project owner asked for or chose, in their terms.
**Agent's decision:** what the coding agent chose within that, and what it rejected.
**Why:** the reason, in one or two sentences.
**Consequence:** what this costs or rules out.
```

Rules:

- "Your decision" records only what the owner actually said. If they gave no direction, write "None given".
- An agent's choice the owner has not confirmed is `Proposed`, not `Agreed`.
- Never edit a past entry's meaning. Add a new entry and mark the old one superseded.

---

## D-001 Product scope
Date: 2026-11-16 | Status: Proposed
Files: Architecture.md

**Your decision:** An autonomous agent that acts like a senior SRE: it handles Sentry or PostHog errors, high-traffic alerts and testing of pushed code, with little human approval. Humans merge. It must not be a code-review bot.
**Agent's decision:** One core loop (production error to verified PR). Testing is the gate inside that loop, not a separate feature. Traffic alerts are a diagnose-and-propose path. No "PR opened" trigger. No reproduction means no PR.
**Why:** The hackathon scores a narrow agent that finishes above a broad one that half-works, and proof of the fix is what separates this from existing tools.
**Consequence:** Bugs the agent cannot reproduce get an escalation, not a fix.

## D-002 Skill discovery
Date: 2026-11-16 | Status: Proposed
Files: Architecture.md, skills/

**Your decision:** Skills (agentskills.io format) so the agent knows how to do tasks such as filing Linear issues and posting to Slack.
**Agent's decision:** One folder per runbook in `skills/`. Names and descriptions load at start; the body loads on use. A skill is hidden when its required connection is missing, and the gap is reported.
**Why:** Keeps context small and turns a missing connection into a visible alert.
**Consequence:** Permissions are enforced by the guardrails, not by the skill file.

## D-003 Sandbox
Date: 2026-11-16 | Status: Proposed
Files: Architecture.md

**Your decision:** Sandboxes to run code.
**Agent's decision:** A local Docker container per run with no network and no secrets as the default. A hosted sandbox can be added as an option.
**Why:** Judges need no extra account or key.
**Consequence:** The agent container needs access to the Docker daemon to start sandboxes, which is a real privilege and must be documented.

## D-004 Guardrails live in code
Date: 2026-11-16 | Status: Proposed
Files: Architecture.md

**Your decision:** Controlled execution: budgets, permissions, approvals, audit trail, stop conditions.
**Agent's decision:** A policy check on every tool call, three action tiers, three trust zones, and "never" actions that have no tool at all.
**Why:** Injected text can change what a model wants to do, but not what the harness lets it do.
**Consequence:** Some useful actions stay behind an approval.

## D-005 Models
Date: 2026-11-16 | Status: Proposed
Files: Architecture.md, agent/src/config

**Your decision:** LangGraph, with LLM models chosen per task, all from OpenAI but different models.
**Agent's decision:** One model per node, set in config rather than in code: a small, cheap model for triage, a stronger one for investigate and fix, and a separate model for the verifier so it is not grading its own model's output. Exact model names are not chosen yet.
**Why:** Triage is a classification and does not need the most expensive model; the verifier is more useful when it differs from the generator.
**Consequence:** Judges need an OpenAI key and the models named in `.env.example` must be available on their tier. Provider code should sit behind one small interface so it can change later.

---

