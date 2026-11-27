// Rox Lab activities. Each one is a step Temporal can retry on another worker. They heartbeat
// every 5 seconds, so a dead worker is noticed within the heartbeat timeout and a cancel
// reaches the sandbox.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import {
  type IncidentFacts,
  incidentFacts,
  sentryFromEnv,
} from "../../agent/src/integrations/sentry";
import { analyzeStep, type GateStep, gateStep } from "../agent/analyze";
import { CASES } from "../agent/cases";
import {
  loadAnalysis,
  outgoingCalls,
  type Plan2Item,
  planChecks2,
} from "../agent/check-plan";
import { checkpoints } from "../agent/checkpoints";
import { runCheck2 } from "../agent/checks2";
import type { Publisher } from "../agent/graph";
import { type HuntResult, runHunt } from "../agent/hunt";
import { REPO, startCase } from "../agent/lab-run";
import { type ReportTarget, sendRunNote } from "../agent/notify";
import { commitFiles, filesFrom, openPullRequest } from "../agent/publish";
import { type FixResult, runFix } from "../agent/run";
import { serviceGates } from "../agent/service-gates";
import { Workspace } from "../agent/workspace";
import {
  type CheckResult,
  type Installed,
  install,
  type PlanItem,
  planChecks,
  type RunInput,
  runCheck,
} from "../src/checks";
import { destroyRun, ensureVolume } from "../src/docker";
import { cacheDir, runDir } from "../src/env";
import { emit, readEvents } from "../src/events";
import { appApi, mergePullRequest, writeToken } from "../src/github";
import {
  finishRun,
  markMerged,
  type RunOrigin,
  recordSettings,
  setRunOutcome,
  setRunStatus,
  startRun,
} from "../src/runs";
import {
  dayLeftUsd,
  type RunSettings,
  runModels,
  runSettings,
  SettingsError,
} from "../src/settings";
import {
  changedFiles,
  checkout,
  type Facts,
  fixturesDir,
  loadVolume,
  readFacts,
  volumes,
} from "../src/source";

export type LabInput = RunInput & {
  workflowId: string;
  title: string | null;
  /** Who and what started the run; recorded in the runs table. */
  origin?: RunOrigin;
  /** The user's settings for this run (model, budget, time limit, PR action). Never a key. */
  settings?: RunSettings;
};

function beating<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctx = Context.current();
  ctx.heartbeat();
  const timer = setInterval(() => ctx.heartbeat(), 5000);
  return work(ctx.cancellationSignal).finally(() => clearInterval(timer));
}

const attempt = () => Context.current().info.attempt;

/**
 * The user's settings for this run: their model, day budget, time limit and PR action. A missing
 * choice is not retried: it fails the run at once with what to set.
 */
export async function labSettings(userId: string | null): Promise<RunSettings> {
  try {
    return await runSettings(userId);
  } catch (error) {
    if (error instanceof SettingsError)
      throw ApplicationFailure.nonRetryable(error.message, "SettingsError");
    throw error;
  }
}

export async function labPrepare(
  input: LabInput,
): Promise<{ plan: PlanItem[]; facts: Facts }> {
  return beating(async () => {
    const started = Date.now();
    await startRun({
      run: input.run,
      workflowId: input.workflowId,
      origin: input.origin ?? { source: "cli", invokedBy: "cli" },
      repo: input.repo,
      pr: input.pr ?? null,
      head: input.head,
      base: input.base ?? null,
      title: input.title,
    });
    if (input.settings)
      await recordSettings(input.run, {
        modelId: input.settings.modelId,
        prAction: input.settings.prAction,
        dayBudgetUsd: input.settings.dayBudgetUsd,
        leftUsd: await dayLeftUsd(input.settings.userId),
      });
    await emit(input.run, {
      step: "run",
      kind: "run.started",
      title: input.pr
        ? `PR #${input.pr}${input.title ? ` "${input.title}"` : ""} at ${input.head.slice(0, 7)}`
        : `Commit ${input.head.slice(0, 7)}`,
      status: "running",
      attempt: attempt(),
      data: {
        workflowId: input.workflowId,
        repo: input.repo,
        head: input.head,
        base: input.base,
      },
    });
    await emit(input.run, {
      step: "prepare",
      kind: "step.started",
      title: "Getting the code",
      status: "running",
      attempt: attempt(),
    });
    const dir = await checkout(input.repo, input.head, input.base, input.run);
    const v = volumes(input.run);
    await loadVolume(dir, v.src, input.run);
    const fixtures = fixturesDir(input.repo);
    if (existsSync(fixtures)) await loadVolume(fixtures, v.fixtures, input.run);
    else await ensureVolume(v.fixtures, input.run);
    for (const name of [v.work, v.base, v.out])
      await ensureVolume(name, input.run);
    await ensureVolume(v.npmCache);
    const changed = await changedFiles(dir, input.base, input.head);
    const facts = await readFacts(dir, input.repo, changed);
    const plan = planChecks(
      facts,
      Boolean(input.base),
      input.profile ?? "fast",
    );
    await emit(input.run, {
      step: "prepare",
      kind: "step.finished",
      title: "Code ready in the sandbox",
      status: "pass",
      ms: Date.now() - started,
      data: {
        facts,
        plan: plan.map((p) => ({
          id: p.id,
          title: p.title,
          area: p.area,
          applies: p.applies,
          why: p.why,
        })),
      },
    });
    return { plan, facts };
  });
}

export async function labInstall(
  input: LabInput,
  facts: Facts,
): Promise<Installed> {
  return beating(async (signal) => {
    await emit(input.run, {
      step: "install",
      kind: "step.started",
      title:
        "Installing dependencies (npm registry only, through the egress proxy)",
      status: "running",
      attempt: attempt(),
    });
    const r = await install(input, facts, signal);
    await emit(input.run, {
      step: "install",
      kind: "step.finished",
      title: "Dependencies",
      status: r.cancelled
        ? "cancelled"
        : r.head && !/base install failed/.test(r.summary)
          ? "pass"
          : "error",
      ms: r.ms,
      data: { summary: r.summary, egress: r.egress },
    });
    return { head: r.head, base: r.base, summary: r.summary };
  });
}

export async function labCheck(
  input: LabInput,
  item: PlanItem,
  facts: Facts,
  installed: Installed,
  prior: CheckResult[],
): Promise<CheckResult> {
  return beating(async (signal) => {
    if (item.applies)
      await emit(input.run, {
        step: item.id,
        kind: "check.started",
        title: item.title,
        status: "running",
        attempt: attempt(),
      });
    const ran = await runCheck(input, item, facts, installed, prior, signal);
    const result: CheckResult = signal.aborted
      ? {
          ...ran,
          status: "cancelled",
          summary: "stopped: the run was cancelled",
          reports: [],
        }
      : ran;
    await emit(input.run, {
      step: item.id,
      kind: "check.finished",
      title: item.title,
      status: result.status,
      ms: result.ms,
      data: {
        summary: result.summary,
        reports: result.reports,
        counts: result.counts,
      },
    });
    return result;
  });
}

/**
 * Tells the user's channel how a run ended when the fix agent did not report it itself: the checks
 * found nothing for Rox to fix, or Rox crashed. Once per run, like the agent's own report.
 */
export async function labNote(
  input: Pick<LabInput, "run" | "repo" | "pr"> & { report: ReportTarget },
  kind: "checked" | "crashed" | "aborted" | "timed_out",
  results: CheckResult[],
  reason: string | null,
): Promise<void> {
  const where = `${input.repo}${input.pr ? ` PR #${input.pr}` : ""}`;
  const failed = results.filter(
    (r) => r.status === "fail" || r.status === "error",
  );
  const passed = results.filter((r) => r.status === "pass").length;
  const lines =
    kind === "timed_out"
      ? [
          `The run passed its time limit and was stopped: ${reason ?? ""}`,
          "Its sandbox was destroyed. No pull request was opened. Raise Max time per run in Settings > Agent if runs need longer.",
        ]
      : kind === "aborted"
        ? [
            `The run was stopped by hand: ${reason ?? "no reason given"}`,
            "Its sandbox was destroyed. No pull request was opened.",
          ]
        : kind === "crashed"
          ? [
              `Rox hit a problem of its own (not in your code) and stopped: ${reason ?? "unknown error"}`,
              `${passed} checks had passed before it stopped. No pull request was opened.`,
            ]
          : [
              reason
                ? `The dependencies could not be installed, so Rox could not run the code: ${reason}`
                : "Tests and the type checker pass, so there is no bug for Rox to fix. No pull request was opened.",
              `${passed} of ${results.length} checks passed.`,
              ...failed.map(
                (r) =>
                  `${r.title}: ${r.status}, ${r.summary.replace(/\s+/g, " ").slice(0, 180)}`,
              ),
            ];
  await sendRunNote(input.report, {
    run: input.run,
    headline:
      kind === "timed_out"
        ? `Rox run on ${where} hit its time limit`
        : kind === "aborted"
          ? `Rox run on ${where} was aborted`
          : kind === "crashed"
            ? `Rox stopped on ${where}: an error of its own`
            : `Rox checked ${where}: nothing for it to fix`,
    lines,
    link: input.pr
      ? `https://github.com/${input.repo}/pull/${input.pr}`
      : undefined,
  });
}

export async function labFinish(
  input: LabInput,
  results: CheckResult[],
  outcome: "completed" | "cancelled" | "failed",
  reason: string | null,
): Promise<void> {
  const count = (s: string) => results.filter((r) => r.status === s).length;
  await emit(input.run, {
    step: "run",
    kind: `run.${outcome}`,
    title:
      outcome === "completed"
        ? `${count("pass")} passed, ${count("fail")} failed, ${count("error")} errors, ${count("skipped")} skipped`
        : (reason ?? outcome),
    status:
      outcome === "completed"
        ? count("fail") + count("error")
          ? "fail"
          : "pass"
        : outcome === "cancelled"
          ? "cancelled"
          : "error",
    data: {
      results: results.map((r) => ({
        id: r.id,
        status: r.status,
        summary: r.summary,
        ms: r.ms,
      })),
      ...(reason ? { reason } : {}),
    },
  });
  await finishRun(
    input.run,
    outcome === "completed"
      ? "succeeded"
      : outcome === "cancelled"
        ? "cancelled"
        : "failed",
    reason,
  );
}

export type FixInput = {
  run: string;
  /** The repository being fixed (the lab's demo app for seeded bugs). */
  repo?: string;
  /** A seeded bug of the lab instead of the installed code of this run. */
  caseId?: string;
  workspaces: string[];
  /** The commits being checked, for the diff the agent sees. */
  head?: string;
  base?: string | null;
  /**
   * Open a pull request in the same repository. "pr": into that pull request's own branch.
   * "seeded": the bug gets a lab branch made from main, and the fix goes into it.
   */
  publish?:
    | { repo: string; kind: "pr"; branch: string }
    | { repo: string; kind: "seeded" };
  /** Where the final report goes (the user's choice in Connections); without it, nowhere. */
  report?: ReportTarget;
  /** The user's settings for this run: their model, and whether Rox merges its own fix. */
  settings: RunSettings;
};

/** The pipeline agent (a copy of Tests/Agent_2) and the parts of it labFix uses. */
const KIT = {
  CASES,
  startCase,
  Workspace,
  runFix,
  serviceGates,
  checkpoints,
  commitFiles,
  filesFrom,
  openPullRequest,
};
type Kit = typeof KIT;

/** For a seeded bug: a branch with the bug, made from main, for the fix to be proposed to. */
async function seededBranch(
  kit: Kit,
  repo: string,
  run: string,
  caseId: string,
  ws: Workspace,
  file: string,
): Promise<string> {
  const token = await writeToken(repo);
  const main = await appApi<{ object: { sha: string } }>(
    "GET",
    `/repos/${repo}/git/ref/heads/main`,
    token,
  );
  const seeded = await ws.exec(["git", "-C", ws.root, "show", `HEAD:${file}`]);
  if (seeded.code !== 0) throw new Error("could not read the seeded file");
  const branch = `rox-lab/bug-${caseId}-${run.slice(0, 8)}`;
  await kit.commitFiles(
    repo,
    token,
    branch,
    main.object.sha,
    [{ path: file, content: seeded.stdout }],
    `test: seeded bug "${caseId}" for the Rox Lab`,
  );
  return branch;
}

const publisher =
  (
    kit: Kit,
    target: () => Promise<{ repo: string; base: string }>,
  ): Publisher =>
  async ({ run, ws, title, body, files }) =>
    kit.openPullRequest(await target(), {
      branch: `rox/fix-${run.slice(0, 8)}`,
      files: await kit.filesFrom(ws, files),
      title,
      body,
      message: `${title}\n\nRox Lab run ${run}`,
    });

/**
 * The fix agent. One activity, because the graph saves a checkpoint after every node: when the
 * worker dies, Temporal starts this again elsewhere and the graph continues after the last
 * finished node instead of paying for it twice.
 */
export async function labFix(input: FixInput): Promise<FixResult> {
  return beating(async (signal) => {
    const { run } = input;
    const repo = input.repo ?? REPO;
    const kit = KIT;
    await emit(run, {
      step: "agent",
      kind: "agent.started",
      title: input.caseId
        ? `Seeded bug ${input.caseId}`
        : "Fixing the failures",
      status: "running",
      attempt: attempt(),
    });
    let workspace: () => Promise<Workspace>;
    let fresh: () => Promise<Workspace>;
    let publish: Publisher | undefined;
    let source = "";
    let { workspaces } = input;
    if (input.caseId) {
      const bug = kit.CASES.find((c) => c.id === input.caseId);
      if (!bug) throw new Error(`no such seeded bug: ${input.caseId}`);
      const lab = await kit.startCase(bug, run);
      workspaces = [bug.ws];
      workspace = async () => lab.ws;
      fresh = lab.fresh;
      source = lab.source;
      const p = input.publish;
      if (p?.kind === "seeded")
        publish = publisher(kit, async () => ({
          repo: p.repo,
          base: await seededBranch(kit, p.repo, run, bug.id, lab.ws, bug.file),
        }));
    } else {
      const open = async (kind: "agent" | "verify") => {
        const ws = new kit.Workspace(run, kind);
        if (kind === "verify") await ws.close();
        await ws.open();
        return ws;
      };
      const ws = await open("agent");
      workspace = async () => ws;
      fresh = () => open("verify");
      source = volumes(run).work;
      const p = input.publish;
      if (p?.kind === "pr")
        publish = publisher(kit, async () => ({
          repo: p.repo,
          base: p.branch,
        }));
      // The package folders that hold test files. Package.json globs ("apps/*") are not folders.
      const found = await ws.exec([
        "sh",
        "-c",
        `cd ${ws.root} && find . -path ./node_modules -prune -o -path '*/node_modules' -prune -o -type f \\( -name package.json -o -name '*.test.*' -o -name '*.spec.*' \\) -print`,
      ]);
      const paths = found.stdout
        .split(/\r?\n/)
        .map((f) => f.replace(/^\.\//, ""))
        .filter(Boolean);
      const packages = paths
        .filter((f) => f.endsWith("package.json") && f.includes("/"))
        .map((f) => f.slice(0, -"/package.json".length));
      workspaces = [
        ...new Set(
          paths
            .filter((f) => /\.(test|spec)\./.test(f))
            .map(
              (f) =>
                packages
                  .filter((d) => f.startsWith(`${d}/`))
                  .sort((x, y) => y.length - x.length)[0] ??
                // A single-package repository: its tests belong to the root package.
                (paths.includes("package.json") ? "." : undefined),
            )
            .filter((d): d is string => Boolean(d)),
        ),
      ];
    }
    const change =
      input.base && input.head
        ? await promisify(execFile)(
            "git",
            [
              "-C",
              path.join(cacheDir, "checkouts", run),
              "diff",
              "--no-color",
              "--no-ext-diff",
              `${input.base}...${input.head}`,
              "--",
              ".",
              ":(exclude)*lock*",
            ],
            { maxBuffer: 4 * 1024 * 1024, windowsHide: true },
          ).then(
            (r) => r.stdout.slice(0, 20_000),
            () => "",
          )
        : "";
    const { settings } = input;
    const models = await runModels(settings.userId, settings.modelId);
    const result = await kit.runFix(
      { run, workspaces, change },
      { workspace, fresh },
      {
        checkpointer: await kit.checkpoints(),
        signal,
        publish,
        report: input.report,
        repo,
        models,
        leftUsd: await dayLeftUsd(settings.userId),
        services: ({ copy, attempt }) =>
          kit.serviceGates({
            run,
            repo,
            attempt,
            copy,
            source,
            signal,
            decide: models.decide,
          }),
      },
    );
    // Merge PR (Settings > Agent): Rox merges its own verified fix, then says so. Code decides
    // this from the user's setting; no model can ask for it.
    if (
      settings.prAction === "merge_pr" &&
      result.outcome === "fixed" &&
      result.pr
    ) {
      const pr = result.pr;
      const target = input.publish?.repo ?? repo;
      try {
        const sha = await mergePullRequest(
          target,
          pr.number,
          `fix: Rox run ${run.slice(0, 8)}`,
        );
        await markMerged(run);
        await emit(run, {
          step: "publish",
          kind: "pr.merged",
          title: `Merged pull request #${pr.number} (${sha.slice(0, 7)}), as chosen in Settings > Agent`,
          status: "pass",
          data: { url: pr.url, sha },
        });
        if (input.report)
          await sendRunNote(input.report, {
            run,
            headline: `Rox merged its fix: ${target} #${pr.number}`,
            lines: [
              "Every check passed and the reviewer accepted it.",
              "Merged without waiting for a human, because Merge PR is on in Settings > Agent.",
              `Merge commit ${sha.slice(0, 7)}.`,
            ],
            link: pr.url,
          });
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        await emit(run, {
          step: "publish",
          kind: "pr.merge_failed",
          title: `Could not merge #${pr.number}; it stays open for a human: ${why.slice(0, 200)}`,
          status: "error",
        });
        if (input.report)
          await sendRunNote(input.report, {
            run,
            headline: `Rox could not merge ${target} #${pr.number}`,
            lines: [
              `GitHub said: ${why.slice(0, 300)}`,
              "The pull request stays open for you to merge.",
            ],
            link: pr.url,
          });
      }
    }
    await mkdir(runDir(run), { recursive: true });
    await setRunOutcome(run, result.outcome, result.pr?.url ?? null);
    // A seeded lab case has no labFinish: the fix agent's end is the run's end.
    if (input.caseId) await finishRun(run, "succeeded", null);
    const patch = result.attempts.at(-1)?.patch ?? "";
    if (result.outcome === "fixed")
      await writeFile(path.join(runDir(run), "fix.patch"), patch);
    return result;
  });
}

/** Destroys every container and volume of the run, and the checkout on the host. */
/** One line in the run's trace, from the workflow (which cannot write files itself). */
export async function labMark(
  run: string,
  kind: string,
  title: string,
): Promise<void> {
  await emit(run, { step: "run", kind, title });
  if (kind === "run.paused") await setRunStatus(run, "paused");
  if (kind === "run.resumed") await setRunStatus(run, "running");
}

/**
 * The kill switch, after the run was terminated: destroys every container, network and volume of
 * the run now, and records in the trace where it stopped (the workflow's step, and the agent's
 * last node when the agent was running). Returns that place.
 */
export async function labDestroy(
  run: string,
  step: string,
  why: string,
): Promise<string> {
  const t0 = Date.now();
  const last = (await readEvents(run))
    .filter((e) => e.kind !== "tool.call" && e.kind !== "model.call")
    .at(-1);
  const at =
    step === "fix agent" && last ? `fix agent, node "${last.step}"` : step;
  const destroyed = await Promise.all([
    destroyRun(run),
    ...[1, 2, 3].map((n) => destroyRun(`${run}-svc${n}`)),
  ]);
  await rm(path.join(cacheDir, "checkouts", run), {
    recursive: true,
    force: true,
  });
  const total = (k: "containers" | "networks" | "volumes") =>
    destroyed.reduce((sum, d) => sum + d[k], 0);
  await emit(run, {
    step: "run",
    kind: "run.aborted",
    title: `Aborted at ${at}: ${why}. Destroyed ${total("containers")} containers, ${total("networks")} networks, ${total("volumes")} volumes`,
    status: "cancelled",
    ms: Date.now() - t0,
    data: { at, why, lastEvent: last?.kind ?? null },
  });
  await finishRun(run, "aborted", `${why} (stopped at: ${at})`);
  return at;
}

export async function labCleanup(input: Pick<LabInput, "run">): Promise<void> {
  // The app stages Verify started for each attempt, in case a crash left one behind.
  for (let n = 1; n <= 3; n++) await destroyRun(`${input.run}-svc${n}`);
  const removed = await destroyRun(input.run);
  await rm(path.join(cacheDir, "checkouts", input.run), {
    recursive: true,
    force: true,
  });
  await emit(input.run, {
    step: "run",
    kind: "sandbox.destroyed",
    title: `Sandbox destroyed: ${removed.containers} containers, ${removed.networks} networks, ${removed.volumes} volumes`,
    data: removed,
  });
  // Only when nothing recorded the end before (a crashed lab case): never leave a run "running".
  await finishRun(input.run, "failed", "the run ended without saying how");
}

// --- The pipeline agent: language gate, code index, check plan, its checks, security hunt.
// Every one of these ends normally even when something inside fails: the failure is written to
// the trace and the run goes on with a safe fallback (the shared plan, no hunt).

const checkoutDir = (run: string) => path.join(cacheDir, "checkouts", run);
const agent2Dir = (run: string) => path.join(runDir(run), "agent2");
const soft = async <T>(
  run: string,
  what: string,
  fallback: T,
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (e) {
    if (Context.current().cancellationSignal.aborted) throw e;
    await emit(run, {
      step: "agent2",
      kind: "agent2.failed",
      title: `${what} failed; the run goes on without it: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`,
      status: "error",
    });
    return fallback;
  }
};

/** U0 + stack. Returns whether the run may go on, and the message when it may not. */
export async function agent2Gate(
  input: LabInput,
): Promise<{ ok: boolean; message: string | null }> {
  return beating(async () =>
    soft<{ ok: boolean; message: string | null }>(
      input.run,
      "The language gate",
      { ok: true, message: null },
      async () => {
        const g = await gateStep({
          run: input.run,
          dir: checkoutDir(input.run),
          base: input.base,
          head: input.head,
        });
        await mkdir(agent2Dir(input.run), { recursive: true });
        await writeFile(
          path.join(agent2Dir(input.run), "gate.json"),
          JSON.stringify(g),
        );
        return { ok: g.gate.ok, message: g.gate.message };
      },
    ),
  );
}

/** Tells the user's channel that Rox stopped at the language gate. */
export async function agent2Stop(
  input: Pick<LabInput, "run" | "repo" | "pr">,
  message: string,
  report: ReportTarget | null,
): Promise<void> {
  await emit(input.run, {
    step: "run",
    kind: "run.unsupported",
    title: message,
    status: "skipped",
  });
  if (report)
    await sendRunNote(report, {
      run: input.run,
      headline: `Rox did not check ${input.repo}${input.pr ? ` PR #${input.pr}` : ""}`,
      lines: [message],
    }).catch(() => false);
}

/** U2 index + reach + U1 profile, on the installed copy. */
export async function agent2Analyze(
  input: LabInput,
  installed: Installed,
): Promise<{ ok: boolean }> {
  return beating(async (signal) =>
    soft<{ ok: boolean }>(
      input.run,
      "The code index",
      { ok: false },
      async () => {
        const { readFile } = await import("node:fs/promises");
        const gate = JSON.parse(
          await readFile(path.join(agent2Dir(input.run), "gate.json"), "utf8"),
        ) as GateStep;
        const v = volumes(input.run);
        await analyzeStep({
          run: input.run,
          dir: checkoutDir(input.run),
          base: input.base,
          head: input.head,
          gate,
          volume: v.work,
          baseVolume: installed.base ? v.base : null,
          signal,
        });
        return { ok: true };
      },
    ),
  );
}

/** U3: Agent_2's check plan. Falls back to the safe plan (every applicable check) without analysis. */
export async function agent2Plan(
  input: LabInput,
  facts: Facts,
): Promise<Plan2Item[]> {
  return beating(async () => {
    const { stack, analysis } = await loadAnalysis(input.run);
    let outgoing: boolean | null = null;
    if (analysis)
      outgoing = await soft(
        input.run,
        "Finding outgoing calls",
        null as boolean | null,
        async () => {
          const { readFile } = await import("node:fs/promises");
          const head = JSON.parse(
            await readFile(
              path.join(agent2Dir(input.run), "index-head.json"),
              "utf8",
            ),
          ) as { externals: Record<string, string[]> };
          const texts = new Map<string, string | null>();
          for (const f of new Set([
            ...analysis.profile.files.map((x) => x.path),
            ...analysis.reach.callers.map((c) => c.id.split("#")[0] ?? ""),
          ]))
            texts.set(
              f,
              await readFile(
                path.join(checkoutDir(input.run), f),
                "utf8",
              ).catch(() => null),
            );
          return outgoingCalls(
            analysis,
            head.externals,
            (f) => texts.get(f) ?? null,
          );
        },
      );
    const plan = planChecks2({
      facts,
      stack,
      analysis,
      hasBase: Boolean(input.base),
      outgoing,
    });
    await emit(input.run, {
      step: "agent2",
      kind: "agent2.plan",
      title: `Check plan: ${plan.filter((p) => p.applies).length} run, ${plan.filter((p) => !p.applies).length} skipped${analysis ? "" : " (not narrowed: no change analysis)"}`,
      data: {
        plan: plan.map((p) => ({
          id: p.id,
          title: p.title,
          applies: p.applies,
          why: p.why,
        })),
      },
    });
    return plan;
  });
}

/** One Agent_2 check. Never throws: a crash is an "error" result. */
export async function agent2Check(
  input: LabInput,
  item: PlanItem & Partial<Plan2Item>,
  facts: Facts,
  installed: Installed,
  prior: CheckResult[],
): Promise<CheckResult> {
  return beating(async (signal) => {
    if (item.applies)
      await emit(input.run, {
        step: item.id,
        kind: "check.started",
        title: item.title,
        status: "running",
        attempt: attempt(),
      });
    const { stack } = await loadAnalysis(input.run);
    const result = await runCheck2(
      input,
      { runner: "shared", ...item },
      facts,
      installed,
      prior,
      stack,
      signal,
    );
    await emit(input.run, {
      step: item.id,
      kind: "check.finished",
      title: item.title,
      status: result.status,
      ms: result.ms,
      data: {
        summary: result.summary,
        reports: result.reports,
        counts: result.counts,
      },
    });
    return result;
  });
}

/** U4: the security hunt. Never throws. */
export async function agent2Hunt(input: LabInput): Promise<HuntResult | null> {
  return beating(async (signal) =>
    soft(
      input.run,
      "The security hunt",
      null as HuntResult | null,
      async () => {
        const { analysis } = await loadAnalysis(input.run);
        if (!analysis) {
          await emit(input.run, {
            step: "hunt",
            kind: "hunt.skipped",
            title: "Security hunt skipped: there is no change analysis",
            status: "skipped",
          });
          return null;
        }
        const diff = input.base
          ? await promisify(execFile)(
              "git",
              [
                "-C",
                checkoutDir(input.run),
                "diff",
                "--no-color",
                "--no-ext-diff",
                `${input.base}...${input.head}`,
                "--",
                ".",
                ":(exclude)*lock*",
              ],
              { maxBuffer: 8 * 1024 * 1024, windowsHide: true },
            ).then(
              (r) => r.stdout,
              () => "",
            )
          : "";
        let ws: Workspace | null = null;
        const workspace = async () => {
          if (ws) return ws;
          const w = new Workspace(input.run, "verify");
          await w.close();
          await w.open();
          ws = w;
          return w;
        };
        try {
          const checkpointer = await checkpoints().catch(() => undefined);
          const settings =
            input.settings ?? (await runSettings(input.origin?.userId));
          return await runHunt({
            run: input.run,
            diff,
            analysis,
            workspace,
            checkpointer,
            signal,
            models: await runModels(settings.userId, settings.modelId),
            leftUsd: await dayLeftUsd(settings.userId),
          });
        } finally {
          if (ws) await (ws as Workspace).close().catch(() => {});
        }
      },
    ),
  );
}

// ---------- Sentry incidents ----------

export type IncidentInput = {
  run: string;
  repo: string | null;
  trigger: string;
  why: string;
  issueId: string;
  title: string;
  link: string | null;
  report: ReportTarget | null;
};

/**
 * First step of a Sentry incident run: reads the issue's latest event from Sentry (exception,
 * the in-app frame where it broke, release, service) and tells the user's channel. Event text is
 * data: it is only quoted, never followed.
 */
export async function incidentBrief(
  input: IncidentInput,
): Promise<IncidentFacts> {
  const sentry = sentryFromEnv();
  if (!sentry)
    throw new Error("SENTRY_AUTH_TOKEN and SENTRY_ORG are not set in .env");
  const facts = await incidentFacts(sentry, input.issueId);
  if (input.report)
    await sendRunNote(input.report, {
      run: input.run,
      headline: `Sentry ${input.trigger.replace("sentry:", "").replace("_", " ")}: ${facts.title}`,
      lines: [
        `Why Rox woke up: ${input.why}`,
        ...(input.repo ? [`Repository: ${input.repo}`] : []),
        ...(facts.exception ? [`Exception: ${facts.exception}`] : []),
        ...(facts.frame ? [`Where: ${facts.frame}`] : []),
        ...(facts.service ? [`Service: ${facts.service}`] : []),
        ...(facts.release ? [`Release: ${facts.release}`] : []),
        ...(facts.environment ? [`Environment: ${facts.environment}`] : []),
      ],
      link: input.link ?? facts.link ?? undefined,
    });
  return facts;
}
