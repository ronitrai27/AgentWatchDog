// Rox Lab activities. Each one is a step Temporal can retry on another worker. They heartbeat
// every 5 seconds, so a dead worker is noticed within the heartbeat timeout and a cancel
// reaches the sandbox.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Context } from "@temporalio/activity";
import { CASES as CASES2 } from "../../Tests/Agent_2/cases";
import { checkpoints as checkpoints2 } from "../../Tests/Agent_2/checkpoints";
import { startCase as startCase2 } from "../../Tests/Agent_2/lab-run";
import {
  commitFiles as commitFiles2,
  filesFrom as filesFrom2,
  openPullRequest as openPullRequest2,
} from "../../Tests/Agent_2/publish";
import { runFix as runFix2 } from "../../Tests/Agent_2/run";
import { serviceGates as serviceGates2 } from "../../Tests/Agent_2/service-gates";
import { Workspace as Workspace2 } from "../../Tests/Agent_2/workspace";
import { CASES } from "../../Tests/src/agent/cases";
import { checkpoints } from "../../Tests/src/agent/checkpoints";
import type { Publisher } from "../../Tests/src/agent/graph";
import { REPO, startCase } from "../../Tests/src/agent/lab-run";
import { type ReportTarget, sendRunNote } from "../../Tests/src/agent/notify";
import {
  commitFiles,
  filesFrom,
  openPullRequest,
} from "../../Tests/src/agent/publish";
import { type FixResult, runFix } from "../../Tests/src/agent/run";
import { serviceGates } from "../../Tests/src/agent/service-gates";
import { Workspace } from "../../Tests/src/agent/workspace";
import {
  type CheckResult,
  type Installed,
  install,
  type PlanItem,
  planChecks,
  type RunInput,
  runCheck,
} from "../../Tests/src/checks";
import { destroyRun, ensureVolume } from "../../Tests/src/docker";
import { cacheDir, runDir } from "../../Tests/src/env";
import { emit, readEvents } from "../../Tests/src/events";
import { appApi, writeToken } from "../../Tests/src/github";
import {
  changedFiles,
  checkout,
  type Facts,
  fixturesDir,
  loadVolume,
  readFacts,
  volumes,
} from "../../Tests/src/source";

export type LabInput = RunInput & { workflowId: string; title: string | null };

function beating<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctx = Context.current();
  ctx.heartbeat();
  const timer = setInterval(() => ctx.heartbeat(), 5000);
  return work(ctx.cancellationSignal).finally(() => clearInterval(timer));
}

const attempt = () => Context.current().info.attempt;

export async function labPrepare(
  input: LabInput,
): Promise<{ plan: PlanItem[]; facts: Facts }> {
  return beating(async () => {
    const started = Date.now();
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
  kind: "checked" | "crashed" | "aborted",
  results: CheckResult[],
  reason: string | null,
): Promise<void> {
  const where = `${input.repo}${input.pr ? ` PR #${input.pr}` : ""}`;
  const failed = results.filter(
    (r) => r.status === "fail" || r.status === "error",
  );
  const passed = results.filter((r) => r.status === "pass").length;
  const lines =
    kind === "aborted"
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
      kind === "aborted"
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
  /** Which test agent fixes: 1 is Tests/src/agent (the default), 2 is Tests/Agent_2. */
  agent?: 1 | 2;
};

/**
 * The parts of one test agent that labFix uses. Agent_2 starts as a copy of agent 1, so its kit is
 * typed as agent 1's; the cast keeps the two copies' Workspace classes from clashing. Once Agent_2's
 * runFix, FixResult or Workspace change shape, give it its own typed kit here.
 */
const KIT1 = {
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
type Kit = typeof KIT1;
const KIT2 = {
  CASES: CASES2,
  startCase: startCase2,
  Workspace: Workspace2,
  runFix: runFix2,
  serviceGates: serviceGates2,
  checkpoints: checkpoints2,
  commitFiles: commitFiles2,
  filesFrom: filesFrom2,
  openPullRequest: openPullRequest2,
} as unknown as Kit;
const kitOf = (agent: FixInput["agent"]): Kit => (agent === 2 ? KIT2 : KIT1);

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
    const kit = kitOf(input.agent);
    const agentName = input.agent === 2 ? "Agent_2" : "agent 1";
    await emit(run, {
      step: "agent",
      kind: "agent.started",
      title: `${input.caseId ? `Seeded bug ${input.caseId}` : "Fixing the failures"} (${agentName})`,
      status: "running",
      attempt: attempt(),
      data: { agent: input.agent ?? 1 },
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
    const result = await kit.runFix(
      { run, workspaces, change },
      { workspace, fresh },
      {
        checkpointer: await kit.checkpoints(),
        signal,
        publish,
        report: input.report,
        repo,
        services: ({ copy, attempt }) =>
          kit.serviceGates({ run, repo, attempt, copy, source, signal }),
      },
    );
    await mkdir(runDir(run), { recursive: true });
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
}
