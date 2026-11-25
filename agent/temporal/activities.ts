// Rox Lab activities. Each one is a step Temporal can retry on another worker. They heartbeat
// every 5 seconds, so a dead worker is noticed within the heartbeat timeout and a cancel
// reaches the sandbox.

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Context } from "@temporalio/activity";
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
import { cacheDir } from "../../Tests/src/env";
import { emit } from "../../Tests/src/events";
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
    const plan = planChecks(facts, Boolean(input.base));
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
        : r.head && (r.base || !input.base)
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

/** Destroys every container and volume of the run, and the checkout on the host. */
export async function labCleanup(input: LabInput): Promise<void> {
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
