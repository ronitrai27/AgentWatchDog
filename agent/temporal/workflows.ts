// Rox Lab workflow: the checks of one pull request. Temporal records every finished step, so
// after a worker crash, a restart or a lost connection the run continues where it was.
import {
  ActivityCancellationType,
  CancellationScope,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import type { FixResult } from "../../Tests/src/agent/run";
import type { CheckResult } from "../../Tests/src/checks";
// Only types are imported: workflow code runs in Temporal's deterministic sandbox.
import type * as activities from "./activities";
import type { FixInput, LabInput } from "./activities";

const steps = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 minutes",
  // Heartbeats reach Temporal at most every ~80% of this, which is also how fast a cancel
  // reaches a running step and how fast a dead worker is noticed.
  heartbeatTimeout: "10 seconds",
  retry: { maximumAttempts: 3, initialInterval: "5 seconds" },
  // On cancel, wait until each running step has stopped its sandbox, so cleanup comes last
  // and the trace stays in order.
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

const cleanup = proxyActivities<typeof activities>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 5 },
});

/** Sent just before a cancel, to say why the run is being stopped. */
export const replacedSignal = defineSignal<[string]>("replaced");

export type LabStart = Omit<LabInput, "run" | "workflowId"> & {
  /** Let the agent fix what failed. */
  fix?: boolean;
  /** The pull request's branch: the agent's fix is proposed to it. */
  prBranch?: string;
  /** Where the agent's final report goes. */
  report?: FixInput["report"];
};

export async function labChecks(start: LabStart): Promise<CheckResult[]> {
  let reason: string | null = null;
  setHandler(replacedSignal, (why) => {
    reason = why;
  });
  const info = workflowInfo();
  const input: LabInput = {
    ...start,
    run: info.runId,
    workflowId: info.workflowId,
  };
  const results: CheckResult[] = [];

  try {
    const { plan, facts } = await steps.labPrepare(input);
    const installed = await steps.labInstall(input, facts);

    // Checks on the installed copy share one folder, so they run one after another.
    // Checks on the read-only source run at the same time.
    const onWork = plan.filter((p) => p.on === "work");
    const onSource = plan.filter((p) => p.on === "source");
    // Each check on the work copy sees the results before it (replay needs the test results).
    await Promise.all([
      (async () => {
        for (const item of onWork)
          results.push(
            await steps.labCheck(input, item, facts, installed, [...results]),
          );
      })(),
      ...onSource.map(async (item) =>
        results.push(await steps.labCheck(input, item, facts, installed, [])),
      ),
    ]);
    const failed = (id: string) =>
      results.some((r) => r.id === id && r.status === "fail");
    if (start.fix && installed.head && (failed("test") || failed("typecheck")))
      await steps.labFix({
        run: input.run,
        repo: input.repo,
        workspaces: facts.workspaces,
        head: input.head,
        base: input.base,
        report: start.report,
        ...(start.prBranch
          ? {
              publish: {
                repo: input.repo,
                kind: "pr" as const,
                branch: start.prBranch,
              },
            }
          : {}),
      });
    await steps.labFinish(input, results, "completed", null);
    return results;
  } catch (error) {
    await CancellationScope.nonCancellable(() =>
      isCancellation(error)
        ? cleanup.labFinish(
            input,
            results,
            "cancelled",
            reason ?? "the run was cancelled",
          )
        : cleanup.labFinish(
            input,
            results,
            "failed",
            error instanceof Error ? error.message : String(error),
          ),
    );
    throw error;
  } finally {
    await CancellationScope.nonCancellable(() => cleanup.labCleanup(input));
  }
}

/** The fix agent alone, on one seeded bug of the lab. */
export async function labCase(
  caseId: string,
  publishTo: string | null = null,
): Promise<FixResult> {
  const { runId } = workflowInfo();
  try {
    return await steps.labFix({
      run: runId,
      caseId,
      workspaces: [],
      ...(publishTo
        ? { publish: { repo: publishTo, kind: "seeded" as const } }
        : {}),
    });
  } finally {
    await CancellationScope.nonCancellable(() =>
      cleanup.labCleanup({ run: runId }),
    );
  }
}
