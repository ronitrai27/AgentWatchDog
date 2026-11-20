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

## D-006 PR runtime failure trigger (opt-in, not code review)
Date: 2026-11-18 | Status: Proposed
Files: Architecture.md

**Your decision:** Not a code reviewer and does not trigger on "PR opened" for review, but can also respond to PR signals.
**Agent's decision:** Support opt-in PR runtime failure triggers (`check_suite` / `workflow_run` failed, failed preview deploy, or PR TestSprite failure) while explicitly ignoring plain `pull_request.opened` and all `awd/*` branches. Publish fixes as a child PR `awd/pr-<num>-<sha>` targeting the PR branch rather than pushing directly onto it.
**Why:** Gives developers autonomous CI/preview failure remediation on PRs without turning the product into a noisy diff-commenting code reviewer or causing self-trigger loops.
**Consequence:** Requires loop-prevention filtering on `awd/*` branches and target-branch selection in `Publish`.

## D-007 Two-phase sandbox & host-side TestSprite bridge
Date: 2026-11-18 | Status: Proposed
Files: Architecture.md, docs/Research.md

**Your decision:** Verify builds, tests, and TestSprite tests in a sandboxed workflow.
**Agent's decision:** Split dependency installation into a lockfile-cached Builder phase so runtime containers stay `--network=none` and secretless. Keep `TESTSPRITE_API_KEY` on the host Tool Proxy and bridge TestSprite cloud execution only to the patched app's single mapped `127.0.0.1` HTTP port when TestSprite is connected; skip cleanly to local suites if not connected.
**Why:** An air-gapped container cannot run `pnpm install` or hold a TestSprite API key to reach TestSprite's cloud runners; host-side tunneling preserves zero egress and zero secrets inside the sandbox.
**Consequence:** Adds a lockfile-keyed image/cache build step and a host-side tunnel bridge component (`agent/src/tools`).

## D-011 GitHub App for real mode, Quick Judge Mode for everyone else
Date: 2026-11-20 | Status: Proposed
Files: Architecture.md (§9.1, §9 auth, §10), .env.example, .gitignore
Supersedes the single-owner statement in D-001-era Architecture §9. Refines the manifest flow in §10, which is now self-host only.

**Your decision:** Use a GitHub App so users and judges who want to test for real install Rox on as many repos as they pick, with a clear Rox identity and no webhook setup. Everyone else uses Quick Judge Mode. The App is registered as "Rox WatchDog" (App ID 5843582) with the webhook at a smee.io relay URL for development.
**Agent's decision:** One shared public App for the hosted demo. Sign-in and install happen in one step, and the callback verifies the installation belongs to the signed-in user. Only the installation id is stored; each run mints a 1-hour, single-repo token, read-only except inside Publish. Planned permissions: Metadata read, Contents read and write, Pull requests read and write, Checks read, Actions read; no Workflows, Administration, Secrets or Issues. Rejected: OAuth `repo` scope (full control of all repos) and personal access tokens (manual paste).
**Why:** The consent screen shows a short, honest permission list with a repo picker, and the missing Workflows permission makes GitHub itself block edits to CI files.
**Consequence:** The live App as registered on 2026-11-20 does NOT match this plan: it has Workflows, Statuses, Security events, Issues and Repository webhooks write, lacks Contents and Actions, and subscribes to check_run, issues and pull_request but not push or workflow_run. It must be corrected on GitHub before anyone installs it. Contents write can push to any unprotected branch, so users should protect `main`. Sentry, Vercel and Datadog alerts still need their own webhook URL.

## D-012 Sign-in slice: signed cookie session, no database yet
Date: 2026-11-20 | Status: Proposed
Files: src/lib/session.ts, src/lib/github-app.ts, src/app/api/auth/**, src/app/(app)/dashboard/page.tsx, src/app/(auth)/auth/page.tsx, .env.example

**Your decision:** Continue building sign-up with the GitHub App; ignore remaining permission mismatches for now.
**Agent's decision:** Sign-in uses the App's own authorization (identity only). The callback checks a CSRF state cookie, exchanges the code, reads the user and `GET /user/installations` (which proves the installation belongs to them), then discards the user token. The session is an HMAC-signed HTTP-only cookie holding the user id, login and verified installation ids. No Postgres yet. The dashboard reads each installation with an App JWT and lists repos using a token minted with `metadata: read` only, and flags any permission beyond what Rox needs. Quick Judge Mode sets a `demo` session. Rejected: storing user tokens, and adding Postgres in this slice.
**Why:** It is the smallest flow that is fully verifiable now, and it keeps GitHub credentials out of storage. The permission audit turns the "short, honest permissions" promise into something users can see.
**Consequence:** Installations are not mapped to users server-side, so the agent service cannot route webhooks to a user until the Postgres table exists. The live App still grants Workflows, Issues, Statuses, Security events and Repository webhooks (write) and subscribes to the wrong events; the dashboard shows these as "Broader than Rox needs" until the App is corrected. Cookie sessions cannot be revoked server-side before expiry.

## D-013 Signed-in landing is /home and starts empty
Date: 2026-11-20 | Status: Proposed
Files: src/app/(app)/home/page.tsx, src/app/api/auth/demo/route.ts, src/app/api/auth/github/callback/route.ts

**Your decision:** Rename `/dashboard` to `/home`, remove the installation and permissions panels from it, and leave it empty for now.
**Agent's decision:** `/home` shows only the header (Rox mark, user, Sign out) behind the session check. Both sign-in paths redirect there. The old `/dashboard` route no longer exists. The permissions audit code stays in `src/lib/github-app.ts` unused, so it can come back on a settings page.
**Why:** Matches the request, and keeps the audit logic from being rewritten later.
**Consequence:** Users cannot currently see which repos Rox can reach or change them from inside Rox, only on GitHub. Your App was installed on "All repositories", which is wider than needed; narrow it at github.com/settings/installations.
