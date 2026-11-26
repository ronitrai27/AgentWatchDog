// Rox Lab activities. Each one is a step Temporal can retry on another worker. They heartbeat
// every 5 seconds, so a dead worker is noticed within the heartbeat timeout and a cancel
// reaches the sandbox.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Context } from "@temporalio/activity";
import { CASES } from "../../Tests/src/agent/cases";
import { checkpoints } from "../../Tests/src/agent/checkpoints";
import type { Publisher } from "../../Tests/src/agent/graph";
import { REPO, startCase } from "../../Tests/src/agent/lab-run";
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
import { emit } from "../../Tests/src/events";
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
};

/** For a seeded bug: a branch with the bug, made from main, for the fix to be proposed to. */
async function seededBranch(
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
  await commitFiles(
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
  (target: () => Promise<{ repo: string; base: string }>): Publisher =>
  async ({ run, ws, title, body, files }) =>
    openPullRequest(await target(), {
      branch: `rox/fix-${run.slice(0, 8)}`,
      files: await filesFrom(ws, files),
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
      const bug = CASES.find((c) => c.id === input.caseId);
      if (!bug) throw new Error(`no such seeded bug: ${input.caseId}`);
      const lab = await startCase(bug, run);
      workspaces = [bug.ws];
      workspace = async () => lab.ws;
      fresh = lab.fresh;
      source = lab.source;
      const p = input.publish;
      if (p?.kind === "seeded")
        publish = publisher(async () => ({
          repo: p.repo,
          base: await seededBranch(p.repo, run, bug.id, lab.ws, bug.file),
        }));
    } else {
      const open = async (kind: "agent" | "verify") => {
        const ws = new Workspace(run, kind);
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
        publish = publisher(async () => ({ repo: p.repo, base: p.branch }));
      // The package folders that hold test files. Package.json globs ("apps/*") are not folders.
      const found = await ws.exec([
        "sh",
        "-c",
        `cd ${ws.root} && find . -path ./node_modules -prune -o -path '*/node_modules' -prune -o -type f ( -name package.json -o -name '*.test.*' -o -name '*.spec.*' ) -print`,
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
                  .sort((x, y) => y.length - x.length)[0],
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
    const result = await runFix(
      { run, workspaces, change },
      { workspace, fresh },
      {
        checkpointer: await checkpoints(),
        signal,
        publish,
        services: ({ copy, attempt }) =>
          serviceGates({ run, repo, attempt, copy, source, signal }),
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
