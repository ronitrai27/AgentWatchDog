// Starts Rox's fix run for a pull request as a Temporal workflow (the worker: pnpm temporal:worker,
// task queue rox-lab). One workflow id per pull request: a newer push stops the older run first and
// says why. The web request never waits for the run; it only starts it.
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
  WorkflowNotFoundError,
} from "@temporalio/client";
import type { ReportTarget } from "./report-connections";

// The same settings as pipeline/temporal/config.ts.
const ADDRESS = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
const NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "default";
const TASK_QUEUE = "rox-lab";

export type PrRun = {
  repo: string;
  pr: number;
  head: string;
  base: string;
  prBranch: string;
  title: string | null;
  report: ReportTarget | null;
  /** The Rox user whose repository it is, and the webhook delivery that started it. */
  userId: string;
  eventId: string;
};

export async function startPrRun(
  r: PrRun,
): Promise<{ workflowId: string; runId: string }> {
  const connection = await Connection.connect({ address: ADDRESS });
  try {
    const client = new Client({ connection, namespace: NAMESPACE });
    const workflowId = `lab:${r.repo}#${r.pr}`;
    // A newer push replaces the run of the same pull request.
    try {
      const old = client.workflow.getHandle(workflowId);
      const d = await old.describe();
      if (d.status.name === "RUNNING") {
        await old.signal(
          "replaced",
          `a newer push to PR #${r.pr} (${r.head.slice(0, 7)}) started a new run`,
        );
        await old.cancel();
        await old.result().catch(() => {});
      }
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError)) throw error;
    }
    const handle = await client.workflow.start("labChecks", {
      taskQueue: TASK_QUEUE,
      workflowId,
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
      args: [
        {
          repo: r.repo,
          pr: r.pr,
          head: r.head,
          base: r.base,
          title: r.title,
          prBranch: r.prBranch,
          profile: "fast",
          fix: true,
          origin: {
            source: "github",
            trigger: "github:pr_main",
            invokedBy: "webhook",
            eventId: r.eventId,
            userId: r.userId,
          },
          ...(r.report ? { report: r.report } : {}),
        },
      ],
    });
    return { workflowId, runId: handle.firstExecutionRunId };
  } finally {
    await connection.close();
  }
}

export type IncidentRun = {
  repo: string | null;
  trigger: string;
  why: string;
  issueId: string;
  projectId: string;
  title: string;
  link: string | null;
  report: ReportTarget | null;
};

/**
 * Starts Rox's run for a Sentry incident. One workflow id per issue: while a run for the issue is
 * still going, more alerts for it start nothing (started: false).
 */
export async function startIncidentRun(
  r: IncidentRun,
): Promise<{ workflowId: string; started: boolean }> {
  const connection = await Connection.connect({ address: ADDRESS });
  try {
    const client = new Client({ connection, namespace: NAMESPACE });
    const workflowId = `incident:sentry:${r.projectId}:${r.issueId}`;
    const { projectId: _p, ...args } = r;
    try {
      await client.workflow.start("incidentRun", {
        taskQueue: TASK_QUEUE,
        workflowId,
        workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
        args: [args],
      });
      return { workflowId, started: true };
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError)
        return { workflowId, started: false };
      throw error;
    }
  } finally {
    await connection.close();
  }
}

/** The chat buttons and `@rox stop|pause|continue` call these; one run per pull request. */
export async function controlPrRun(
  action: "pause" | "resume" | "abort",
  repo: string,
  pr: number,
  why = `${action} from Rox`,
) {
  const { abortRun, pauseRun, resumeRun } = await import(
    "../../pipeline/temporal/control"
  );
  const connection = await Connection.connect({ address: ADDRESS });
  try {
    const client = new Client({ connection, namespace: NAMESPACE });
    const workflowId = `lab:${repo}#${pr}`;
    return action === "pause"
      ? await pauseRun(client, workflowId, why)
      : action === "resume"
        ? await resumeRun(client, workflowId)
        : await abortRun(client, workflowId, why);
  } finally {
    await connection.close();
  }
}
