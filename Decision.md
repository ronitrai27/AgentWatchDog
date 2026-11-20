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




## D-008 Brand name and first UI (landing + auth)
Date: 2026-11-19 | Status: Proposed
Files: src/app/layout.tsx, src/app/globals.css, src/app/(web)/page.tsx, src/app/(auth)/auth/page.tsx, src/components/*, public/auth-sketch.svg

**Your decision:** The agent is named "Rox". Landing page in `(web)` with a hero in the style of reference 2 and the engraved "meridian" footer; auth page in `(auth)` in the style of reference 3 with a person sketch and two placeholder buttons, "Continue with GitHub" and "Quick Judge Mode". The footer spec (tokens, video, CSS, breakpoints) was given in full.
**Agent's decision:** Footer reproduced as specified, rebranded to "rox" with product nav and tagline. One shared sage palette for all pages rather than the beige of reference 3. The hero shows a labelled sample run trace and a strip of real integration names; no invented customer logos or testimonials. The auth quote is product copy with no fake person attributed. The sketch is a hand-drawn placeholder SVG. Both buttons do nothing yet.
**Why:** Invented customers and quotes would be false claims on a hackathon product that judges will read. One palette keeps the footer's multiply-blend seamless.
**Consequence:** Buttons need real handlers once auth and demo workspace exist. The footer video is a third-party CDN URL and the page depends on it. Fonts load through `next/font` (Fraunces, Inter) instead of the Google Fonts link in the spec.

## D-009 Animated sample run in the hero; footer video retry
Date: 2026-11-19 | Status: Proposed
Files: src/components/run-panel.tsx, src/components/hero.tsx, src/components/rox-footer.tsx

**Your decision:** Hero headline "For Developers Who Swear, It Wasn't Their Fault." with subheading "Production breaks at 3 a.m. Rox is already on it." The white dashboard should look realistic: Rox working, tracing, security scans, testing. The footer video was not showing on your screen.
**Agent's decision:** A client-side panel replays a scripted sample run on a loop: stepper, append-only trace with ALLOW/DENY/PASS verdicts (including a blocked injection attempt), a 12-gate verification matrix (reproduction, mutation, property tests, k6, Semgrep, Gitleaks, OSV, ZAP, BOLA) and an outputs bar. It is captioned as a simulated run with sample data. The footer video now also retries playback on first interaction, because low-power or battery-saver modes can block autoplay.
**Why:** It shows the product's flow and guardrails without a backend, and the caption keeps it honest. The video URL itself returned 200 and played in testing.
**Consequence:** The gates shown (mutation, property tests, k6, Semgrep, ZAP, BOLA) are the planned design, not built yet; Architecture.md §4 still lists the older stages. The footer shows no bridge until the video plays, since there is no poster image.

## D-010 Footer video replaced by a vector scene; auth page rebuilt
Date: 2026-11-20 | Status: Proposed
Files: src/components/viaduct-scene.tsx, src/components/rox-footer.tsx, src/components/rox-stack.tsx, src/components/connection-logos.tsx, src/app/(auth)/auth/page.tsx, src/app/globals.css
Supersedes the video and sketch parts of D-008 and the video retry part of D-009.

**Your decision:** The footer video did not show for you, so use something else. Remove the sketch. New footer slogan ("Built to run overnight. Reproduces real failures, audits every change, and closes the loop across your stack."). New auth heading and slogan about 3 a.m. incidents and halting in code. On the auth right side, an isometric vector animation of Rox working, in the style of your reference, with the connection logos from `public/` below it.
**Agent's decision:** The footer scene is now inline SVG and CSS: an engraved stone viaduct, night sky, and a steam train that crosses on a loop. No external file, so it cannot fail to load. The auth animation is a five-layer stack (Signal, Reproduce, Guardrails, Verify, Publish) that lights up in turn with a caption of what Rox is doing. GitHub and Vercel logos are drawn inline because `vercel-color.svg` in `public/` contains only the text "404: Not Found". Sentry and Linear files are white, so they are darkened with a CSS filter.
**Why:** The video depended on a third-party CDN and on the visitor's browser allowing autoplay; the vector scene has neither problem. Layer labels reuse the architecture's real stages.
**Consequence:** `public/vercel-color.svg` is still broken and unused; replace it if you want the official Vercel logo. Reduced-motion users see a still train and a static stack. The stack captions show sample numbers.
