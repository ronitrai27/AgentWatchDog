// Rox Lab workflow: the checks of one pull request. Temporal records every finished step, so
// after a worker crash, a restart or a lost connection the run continues where it was.
//
// Pause stops the running step at once (within a heartbeat, about 5 s) and keeps the sandbox and
// the agent's checkpoints; resume runs that step again, and the fix agent continues from its last
// finished node. Abort (see labAbort) ends everything at once.
import {
  ActivityCancellationType,
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";
import type { IncidentFacts } from "../../agent/src/integrations/sentry";
import type { FixResult } from "../agent/run";
import type { CheckResult } from "../src/checks";
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
/** Stops the running step now and waits; the sandbox and checkpoints are kept. */
export const pauseSignal = defineSignal<[string]>("pause");
/** Runs the paused step again; the fix agent continues from its last finished node. */
export const resumeSignal = defineSignal<[]>("resume");

export type RunState = {
  run: string;
  repo: string;
  pr: number | null;
  /** The step running now (or the one that will run again after a pause). */
  step: string;
  paused: boolean;
  report: FixInput["report"] | null;
};
export const stateQuery = defineQuery<RunState>("state");

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

  // Pause: every running step is in a scope of its own, so a pause can stop them all at once.
  const root = CancellationScope.current();
  let paused = false;
  let pauseWhy = "";
  let step = "starting";
  const running = new Set<CancellationScope>();
  setHandler(pauseSignal, (why) => {
    if (paused) return;
    paused = true;
    pauseWhy = why;
    for (const scope of running) scope.cancel();
  });
  setHandler(resumeSignal, () => {
    paused = false;
  });
  setHandler(stateQuery, () => ({
    run: input.run,
    repo: input.repo,
    pr: input.pr,
    step,
    paused,
    report: start.report ?? null,
  }));
  /** Runs one step; if a pause stops it, waits for resume and runs it again. */
  const pausable = async <T>(
    name: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    for (;;) {
      if (paused) {
        await cleanup.labMark(
          input.run,
          "run.paused",
          `Paused before "${name}": ${pauseWhy}`,
        );
        await condition(() => !paused);
        await cleanup.labMark(input.run, "run.resumed", `Resumed at "${name}"`);
      }
      step = name;
      const scope = new CancellationScope();
      running.add(scope);
      try {
        const result = await scope.run(work);
        // A check or the install stopped by the pause returns a "cancelled" result instead of
        // throwing; that is not an answer either, so it runs again after resume.
        const r = result as { status?: string; cancelled?: boolean } | null;
        if (paused && (r?.status === "cancelled" || r?.cancelled === true))
          continue;
        return result;
      } catch (error) {
        // Stopped by a pause (not by a cancel or abort of the whole run): wait and run it again.
        if (paused && isCancellation(error) && !root.consideredCancelled)
          continue;
        throw error;
      } finally {
        running.delete(scope);
      }
    }
  };

  // Max time per run (Settings > Agent): past it, everything running is cancelled and the run
  // ends as cancelled, with the reason.
  let timedOut = false;
  try {
    const settings = await steps.labSettings(start.origin?.userId ?? null);
    input.settings = settings;
    const limited = new CancellationScope();
    let done = false;
    void sleep(settings.maxMinutes * 60_000).then(() => {
      if (done) return;
      timedOut = true;
      reason = `it ran longer than ${settings.maxMinutes} minutes (Max time per run, Settings > Agent)`;
      limited.cancel();
    });
    return await limited.run(async () => {
      try {
        const { plan: sharedPlan, facts } = await pausable("get the code", () =>
          steps.labPrepare(input),
        );
        // Agent_2 steps may fail without taking the run down: a failure means the safe fallback.
        // A cancel or pause still stops the run.
        // Always the pipeline agent (the Agent_2 clone in pipeline/agent).
        const agent2 = true;
        const soft = async <T>(work: () => Promise<T>): Promise<T | null> => {
          try {
            return await work();
          } catch (error) {
            if (isCancellation(error)) throw error;
            return null;
          }
        };
        if (agent2) {
          const gate = await soft(() =>
            pausable("language gate", () => steps.agent2Gate(input)),
          );
          if (gate && !gate.ok) {
            await steps.agent2Stop(
              input,
              gate.message ?? "Rox stopped: unsupported language",
              start.report ?? null,
            );
            step = "finishing";
            await steps.labFinish(input, results, "completed", null);
            return results;
          }
        }
        const installed = await pausable("install", () =>
          steps.labInstall(input, facts),
        );
        let plan = sharedPlan;
        if (agent2) {
          await soft(() =>
            pausable("code index", () => steps.agent2Analyze(input, installed)),
          );
          plan =
            (await soft(() =>
              pausable("check plan", () => steps.agent2Plan(input, facts)),
            )) ?? sharedPlan;
        }
        const check = (item: (typeof plan)[number], prior: CheckResult[]) =>
          agent2
            ? steps.agent2Check(input, item, facts, installed, prior)
            : steps.labCheck(input, item, facts, installed, prior);

        // Checks on the installed copy share one folder, so they run one after another.
        // Checks on the read-only source run at the same time.
        const onWork = plan.filter((p) => p.on === "work");
        const onSource = plan.filter((p) => p.on === "source");
        // Each check on the work copy sees the results before it (replay needs the test results).
        await Promise.all([
          (async () => {
            for (const item of onWork)
              results.push(
                await pausable(item.title, () => check(item, [...results])),
              );
          })(),
          ...onSource.map(async (item) =>
            results.push(await pausable(item.title, () => check(item, []))),
          ),
        ]);
        // U4: the security hunt, on its own budget. It never decides whether the fix agent runs.
        if (agent2)
          await soft(() =>
            pausable("security hunt", () => steps.agent2Hunt(input)),
          );
        const failed = (id: string) =>
          results.some((r) => r.id === id && r.status === "fail");
        const fixing =
          start.fix &&
          installed.head &&
          (failed("test") || failed("typecheck"));
        // Without a fix run, the agent does not report; the run says how it ended instead.
        if (!fixing && start.report)
          await steps.labNote(
            {
              run: input.run,
              repo: input.repo,
              pr: input.pr,
              report: start.report,
            },
            "checked",
            results,
            installed.head ? null : installed.summary,
          );
        if (fixing)
          await pausable("fix agent", () =>
            steps.labFix({
              run: input.run,
              repo: input.repo,
              workspaces: facts.workspaces,
              head: input.head,
              base: input.base,
              report: start.report,
              settings,
              ...(start.prBranch
                ? {
                    publish: {
                      repo: input.repo,
                      kind: "pr" as const,
                      branch: start.prBranch,
                    },
                  }
                : {}),
            }),
          );
        step = "finishing";
        await steps.labFinish(input, results, "completed", null);
        return results;
      } finally {
        done = true;
      }
    });
  } catch (error) {
    if (timedOut && start.report)
      await CancellationScope.nonCancellable(() =>
        cleanup
          .labNote(
            {
              run: input.run,
              repo: input.repo,
              pr: input.pr,
              report: start.report as NonNullable<LabStart["report"]>,
            },
            "timed_out",
            results,
            reason,
          )
          .catch(() => {}),
      );
    // A crash (not a cancel by a newer run) is reported too, so no run ends silently.
    const report = start.report;
    if (!isCancellation(error) && report)
      await CancellationScope.nonCancellable(() =>
        cleanup
          .labNote(
            { run: input.run, repo: input.repo, pr: input.pr, report },
            "crashed",
            results,
            error instanceof Error ? error.message : String(error),
          )
          .catch(() => {}),
      );
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
  publishTo: string | null,
  userId: string,
): Promise<FixResult> {
  const { runId } = workflowInfo();
  try {
    const settings = await steps.labSettings(userId);
    return await steps.labFix({
      run: runId,
      caseId,
      settings,
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

/**
 * The kill switch's cleanup. The run itself was terminated at once (no step is waited for); this
 * destroys its sandbox, writes where it stopped into the trace, and tells the user's channel.
 */
export async function labAbort(state: RunState, why: string): Promise<void> {
  const at = await cleanup.labDestroy(state.run, state.step, why);
  if (state.report)
    await cleanup
      .labNote(
        {
          run: state.run,
          repo: state.repo,
          pr: state.pr,
          report: state.report,
        },
        "aborted",
        [],
        `${why} (stopped at: ${at})`,
      )
      .catch(() => {});
}

/**
 * A Sentry incident (new issue, error spike or regression). One workflow per issue, so a burst of
 * alerts for the same issue never starts a second run. Today it gathers the facts from Sentry and
 * reports them; the investigate-and-fix steps come next.
 */
export async function incidentRun(
  input: Omit<activities.IncidentInput, "run">,
): Promise<IncidentFacts> {
  const { runId } = workflowInfo();
  return steps.incidentBrief({ ...input, run: runId });
}
