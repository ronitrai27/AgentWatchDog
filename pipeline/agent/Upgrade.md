# Agent_2 upgrade plan: CodeIndex and the Cloudflare security-audit skill

Written 2026-11-27; revised the same day. The first version planned to use Graphify for reach. After reading its repository and checking the demo app, reach now comes from the TypeScript compiler (`CodeIndex`), and Graphify is an optional experiment (§9).

This is the reasoning behind upgrades U1–U8 in `Tests/Task.md`. Statements about the original agent come from reading its code; statements about the tools come from their own pages and files (listed at the end). Anything not yet checked by running it is marked **to verify**.

---

## 1. The problem

The original agent (`Tests/src/agent/`, checks in `Tests/src/checks.ts`) chooses checks by file names and runs the rest every time. For example:

- `touchesServer` treats any source file inside a service folder as server code.
- `touchesRoutes` is a file-name regex. It matches `identity.routes.ts` but not `identity.middleware.ts`.
- Semgrep scans the whole of `/src`, so an old finding fails every pull request.
- Trivy always runs. OSV runs whenever a lockfile exists.

The agent also has no idea how far a change reaches. Its only search is `search_code`: exact text, through `grep`, over `.ts/.tsx/.js/.mjs/.json/.sql`, so `.jsx`, `.cjs`, `.mts` and `.cts` are missed. There is no security review beyond Semgrep's rules. The fix agent starts only when tests or TypeScript fail.

What should decide the work is **what** changed and **what it reaches**, not how many files changed.

---

## 2. The demo app, because the plan depends on it

The lab's target is `ronitrai27/Testing_SRE_Demo_App` (Saltmarket), read from a cached checkout:

- **The API is Express** (`apps/api/src/app.ts`). It is the only service in `fixtures/.../stage.json`. `apps/web` is Next.js and not a service there.
- **Auth is wired by passing functions as values:**
  ```ts
  app.use(identity.loadUser);                                   // every request
  const catalog = createCatalogModule({ db, requireAdmin: identity.requireRole("admin") });
  // catalog.routes.ts
  .post("/", requireAdmin, handler)  .patch("/:slug", requireAdmin, …)  .delete("/:slug", requireAdmin, …)
  ```
- **Route files** are `*.routes.ts`. Middleware is `identity.middleware.ts`.
- **No outgoing calls yet:** `modules/payments` is empty and `stage.json` says so.

**A correction to the first analysis:** in this demo app, 14 changed files in `apps/web` would **not** trigger k6 today, because only `apps/api` counts as a service. The file-name problem is real, but it shows up elsewhere:
- when UI and server code share a service folder (a Next.js app with API routes)
- with names the regex misses, such as `identity.middleware.ts`
- with Semgrep, Trivy and OSV running on everything

---

## 3. Why the TypeScript compiler and not Graphify

| | TypeScript compiler (`CodeIndex`) | Graphify (open-source CLI, code-only) |
|---|---|---|
| How it reads code | Full type checker: resolves imports, workspace packages and `.ts`-extension imports | tree-sitter syntax tree, no types; "the parser leaves out a call it cannot pin to one target" |
| A function passed as a value (`requireAdmin`) | Found: "find references" returns every use, not only calls | Not an edge (its edges are calls / imports / inherits) |
| JavaScript | Yes, with `allowJs`: `.js .jsx .mjs .cjs` | Yes |
| Other languages | No | ~40 languages |
| New dependency | None: `typescript` is already in `Tests/package.json`; pinned once more in the sandbox image for JS-only repos | Python 3.11+, uv and Graphify in the image |
| Evidence it helps an agent on PRs | Compiler references are exact by construction | Its README's benchmarks are chat-memory tests (LOCOMO, LongMemEval); the one code test has 6 questions |

**Decision:** `CodeIndex` on the TypeScript compiler, plus our own route map. Graphify stays an experiment that must show it finds something the compiler misses (G1, §9).

**JavaScript caveat:** without types, some references cannot be resolved: dynamic `require(name)`, objects built at run time, `module.exports` reassigned in branches. These are listed as `unresolved`, and code treats unresolved as "may reach more", which is the safe side.

---

## 4. `CodeIndex`: the one adapter (U2)

`Agent_2/code-index/`. A small Node script baked into the sandbox image next to the existing `tools.mjs`. The original agent's tools are not changed.

**How it runs:** inside the sandbox, read-only, `--network none`, with the usual limits. It writes `index.json` to `/out`, size-limited and checked to parse as JSON. The base commit's index is cached by commit in `Tests/.cache/index/`; the head index re-reads only changed files.

**Configuration:**
- Uses the repo's `tsconfig.json` / `jsconfig.json` (each workspace's, in a monorepo) when present.
- Otherwise defaults: `allowJs`, `jsx: preserve`, `module: nodenext`.
- Files: `.ts .tsx .mts .cts .js .jsx .mjs .cjs`. `node_modules`, `dist`, `.next` and `coverage` are skipped.

**What `index.json` holds:**

```
symbols:     { id, name, kind, file, line, exported }
references:  { symbol, file, line, tag: call | value | import | type, inSymbol }
imports:     { from, to }
routes:      { method, path, file, line, handler, middleware: [symbol…], mount, framework }
unresolved:  { file, line, why }
```

**Route map:**

| Framework | What it reads |
|---|---|
| **Express** (first, for the demo app) | `app.use(prefix, router)`; `Router()` and chained `.get/.post/.put/.patch/.delete(path, ...mw, handler)`; `router.use(mw)`; a parameter followed back to what it was bound to (`createCatalogModule({ requireAdmin: identity.requireRole("admin") })`). |
| **Next.js App Router** | `app/**/route.(ts\|js)` exported `GET`/`POST`/…; `middleware.(ts\|js)` with `config.matcher` (no matcher = every route) |
| **Next.js pages** | `pages/api/**` |

Wiring it cannot follow is recorded as `unknown`, and unknown counts as "may reach every route".

**Reach of a change** (used by U3, U4, U6 and U7):

```
changedSymbols   symbols whose lines the diff touches (head index; removed ones from base)
callers          references walked backwards, depth 2, over base and head
routes           endpoints whose handler or middleware chain contains a changed symbol or a caller
global           the change reaches app.use(...) in the composition root, or a Next.js middleware
                 whose matcher covers everything
unresolved       places the walk could not follow
```

**The four test answers on the demo app** (checked by hand once):

| PR | Change | Expected reach |
|---|---|---|
| **A** | `requireRole` | `POST`, `PATCH`, `DELETE /v1/products` (through the bound `requireAdmin`) |
| **B** | `loadUser` | `global` |
| **C** | A function in `catalog.service.ts` | Only the catalog routes |
| **D** | 14 files in `apps/web` | No API route |

**To verify first:**
- Build time of the index on the demo app.
- How the language service handles the monorepo's two `tsconfig.json` files.
- That `@saltmarket/contracts` resolves through the workspace link.

---

## 5. Where `CodeIndex` is used, upgrade by upgrade

**U1. Change profile.** `Agent_2/change.ts` sorts each changed file into kinds:
`ui`, `server-logic`, `route`, `middleware`, `auth`, `data`, `deps`, `infra`, `config`, `agent-prompt`, `tests`, `docs`.

- **Path rules** come from `Tests/fixtures/<repo>/surfaces.json`.
- **Content signals** come from `CodeIndex`: imports of `express`, `Router` or `next/server`; cookies, sessions or jwt; the db client.

So `identity.middleware.ts` is `middleware` + `auth`. Today it is nothing special.

**U3. Check matrix.** `Agent_2/check-plan.ts` decides from kinds + reach. The full table is in Task.md. The key changes:
- k6 and the performance comparison need `routes > 0` or `global`.
- Semgrep fails only on findings new since the base commit.
- OSV and Trivy run only when dependency or infra files changed.
- The Decisions API may narrow the list, never widen it.

**U5. Agent tools.** Read-only, every output capped, and given to the Investigator, the Engineer, the judge and the hunters:

| Tool | What it does | Why it beats today |
|---|---|---|
| `search_code` (upgraded) | Text or regex, whole word, case on/off, folder, glob, 2 lines of context; every TS/JS extension + JSON, SQL, YAML, Markdown | Today: exact text only, and four JS/TS extensions are missed |
| `find_symbol(name)` | Where it is defined | Today: a text search and a guess |
| `outline_file(path)` | Symbols with lines | Today: read 150 lines at a time to find one function |
| `find_references(symbol)` | Every use, tagged call / value / import / type | Today: grep, which misses aliases and re-exports and finds same-named strings |
| `reach(symbol or file)` | Callers to depth 2 + routes + `global` + `unresolved` | Today: impossible |

`checkQuotes` stays: the Investigator must still quote real lines. The tools only get it there faster.

**U6. Scope gate in `verify`.**
- The patch's reach must stay within the evidence files' reach plus one hop. If it reaches further, the patch goes to the written reviewer with the extra callers listed.
- Tiny-patch auto-accept also needs `routes ≤ 1` and `global = false`. Today the code comment says the classifier "sees the diff and nothing else".

**U7. The reviewer gets the callers.** `reach.callers` and `reach.routes` go into the judge's prompt beside the diff.

---

## 6. Cloudflare security-audit skill: what it is

Read in full:
- `README`, `SKILL.md`, `HUNTING.md`, `VALIDATION-AND-REPORTING.md`
- `ATTACK-CLASSES.md`, `WEB-PROTOCOL-AND-AUTH.md`
- `report-schema.json`

Not yet read: `AI-AND-LLM.md`, `DATA-ISOLATION-AND-LIFECYCLE.md`, `SUPPLY-CHAIN-AND-RELEASE.md`, `CLOUD-AND-DEPLOYMENT.md` and the two validators. Each is read when the kind that needs it is built.

**What it is:** a skill for a coding agent: Markdown prompts, a JSON schema and two zero-dependency Node validators. Licence: MIT. It is not a library; Agent_2 adapts its prompts and rules.

**Rules it shares with ours:**
- **"Adversarial validation":** the agent that checks a finding is never the agent that found it. That is lab rule 6.
- **Three verdicts, never mixed:**

  | Verdict | Means | Requires |
  |---|---|---|
  | `confirmed` | Proven | Severity, a full source trace and a **bounded local observed result** |
  | `needs_validation` | Blocked | No severity, exact `blockers` and a `validation_plan` |
  | `rejected` | Disproved | A `reason` |
- **A boundary and a result:** every candidate names the lower-trust principal, the input, the control, the crossed boundary, the affected resource and a concrete result. A missing best practice is "hardening", not a finding.
- **Severity needs demonstrated impact,** with anchors. For example, **high** means authentication bypass or cross-tenant read or write.
- **A `quick` scoped run fits a PR.** A scoped run may be "the diff between two source refs". The `quick` profile uses "one fresh verifier per candidate for both candidate validation and final record verification".

**Our sandbox already meets its bar for running code:**

| Their requirement | Rox Lab sandbox |
|---|---|
| No external network | `--network none`; app checks use an `--internal` network |
| Empty allowlisted environment | Clean env, nothing from `.env`; a canary secret proves it |
| Read-only target and toolchain | Source mounted read-only; deps mounted read-only |
| Writes only to scratch | Size-limited `tmpfs`; fix gets its own writable copy |
| Resource and time limits | `--cpus`, `--memory`, `--pids-limit`, per-command timeout |
| Safe promotion of outputs | Only `/out` leaves, size-limited and checked to parse (`reports.ts`) |

So a verifier can run a test inside the sandbox, and that's the "bounded local observed result" `confirmed` requires.

**Taken (copied word for word into `Agent_2/security-audit/`, MIT, commit `c1c8a8c`):**
- "Core hunting method" and "Candidate gate"
- "Candidate-verifier prompt"
- The attack classes Access control, Injection and Business logic
- From WEB-PROTOCOL-AND-AUTH: Core discipline, Session fixation and invalidation, Cookie scope, CSRF, Universal moves and Validation rules
- `report-schema.json` as a zod schema, with `validate-findings.cjs` as a second check
- Stable fingerprints for deduplication

**Left out:**

| Left out | Why |
|---|---|
| Reconnaissance, `architecture.md` | For one PR, change profile + `CodeIndex` reach + route map are the reconnaissance, made by code |
| Coverage-critic waves, coverage ledger | They cover a whole repo; a PR hunt covers the diff and its reach |
| Separate Phase 5 verifier | Their `quick` profile merges it into Phase 3 |
| Artifact promotion procedure | Our `/out` channel does that job; hunters are read-only |
| `REPORT.md` and friends | The PR body and the event stream are our report |
| Native, desktop, mobile, RPC companions | Saltmarket has none of these surfaces |

---

## 7. U4: the `hunt` node

**Place:** after `triage` and `scan`, before `investigate`. It runs only for kinds `auth`, `middleware`, `route`, `data`, `deps`, `infra` or `agent-prompt`; code decides.

1. **Code picks at most 2 classes:**

   | Kinds | Classes |
   |---|---|
   | auth / middleware | Web protocol and auth + Access control |
   | route | Access control + Injection |
   | data | Injection + Data isolation |
   | deps | Supply chain |
   | infra | Cloud and deployment |
   | agent-prompt | AI and LLM |
2. **Hunters (≤3, read-only tools from U5):** each gets one class and the scope (changed symbols + callers + routes from `CodeIndex`). Each returns the structured hunter result, checked by zod. A malformed result is discarded, not repaired, following their rule.
3. **Code consolidates candidates** by fingerprint.
4. **One verifier per candidate:** a fresh context, using the "You did not write this candidate. Try to refute it…" prompt.
   - It may write and run **one** test in a throwaway sandbox copy, for example: a non-admin session cookie on `PATCH /v1/products/x` returns 200.
   - Without that test failing the security expectation, the verdict is at most `needs_validation`.
5. **Code writes `findings.json`,** checked by zod and `validate-findings.cjs`, and emits one event per record.

| Verdict | Effect |
|---|---|
| `confirmed` | Fails the security result; in the PR body with severity, trace and test |
| `needs_validation` | A PR note with the blocker; never fails the run; no severity |
| `rejected` | Kept in `findings.json` only, so a re-run doesn't repeat the claim |
| none | Said plainly: no security finding in the changed code; nothing invented |

**Models and limits:**
- Hunters start on `gpt-4.1-nano`, the verifier is `gpt-4.1-mini`.
- **To verify:** whether nano finds the planted bug. If not, hunters move to mini; the evidence bar is not lowered.
- The hunt has its own cost cap, set after measured runs. `RUN_LIMIT_USD` is $0.06 and sized for the fix loop.

**Cases** (on seeded branches, never `main`):

| Case | Expect |
|---|---|
| Planted bypass in `requireRole` | `confirmed`, with a test showing a non-admin `PATCH` succeeds |
| Clean rename in `identity.middleware.ts` | No `confirmed` |
| 14 files in `apps/web` | `hunt` never starts |
| Login keeps an existing `sm_session` | `confirmed` or `needs_validation`, depending on whether a local test can show it |

---

## 8. U8: a confirmed finding becomes a fix

Only after U4 passes its cases.

1. The verifier's test becomes the contract. Code runs it 5 of 5 times on head, as `triage` does today.
2. The usual path runs: `investigate` → `fix` → `verify` → `judge` → `publish`.
3. `verify` also records whether the test fails or passes on the base commit, meaning the hole was already there or this PR added it.

The PR calls it evidence (one input, 5 of 5 runs), never a proof.

---

## 9. G1: the Graphify experiment (optional)

Graphify (Apache 2.0) builds a code graph locally with tree-sitter. `graphify extract . --code-only` needs no model, and every edge is tagged `EXTRACTED` or `INFERRED`.

**The test:** run it on the demo app and compare `graphify affected` with `CodeIndex` reach for PRs A–D.
- It goes into the image only if it finds a real caller or route the compiler misses.
- Its likely advantage is languages other than TS/JS, which the lab doesn't have today.

**Not used in any case:**
- **The hosted MCP (`api.graphify.com/mcp`) and hosted PR reviews:** a GitHub App reads repos, and reviews send code to OpenAI and Anthropic.
- **Formal verification:** described as part of the hosted plans.
- **`graphify prs`:** needs GitHub from inside the sandbox.

We keep two of its ideas anyway: never rounding three outcomes into each other, and turning the distinguishing input into a committed test (U8).

---

## 10. Old agent vs Agent_2

| Step | Original agent | Agent_2 |
|---|---|---|
| Choose checks | File-name rules + always-on Semgrep, Trivy, OSV over the whole repo | Kinds + reach; Semgrep on new findings only; every skip has a reason |
| Know what a change affects | No | `CodeIndex`: changed symbols, references (call / value / import), endpoints, `global` |
| Search | Exact text, some extensions | Text or regex + symbols, outlines, references, reach, for all TS/JS extensions |
| Security review | Semgrep rules | Semgrep + targeted hunt with an independent verifier, only on trust-boundary changes |
| Scope of a fix | 5 files, 120 lines | The same + a reach gate |
| Judge | Diff + hints | Diff + callers + routes; auto-accept also needs small reach |
| What starts a fix | Failing test or type error | The same + a `confirmed` security finding with its test |
| Models | mini, nano, gpt-6-luna | Unchanged |

---

## 11. How we will know it is better

Run the same inputs on both agents:

```powershell
pnpm lab case <bug>
```

```powershell
pnpm lab case <bug> --agent 2
```

```powershell
pnpm lab start --pr <n> --fix
```

```powershell
pnpm lab start --pr <n> --fix --agent 2
```

Compared from the trace: wall time, checks run vs skipped, model calls, tokens and $, fix outcome and attempts, and security verdicts.

**Agent_2 is better only if:**
1. It reaches the same or better fix verdicts on every existing seeded case.
2. It runs fewer checks on PRs that don't need them, and the right extra ones on PRs that do.
3. It finds the planted bypass with `confirmed` and a test, and gives no `confirmed` on the clean change.
4. It does not cost more on cases that touch no trust boundary.

If a point fails, the upgrade that caused it is changed or dropped. The original agent stays as it is.

---

## Sources

- Cloudflare: https://github.com/cloudflare/security-audit-skill (MIT, commit `c1c8a8c`): `README.md`, `skills/security-audit/SKILL.md`, `HUNTING.md`, `VALIDATION-AND-REPORTING.md`, `ATTACK-CLASSES.md`, `WEB-PROTOCOL-AND-AUTH.md`, `report-schema.json`
- Graphify: https://github.com/Graphify-Labs/graphify (README), https://graphify.com/pr-reviews, https://graphify.com/formal-verification, https://graphify.com/concepts, https://docs.graphify.com/open-source/configuration/cli
- The original agent: `Tests/src/checks.ts`, `Tests/src/agent/graph.ts`, `gates.ts`, `service-gates.ts`, `tools.ts`, `policy.ts`, `spend.ts`; `Tests/sandbox/tools.mjs`; `agent/temporal/workflows.ts`
- The demo app: `apps/api/src/app.ts`, `modules/identity/identity.middleware.ts`, `modules/catalog/catalog.routes.ts`, `modules/catalog/index.ts`; `Tests/fixtures/ronitrai27__Testing_SRE_Demo_App/stage.json`
