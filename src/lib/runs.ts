// Reads the pipeline's runs and their events for the signed-in user. The pipeline writes them
// (pipeline/src/runs.ts, pipeline/src/events.ts); the web only reads, always filtered by user.
import { db } from "./db";

export type RunStatus =
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "aborted";

export type RunView = {
  id: string;
  workflowId: string;
  source: string;
  trigger: string | null;
  invokedBy: string;
  eventId: string | null;
  repo: string | null;
  pr: number | null;
  head: string | null;
  title: string | null;
  status: RunStatus;
  outcome: string | null;
  prUrl: string | null;
  prMergedAt: string | null;
  reason: string | null;
  model: string | null;
  prAction: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  modelCalls: number;
  dayBudgetUsd: number | null;
  lastSeq: number;
};

export type RunEventView = {
  seq: number;
  at: string;
  step: string;
  kind: string;
  title: string;
  status: string | null;
  ms: number | null;
  attempt: number | null;
  data: Record<string, unknown> | null;
};

const COLUMNS = `run_id, workflow_id, source, trigger, invoked_by, event_id, repo, pr_number, head_sha,
  title, status, outcome, pr_url, pr_merged_at, reason, model, pr_action, started_at, finished_at,
  duration_ms, tokens_in, tokens_out, cost_usd, model_calls, day_budget_usd, last_seq`;

type Row = {
  run_id: string;
  workflow_id: string;
  source: string;
  trigger: string | null;
  invoked_by: string;
  event_id: string | null;
  repo: string | null;
  pr_number: number | null;
  head_sha: string | null;
  title: string | null;
  status: RunStatus;
  outcome: string | null;
  pr_url: string | null;
  pr_merged_at: Date | null;
  reason: string | null;
  model: string | null;
  pr_action: string | null;
  started_at: Date;
  finished_at: Date | null;
  duration_ms: string | null;
  tokens_in: string;
  tokens_out: string;
  cost_usd: string;
  model_calls: number;
  day_budget_usd: string | null;
  last_seq: number;
};

const view = (r: Row): RunView => ({
  id: r.run_id,
  workflowId: r.workflow_id,
  source: r.source,
  trigger: r.trigger,
  invokedBy: r.invoked_by,
  eventId: r.event_id,
  repo: r.repo,
  pr: r.pr_number,
  head: r.head_sha,
  title: r.title,
  status: r.status,
  outcome: r.outcome,
  prUrl: r.pr_url,
  prMergedAt: r.pr_merged_at?.toISOString() ?? null,
  reason: r.reason,
  model: r.model,
  prAction: r.pr_action,
  startedAt: r.started_at.toISOString(),
  finishedAt: r.finished_at?.toISOString() ?? null,
  durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
  tokensIn: Number(r.tokens_in),
  tokensOut: Number(r.tokens_out),
  costUsd: Number(r.cost_usd),
  modelCalls: r.model_calls,
  dayBudgetUsd: r.day_budget_usd === null ? null : Number(r.day_budget_usd),
  lastSeq: r.last_seq,
});

/** The running (or paused) run, if any, and the last few runs. */
export async function runsOverview(
  userId: string,
): Promise<{ active: RunView | null; recent: RunView[] }> {
  const { rows } = await db().query<Row>(
    `SELECT ${COLUMNS} FROM runs WHERE user_id = $1 ORDER BY started_at DESC LIMIT 8`,
    [userId],
  );
  const runs = rows.map(view);
  return {
    active:
      runs.find((r) => r.status === "running" || r.status === "paused") ?? null,
    recent: runs,
  };
}

export async function getRun(
  userId: string,
  runId: string,
): Promise<RunView | null> {
  const { rows } = await db().query<Row>(
    `SELECT ${COLUMNS} FROM runs WHERE user_id = $1 AND run_id = $2`,
    [userId, runId],
  );
  return rows[0] ? view(rows[0]) : null;
}

/** The run's events after `after`, in order. Only for a run of this user. */
export async function runEvents(
  userId: string,
  runId: string,
  after: number,
): Promise<RunEventView[]> {
  const { rows } = await db().query<{
    seq: number;
    at: Date;
    step: string;
    kind: string;
    title: string;
    status: string | null;
    ms: number | null;
    attempt: number | null;
    data: Record<string, unknown> | null;
  }>(
    `SELECT e.seq, e.at, e.step, e.kind, e.title, e.status, e.ms, e.attempt, e.data
       FROM run_events e JOIN runs r ON r.run_id = e.run_id
      WHERE r.user_id = $1 AND e.run_id = $2 AND e.seq > $3
      ORDER BY e.seq LIMIT 500`,
    [userId, runId, after],
  );
  return rows.map((e) => ({ ...e, at: e.at.toISOString() }));
}
