// The run's own row in `runs`: who started it, how, about what, and how it ended. Tokens and cost
// are added by events.ts as each model call happens; this file sets the rest.
import { db } from "./db";

/** Who and what started a run. Set by whoever starts the workflow; never by event content. */
export type RunOrigin = {
  /** github, sentry, vercel, grafana, betterstack, cli, chat */
  source: string;
  /** The trigger id from Settings > Workflow, e.g. "github:pr_main". */
  trigger?: string | null;
  invokedBy: "webhook" | "chat" | "cli";
  /** The webhook delivery that started it. */
  eventId?: string | null;
  userId?: string | null;
};

export type RunFinal = "succeeded" | "failed" | "cancelled" | "aborted";

/** Records the start (again, after a retry: the start time stays the first one). */
export async function startRun(r: {
  run: string;
  workflowId: string;
  origin: RunOrigin;
  repo: string;
  pr: number | null;
  head: string;
  base: string | null;
  title: string | null;
}) {
  await db().query(
    `INSERT INTO runs (run_id, workflow_id, user_id, source, trigger, invoked_by, event_id,
                       repo, pr_number, head_sha, base_sha, title, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'running')
     ON CONFLICT (run_id) DO UPDATE SET
       workflow_id = EXCLUDED.workflow_id, user_id = EXCLUDED.user_id,
       source = EXCLUDED.source, trigger = EXCLUDED.trigger,
       invoked_by = EXCLUDED.invoked_by, event_id = EXCLUDED.event_id,
       repo = EXCLUDED.repo, pr_number = EXCLUDED.pr_number, head_sha = EXCLUDED.head_sha,
       base_sha = EXCLUDED.base_sha, title = EXCLUDED.title`,
    [
      r.run,
      r.workflowId,
      r.origin.userId ?? null,
      r.origin.source,
      r.origin.trigger ?? null,
      r.origin.invokedBy,
      r.origin.eventId ?? null,
      r.repo,
      r.pr,
      r.head,
      r.base,
      r.title,
    ],
  );
}

export async function setRunStatus(run: string, status: "running" | "paused") {
  await db().query(
    "UPDATE runs SET status = $2 WHERE run_id = $1 AND finished_at IS NULL",
    [run, status],
  );
}

/** What the fix agent concluded, and its pull request when it opened one. */
export async function setRunOutcome(
  run: string,
  outcome: string | null,
  prUrl: string | null,
) {
  await db().query(
    "UPDATE runs SET outcome = coalesce($2, outcome), pr_url = coalesce($3, pr_url) WHERE run_id = $1",
    [run, outcome, prUrl],
  );
}

/** Rox merged its own pull request (Merge PR in Settings > Agent). */
export async function markMerged(run: string) {
  await db().query("UPDATE runs SET pr_merged_at = now() WHERE run_id = $1", [
    run,
  ]);
}

/** The settings the run used, and what was left of the day budget when it started. */
export async function recordSettings(
  run: string,
  s: {
    modelId: string;
    prAction: string;
    dayBudgetUsd: number;
    leftUsd: number;
  },
) {
  await db().query(
    `UPDATE runs SET model = $2, pr_action = $3, day_budget_usd = $4, budget_left_usd = $5
      WHERE run_id = $1`,
    [run, s.modelId, s.prAction, s.dayBudgetUsd, s.leftUsd],
  );
}

/** The end of the run. Only the first end counts, so a cleanup after an abort changes nothing. */
export async function finishRun(
  run: string,
  status: RunFinal,
  reason: string | null,
) {
  await db().query(
    `UPDATE runs SET status = $2, reason = $3, finished_at = now(),
            duration_ms = (extract(epoch from now() - started_at) * 1000)::bigint
      WHERE run_id = $1 AND finished_at IS NULL`,
    [run, status, reason],
  );
}
