// Tools that read the pipeline's runs: the work Rox did on its own after a webhook (a PR, a Sentry
// issue, ...), or that was started from chat. Read-only, from the runs and run_events tables, which
// row-level security limits to this user. Every run returned carries its id, so the chat can show a
// View button that opens it (live) in the run sheet.
import { z } from "zod";
import { findTrigger } from "../../../src/lib/triggers";
import type {
  RunResult as Result,
  RunEventRow,
  RunRow,
  RunStatus,
} from "../store/sessions";
import { defineTool } from "./define";
import { plural } from "./shared";
import { ToolError } from "./types";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * What the model may filter on, in the words each run's result uses. Some are groups:
 * failed means every way a run can fail, including giving up, as on the Runs page.
 */
const RESULT_FILTERS = {
  live: ["running", "paused"],
  failed: ["failed", "gave_up", "stopped_infra"],
  gave_up: ["gave_up"],
  pr_opened: ["pr_opened"],
  fixed_no_pr: ["fixed_no_pr"],
  fixed: ["pr_opened", "fixed_no_pr"],
  nothing_to_fix: ["nothing_to_fix"],
  cancelled: ["cancelled", "aborted"],
} as const satisfies Record<string, readonly Result[]>;
type ResultFilter = keyof typeof RESULT_FILTERS;

/** Same rule as RESULT_SQL in the store, for one run already read. */
function resultOf(
  status: RunStatus,
  outcome: string | null,
  pr: boolean,
): Result {
  if (status === "running" || status === "paused") return status;
  if (status === "failed") return "failed";
  if (status === "cancelled" || status === "aborted") return status;
  if (outcome === "fixed") return pr ? "pr_opened" : "fixed_no_pr";
  if (outcome === "nothing_to_fix") return "nothing_to_fix";
  if (outcome === "gave_up") return "gave_up";
  if (outcome === "infra") return "stopped_infra";
  return "finished";
}

const RESULT_LABEL: Record<Result, string> = {
  running: "Running now",
  paused: "Paused",
  pr_opened: "Fixed, pull request opened",
  fixed_no_pr: "Fix verified, but no pull request was opened",
  nothing_to_fix: "Nothing to fix",
  gave_up: "Gave up: no safe fix found (counts as failed)",
  failed: "Failed",
  stopped_infra: "Stopped by an infrastructure problem",
  cancelled: "Cancelled",
  aborted: "Aborted",
  finished: "Finished",
};

/** A run as the model reads it: names, not codes; times as ISO; no token counts. */
function describeRun(r: RunRow) {
  const trigger = r.trigger ? findTrigger(r.trigger) : null;
  const result = resultOf(r.status, r.outcome, Boolean(r.prUrl));
  return {
    runId: r.runId,
    result,
    resultLabel: RESULT_LABEL[result],
    status: r.status,
    live: r.status === "running" || r.status === "paused",
    outcome: r.outcome,
    title: r.title,
    repo: r.repo,
    pr: r.pr,
    startedBy:
      r.invokedBy === "webhook"
        ? `webhook: ${trigger ? `${trigger.provider.name} · ${trigger.item.label}` : (r.trigger ?? r.source)}`
        : r.invokedBy === "chat"
          ? "asked in chat"
          : "started by hand (cli)",
    trigger: r.trigger,
    source: r.source,
    pullRequestOpened: r.prUrl,
    pullRequestMergedAt: iso(r.prMergedAt),
    reason: r.reason,
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    durationMs:
      r.durationMs ??
      (r.finishedAt ? null : Date.now() - r.startedAt.getTime()),
    costUsd: Math.round(r.costUsd * 10_000) / 10_000,
    modelCalls: r.modelCalls,
    steps: r.lastSeq,
  };
}

const describeEvent = (e: RunEventRow) => ({
  seq: e.seq,
  at: e.at.toISOString(),
  step: e.step,
  kind: e.kind,
  title: e.title,
  status: e.status,
  ms: e.ms,
  ...(e.attempt && e.attempt > 1 ? { attempt: e.attempt } : {}),
});

/** "today", "24h", "7d", "30d", or an ISO date: the start of the window. */
function sinceDate(since: string | undefined): Date | undefined {
  if (!since || since === "all") return undefined;
  const now = Date.now();
  if (since === "today") {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  const rel = /^(\d{1,3})(h|d)$/.exec(since);
  if (rel)
    return new Date(
      now - Number(rel[1]) * (rel[2] === "h" ? 3_600_000 : 86_400_000),
    );
  const date = new Date(since);
  if (Number.isNaN(date.getTime()))
    throw new ToolError(
      "invalid_input",
      `'since' must be today, 24h, 7d, 30d, all or an ISO date; got "${since}"`,
      { hint: "Use 7d for the last week, or an ISO date like 2026-11-01." },
    );
  return date;
}

export const runsQuery = defineTool({
  name: "runs_query",
  group: "runs",
  description:
    "Lists Rox's pipeline runs in a time window, newest first. A run is the work Rox does on its own after an event (a pull request, a failed CI check, a Sentry issue) or when asked in chat: it checks, fixes and may open a pull request. " +
    "Use it for: is anything running now (result live), what failed today (result failed), the runs of PR 12, how many runs Rox did this week, which runs opened a pull request (result pr_opened). " +
    "windowTotals always counts EVERY run in the window, whatever the result filter, so use it for counts and to say what else ran. Each run has a result; report that, never the raw status (a run with status succeeded can still have given up, which counts as failed). " +
    "windowTotals.pullRequestsMerged counts runs whose pull request was merged; each run has pullRequestMergedAt. Each run has a runId; pass it to runs_get for its steps. Do NOT use it for pull requests in general (repo_info) or for chat history.",
  input: z.object({
    result: z
      .array(
        z.enum(
          Object.keys(RESULT_FILTERS) as [ResultFilter, ...ResultFilter[]],
        ),
      )
      .optional()
      .describe(
        "Only runs that came to this. live: running or paused. failed: failed, gave up or stopped by infrastructure. fixed: pr_opened or fixed_no_pr. Leave out for every run.",
      ),
    since: z
      .string()
      .optional()
      .describe(
        "Start of the window: today, 24h, 7d, 30d, all, or an ISO date. Default 7d.",
      ),
    source: z
      .string()
      .optional()
      .describe(
        "What woke it: github, sentry, vercel, grafana, betterstack, chat or cli.",
      ),
    trigger: z
      .string()
      .optional()
      .describe("A trigger id from Settings > Workflow, e.g. github:pr_main."),
    pr: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Only runs about this pull request number."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        "How many matching runs to list. Default 10. The counts cover every run.",
      ),
  }),
  risk: "read",
  timeoutMs: 10_000,
  title: (i) =>
    i.result?.includes("live")
      ? "Look for live runs"
      : i.result?.includes("failed")
        ? "Look for failed runs"
        : "Look up the runs",
  async run(input, ctx) {
    const since = sinceDate(input.since ?? "7d");
    const results = input.result?.length
      ? [...new Set(input.result.flatMap((r) => RESULT_FILTERS[r]))]
      : undefined;
    const list = await ctx.store.listRuns(ctx.userId, {
      results,
      source: input.source,
      trigger: input.trigger,
      pr: input.pr,
      since,
      limit: input.limit ?? 10,
    });
    const n = (...keys: Result[]) =>
      keys.reduce((sum, k) => sum + (list.windowByResult[k] ?? 0), 0);
    const windowTotals = {
      runs: list.windowTotal,
      live: n("running", "paused"),
      pullRequestsOpened: n("pr_opened"),
      pullRequestsMerged: list.windowMerged,
      fixedWithoutPullRequest: n("fixed_no_pr"),
      nothingToFix: n("nothing_to_fix"),
      failed: n("failed", "gave_up", "stopped_infra"),
      ofWhichGaveUp: n("gave_up"),
      cancelledOrAborted: n("cancelled", "aborted"),
      finishedOther: n("finished"),
    };
    return {
      window: since ? `since ${since.toISOString()}` : "all time",
      windowTotals,
      filter: input.result?.length ? input.result : "none",
      matching: list.matching,
      shown: list.runs.length,
      runs: list.runs.map(describeRun),
      ...(list.windowTotal === 0
        ? {
            note: "No run at all in this window. Say exactly that; widen it (since: all) before saying Rox has never run.",
          }
        : list.matching === 0
          ? {
              note: `No run in the window matches the filter, but the window has ${plural(list.windowTotal, "run")}: see windowTotals. Report those numbers as they are; do not describe runs you were not shown.`,
            }
          : {}),
    };
  },
  summarize(output) {
    const o = output as {
      matching: number;
      filter: unknown;
      windowTotals: { runs: number; live: number; failed: number };
    };
    const { runs, live, failed } = o.windowTotals;
    const head =
      o.filter === "none"
        ? plural(runs, "run")
        : `${o.matching} matching of ${plural(runs, "run")}`;
    return `${head}${live ? `, ${live} live` : ""}${failed ? `, ${failed} failed` : ""}`;
  },
});

export const runsGet = defineTool({
  name: "runs_get",
  group: "runs",
  description:
    "Reads one run in detail: its status, what started it, what it concluded, the pull request it opened, why it failed, and its steps in order. " +
    "Pass a runId from runs_query, or 'live' for the run going on right now, or 'latest' for the most recent one. " +
    "For 'what is it doing now' on a live run, call it again with afterSeq set to the last step seq you saw, to get only the new steps. Do not call it in a loop to watch a run: the user can open the run, which updates by itself.",
  input: z.object({
    run: z
      .string()
      .min(1)
      .max(200)
      .describe("A runId, or 'live', or 'latest'."),
    afterSeq: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Only steps after this seq. Leave out for the run's last steps.",
      ),
    steps: z
      .number()
      .int()
      .min(1)
      .max(60)
      .optional()
      .describe("How many steps at most. Default 25 (the latest ones)."),
  }),
  risk: "read",
  timeoutMs: 10_000,
  title: (i) =>
    i.run === "live"
      ? "Read the live run"
      : i.run === "latest"
        ? "Read the latest run"
        : "Read the run",
  async run(input, ctx) {
    let run: RunRow | null;
    if (input.run === "live" || input.run === "latest") {
      const list = await ctx.store.listRuns(ctx.userId, {
        results: input.run === "live" ? ["running", "paused"] : undefined,
        limit: 1,
      });
      run = list.runs[0] ?? null;
      if (!run)
        throw new ToolError(
          "not_found",
          input.run === "live"
            ? "No run is going on right now"
            : "Rox has no runs yet",
          {
            hint:
              input.run === "live"
                ? "Say nothing is running. runs_query with since: today shows what ran earlier."
                : "Say there are no runs yet.",
            retryable: false,
          },
        );
    } else {
      run = await ctx.store.getRun(ctx.userId, input.run);
      if (!run)
        throw new ToolError("not_found", `No run with id "${input.run}"`, {
          hint: "Use a runId exactly as runs_query returned it.",
          retryable: false,
        });
    }
    const events = await ctx.store.listRunEvents(
      ctx.userId,
      run.runId,
      input.afterSeq ?? 0,
      input.steps ?? 25,
    );
    const firstShown = events[0]?.seq ?? run.lastSeq + 1;
    return {
      run: describeRun(run),
      steps: events.map(describeEvent),
      ...(input.afterSeq === undefined && firstShown > 1
        ? { earlierSteps: firstShown - 1 }
        : {}),
      lastSeq: run.lastSeq,
    };
  },
  summarize(output) {
    const o = output as {
      run: { resultLabel: string; title: string | null };
      steps: unknown[];
    };
    return `${o.run.resultLabel}${o.run.title ? ` · ${o.run.title}` : ""} · ${plural(o.steps.length, "step")}`;
  },
});
