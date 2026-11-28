// The agent's side of the chat log: it is the only writer of events and turns. Every call
// names the user it acts for, and the database refuses anything outside that user's rows.
import {
  type AgentConfig,
  CONFIG_COLUMNS,
  type ConfigRow,
  RUNS_TODAY_SQL,
  TODAY_SQL,
  type TodayRow,
  toConfig,
} from "../../../src/lib/agent-config";
import { costUsd } from "../../../src/lib/models";
import type { Db } from "../db";
import { redactValue } from "../redact";

export type SessionRow = {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  eventCount: number;
  turnCount: number;
  execMs: number;
};

export type StoredEvent = {
  seq: number;
  id: string;
  occurredAt: Date;
  turnId: string | null;
  type: string;
  data: Record<string, unknown>;
  durationMs: number | null;
};

export type TurnStatus = "running" | "completed" | "failed" | "stopped";

export type TurnRow = {
  id: string;
  n: number;
  status: TurnStatus;
  model: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
};

export type SetupRow = {
  repo: string | null;
  installationId: number | null;
  orchestrator: string | null;
  subagent: string | null;
  sandbox: string | null;
  sandboxCheckedAt: Date | null;
  /** The Sentry project whose webhooks wake Rox for this user; null when not connected. */
  sentry?: { org: string; project: string; connectedAt: Date } | null;
  /** The invocation triggers on in Settings > Workflow ("sentry:new_issue", ...). */
  triggers?: string[];
};

export type ReportConnectionRow = {
  provider: string;
  workspace: string | null;
  channelId: string;
  channelName: string | null;
  connectedAt: Date;
};

export type UserRow = {
  id: string;
  login: string;
  name: string | null;
  isDemo: boolean;
};

export type StoredKey = {
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
  models: string[];
};

export class NotFoundError extends Error {
  constructor(what = "session") {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

type RawSession = {
  id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
  next_seq: string;
  turn_count: number;
  exec_ms: string;
};
const SESSION_COLUMNS =
  "id, name, created_at, updated_at, next_seq, turn_count, exec_ms";
const toSession = (r: RawSession): SessionRow => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  eventCount: Number(r.next_seq) - 1,
  turnCount: r.turn_count,
  execMs: Number(r.exec_ms),
});

type RawTurn = {
  id: string;
  n: number;
  status: TurnStatus;
  model: string | null;
  started_at: Date;
  finished_at: Date | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  error: string | null;
};
const TURN_COLUMNS =
  "id, n, status, model, started_at, finished_at, duration_ms, input_tokens, output_tokens, error";
const toTurn = (r: RawTurn): TurnRow => ({
  id: r.id,
  n: r.n,
  status: r.status,
  model: r.model,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  durationMs: r.duration_ms,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  error: r.error,
});

type RawEvent = {
  seq: string;
  id: string;
  occurred_at: Date;
  turn_id: string | null;
  type: string;
  data: Record<string, unknown>;
  duration_ms: number | null;
};
const EVENT_COLUMNS = "seq, id, occurred_at, turn_id, type, data, duration_ms";
const toEvent = (r: RawEvent): StoredEvent => ({
  seq: Number(r.seq),
  id: r.id,
  occurredAt: r.occurred_at,
  turnId: r.turn_id,
  type: r.type,
  data: r.data,
  durationMs: r.duration_ms,
});

export type RunStatus =
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "aborted";

/**
 * What a run came to, by the same rules as the Runs page: a run whose status is succeeded but
 * that gave up is gave_up, and a fix is pr_opened only when a pull request exists.
 */
export type RunResult =
  | "running"
  | "paused"
  | "pr_opened"
  | "fixed_no_pr"
  | "nothing_to_fix"
  | "gave_up"
  | "failed"
  | "stopped_infra"
  | "cancelled"
  | "aborted"
  | "finished";

/** The same rule in SQL, so filters and counts agree with what each run says. */
const RESULT_SQL = `CASE
  WHEN status IN ('running', 'paused', 'failed', 'cancelled', 'aborted') THEN status
  WHEN outcome = 'fixed' AND pr_url IS NOT NULL THEN 'pr_opened'
  WHEN outcome = 'fixed' THEN 'fixed_no_pr'
  WHEN outcome = 'nothing_to_fix' THEN 'nothing_to_fix'
  WHEN outcome = 'gave_up' THEN 'gave_up'
  WHEN outcome = 'infra' THEN 'stopped_infra'
  ELSE 'finished' END`;

export type RunFilter = {
  /** Only runs that came to one of these. The window's counts ignore it. */
  results?: RunResult[];
  source?: string;
  trigger?: string;
  repo?: string;
  pr?: number;
  since?: Date;
  until?: Date;
  limit: number;
};

export type RunRow = {
  runId: string;
  source: string;
  trigger: string | null;
  invokedBy: string;
  repo: string | null;
  pr: number | null;
  headSha: string | null;
  title: string | null;
  status: RunStatus;
  outcome: string | null;
  prUrl: string | null;
  reason: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  costUsd: number;
  modelCalls: number;
  lastSeq: number;
  /** When Rox's pull request for this run was merged, or null. */
  prMergedAt: Date | null;
};

export type RunList = {
  /** Every run in the window (time, source, trigger, repo, PR), whatever it came to. */
  windowTotal: number;
  /** Those runs counted by result. */
  windowByResult: Partial<Record<RunResult, number>>;
  /** Runs in the window whose pull request was merged. */
  windowMerged: number;
  /** How many runs also match the result filter. */
  matching: number;
  /** The matching runs, newest first, at most `limit`. */
  runs: RunRow[];
};

export type RunEventRow = {
  seq: number;
  at: Date;
  step: string;
  kind: string;
  title: string;
  status: string | null;
  ms: number | null;
  attempt: number | null;
};

type RawRun = {
  run_id: string;
  source: string;
  trigger: string | null;
  invoked_by: string;
  repo: string | null;
  pr_number: number | null;
  head_sha: string | null;
  title: string | null;
  status: RunStatus;
  outcome: string | null;
  pr_url: string | null;
  reason: string | null;
  started_at: Date;
  finished_at: Date | null;
  duration_ms: string | null;
  cost_usd: string;
  model_calls: number;
  last_seq: number;
  pr_merged_at: Date | null;
};
const RUN_COLUMNS =
  "run_id, source, trigger, invoked_by, repo, pr_number, head_sha, title, status, outcome, pr_url, pr_merged_at, reason, started_at, finished_at, duration_ms, cost_usd, model_calls, last_seq";
const toRun = (r: RawRun): RunRow => ({
  runId: r.run_id,
  source: r.source,
  trigger: r.trigger,
  invokedBy: r.invoked_by,
  repo: r.repo,
  pr: r.pr_number,
  headSha: r.head_sha,
  title: r.title,
  status: r.status,
  outcome: r.outcome,
  prUrl: r.pr_url,
  reason: r.reason,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
  costUsd: Number(r.cost_usd),
  modelCalls: r.model_calls,
  lastSeq: r.last_seq,
  prMergedAt: r.pr_merged_at,
});

export type Store = ReturnType<typeof createStore>;

export function createStore(db: Db) {
  return {
    async createSession(
      userId: string,
      name = "New chat",
    ): Promise<SessionRow> {
      return db.withUser(userId, async (c) => {
        const { rows } = await c.query<RawSession>(
          `INSERT INTO sessions (user_id, name) VALUES ($1, $2) RETURNING ${SESSION_COLUMNS}`,
          [userId, name.slice(0, 120) || "New chat"],
        );
        return toSession(rows[0]);
      });
    },

    async getSession(
      userId: string,
      sessionId: string,
    ): Promise<SessionRow | null> {
      return db.withUser(userId, async (c) => {
        const { rows } = await c.query<RawSession>(
          `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = $1`,
          [sessionId],
        );
        return rows[0] ? toSession(rows[0]) : null;
      });
    },

    async renameSession(
      userId: string,
      sessionId: string,
      name: string,
    ): Promise<void> {
      await db.withUser(userId, async (c) => {
        const { rowCount } = await c.query(
          "UPDATE sessions SET name = $2 WHERE id = $1",
          [sessionId, name.slice(0, 120)],
        );
        if (!rowCount) throw new NotFoundError();
      });
    },

    async startTurn(
      userId: string,
      sessionId: string,
      model: string | null,
    ): Promise<TurnRow> {
      try {
        return await db.withUser(userId, async (c) => {
          const { rows } = await c.query<RawTurn>(
            `INSERT INTO session_turns (session_id, model) VALUES ($1, $2) RETURNING ${TURN_COLUMNS}`,
            [sessionId, model],
          );
          return toTurn(rows[0]);
        });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "42501" || code === "23503") throw new NotFoundError();
        throw error;
      }
    },

    async finishTurn(
      userId: string,
      turnId: string,
      result: {
        status: Exclude<TurnStatus, "running">;
        inputTokens?: number;
        outputTokens?: number;
        error?: string;
      },
    ): Promise<TurnRow> {
      return db.withUser(userId, async (c) => {
        const { rows } = await c.query<RawTurn>(
          `UPDATE session_turns SET status = $2, input_tokens = $3, output_tokens = $4, error = $5
            WHERE id = $1 RETURNING ${TURN_COLUMNS}`,
          [
            turnId,
            result.status,
            result.inputTokens ?? null,
            result.outputTokens ?? null,
            result.status === "failed"
              ? redactValue((result.error ?? "unknown error").slice(0, 4000))
              : null,
          ],
        );
        if (!rows[0]) throw new NotFoundError("turn");
        return toTurn(rows[0]);
      });
    },

    /** Closes turns left 'running' by a crash, so the one-turn-at-a-time rule does not lock a chat. */
    async failStaleTurns(userId: string, sessionId: string): Promise<number> {
      return db.withUser(userId, async (c) => {
        const { rowCount } = await c.query(
          `UPDATE session_turns SET status = 'failed', error = 'The agent restarted while this turn was running'
            WHERE session_id = $1 AND status = 'running'`,
          [sessionId],
        );
        return rowCount ?? 0;
      });
    },

    /** Secrets are removed before anything is written. */
    async appendEvent(
      userId: string,
      sessionId: string,
      event: {
        type: string;
        data?: Record<string, unknown>;
        turnId?: string | null;
        durationMs?: number | null;
      },
    ): Promise<StoredEvent> {
      try {
        return await db.withUser(userId, async (c) => {
          const { rows } = await c.query<RawEvent>(
            `INSERT INTO session_events (session_id, turn_id, type, data, duration_ms)
             VALUES ($1, $2, $3, $4, $5) RETURNING ${EVENT_COLUMNS}`,
            [
              sessionId,
              event.turnId ?? null,
              event.type,
              redactValue(event.data ?? {}),
              event.durationMs == null
                ? null
                : Math.max(0, Math.round(event.durationMs)),
            ],
          );
          return toEvent(rows[0]);
        });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "42501" || code === "23503") throw new NotFoundError();
        throw error;
      }
    },

    async listEvents(
      userId: string,
      sessionId: string,
      options: { afterSeq?: number; limit?: number } = {},
    ): Promise<StoredEvent[]> {
      const limit = Math.min(Math.max(options.limit ?? 1000, 1), 5000);
      return db.withUser(userId, async (c) => {
        const { rows } = await c.query<RawEvent>(
          `SELECT ${EVENT_COLUMNS} FROM session_events WHERE session_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
          [sessionId, options.afterSeq ?? 0, limit],
        );
        return rows.map(toEvent);
      });
    },

    async getUser(userId: string): Promise<UserRow | null> {
      return db.withUser(userId, async (c) => {
        const { rows } = await c.query<{
          id: string;
          login: string;
          name: string | null;
          is_demo: boolean;
        }>("SELECT id, login, name, is_demo FROM users WHERE id = $1", [
          userId,
        ]);
        const r = rows[0];
        return r
          ? { id: r.id, login: r.login, name: r.name, isDemo: r.is_demo }
          : null;
      });
    },

    /** Report apps the user connected in Connections, and which one gets the final report. */
    async getReportConnections(userId: string): Promise<{
      connections: ReportConnectionRow[];
      reportTo: string | null;
    }> {
      return db.withUser(userId, async (c) => {
        const { rows } = await c.query<{
          provider: string;
          workspace: string | null;
          channel_id: string;
          channel_name: string | null;
          connected_at: Date;
        }>(
          `SELECT provider, workspace, channel_id, channel_name, connected_at
             FROM report_connections WHERE user_id = $1`,
          [userId],
        );
        const setup = await c.query<{ report_to: string | null }>(
          "SELECT report_to FROM user_setup WHERE user_id = $1",
          [userId],
        );
        return {
          connections: rows.map((r) => ({
            provider: r.provider,
            workspace: r.workspace,
            channelId: r.channel_id,
            channelName: r.channel_name,
            connectedAt: r.connected_at,
          })),
          reportTo: setup.rows[0]?.report_to ?? null,
        };
      });
    },

    async getSetup(userId: string): Promise<SetupRow | null> {
      return db.withUser(userId, async (c) => {
        const { rows } = await c.query<{
          repo: string | null;
          repo_installation_id: string | null;
          orchestrator_model: string | null;
          subagent_model: string | null;
          sandbox: string | null;
          sandbox_checked_at: Date | null;
          sentry_org: string | null;
          sentry_project: string | null;
          sentry_connected_at: Date | null;
          triggers: string[];
        }>(
          `SELECT repo, repo_installation_id, orchestrator_model, subagent_model, sandbox, sandbox_checked_at,
                  sentry_org, sentry_project, sentry_connected_at, triggers
             FROM user_setup WHERE user_id = $1`,
          [userId],
        );
        const r = rows[0];
        return r
          ? {
              repo: r.repo,
              installationId:
                r.repo_installation_id === null
                  ? null
                  : Number(r.repo_installation_id),
              orchestrator: r.orchestrator_model,
              subagent: r.subagent_model,
              sandbox: r.sandbox,
              sandboxCheckedAt: r.sandbox_checked_at,
              sentry:
                r.sentry_org && r.sentry_project && r.sentry_connected_at
                  ? {
                      org: r.sentry_org,
                      project: r.sentry_project,
                      connectedAt: r.sentry_connected_at,
                    }
                  : null,
              triggers: r.triggers,
            }
          : null;
      });
    },

    /**
     * The user's pipeline runs, newest first, with how many match in total and per status.
     * Row-level security already limits rox_agent to this user's runs; the WHERE says it again.
     */
    async listRuns(userId: string, f: RunFilter): Promise<RunList> {
      return db.withUser(userId, async (c) => {
        const where = ["user_id = $1"];
        const args: unknown[] = [userId];
        const add = (sql: string, value: unknown) => {
          args.push(value);
          where.push(sql.replace("?", `$${args.length}`));
        };
        if (f.source) add("source = ?", f.source);
        if (f.trigger) add("trigger = ?", f.trigger);
        if (f.repo) add("repo = ?", f.repo);
        if (f.pr !== undefined) add("pr_number = ?", f.pr);
        if (f.since) add("started_at >= ?", f.since);
        if (f.until) add("started_at < ?", f.until);
        // The whole window, counted by result: a filtered question still sees everything that ran.
        const counted = await c.query<{
          result: RunResult;
          n: string;
          merged: string;
        }>(
          `SELECT ${RESULT_SQL} AS result, count(*) AS n,
                  count(*) FILTER (WHERE pr_merged_at IS NOT NULL) AS merged
             FROM runs WHERE ${where.join(" AND ")} GROUP BY 1`,
          [...args],
        );
        if (f.results?.length) add(`(${RESULT_SQL}) = ANY(?)`, f.results);
        const { rows } = await c.query<RawRun & { matching: string }>(
          `SELECT ${RUN_COLUMNS}, count(*) OVER () AS matching
             FROM runs WHERE ${where.join(" AND ")}
            ORDER BY started_at DESC LIMIT ${Math.min(50, Math.max(1, f.limit))}`,
          args,
        );
        const windowByResult: Partial<Record<RunResult, number>> = {};
        for (const r of counted.rows) windowByResult[r.result] = Number(r.n);
        return {
          windowTotal: counted.rows.reduce((a, r) => a + Number(r.n), 0),
          windowByResult,
          windowMerged: counted.rows.reduce((a, r) => a + Number(r.merged), 0),
          matching: Number(rows[0]?.matching ?? 0),
          runs: rows.map(toRun),
        };
      });
    },

    /** One run of this user, or null. */
    async getRun(userId: string, runId: string): Promise<RunRow | null> {
      return db.withUser(userId, async (c) => {
        const { rows } = await c.query<RawRun>(
          `SELECT ${RUN_COLUMNS} FROM runs WHERE user_id = $1 AND run_id = $2`,
          [userId, runId],
        );
        return rows[0] ? toRun(rows[0]) : null;
      });
    },

    /** The steps of one run after `afterSeq`, oldest first, at most `limit`, plus the last seq. */
    async listRunEvents(
      userId: string,
      runId: string,
      afterSeq: number,
      limit: number,
    ): Promise<RunEventRow[]> {
      return db.withUser(userId, async (c) => {
        const { rows } = await c.query<{
          seq: number;
          at: Date;
          step: string;
          kind: string;
          title: string;
          status: string | null;
          ms: number | null;
          attempt: number | null;
        }>(
          // Newest `limit` after the cursor, then put back in order.
          `SELECT * FROM (
             SELECT e.seq, e.at, e.step, e.kind, e.title, e.status, e.ms, e.attempt
               FROM run_events e JOIN runs r ON r.run_id = e.run_id
              WHERE r.user_id = $1 AND e.run_id = $2 AND e.seq > $3
              ORDER BY e.seq DESC LIMIT $4
           ) t ORDER BY seq`,
          [userId, runId, afterSeq, Math.min(200, Math.max(1, limit))],
        );
        return rows.map((r) => ({
          seq: r.seq,
          at: r.at,
          step: r.step,
          kind: r.kind,
          title: r.title,
          status: r.status,
          ms: r.ms,
          attempt: r.attempt,
        }));
      });
    },

    /** The user's limits and wishes, and what their runs cost since midnight UTC. */
    async getConfig(
      userId: string,
    ): Promise<{ config: AgentConfig; spentTodayUsd: number }> {
      return db.withUser(userId, async (c) => {
        const config = await c.query<ConfigRow>(
          `SELECT ${CONFIG_COLUMNS} FROM agent_config WHERE user_id = $1`,
          [userId],
        );
        const today = await c.query<TodayRow>(TODAY_SQL);
        // Chat turns and pipeline runs share the one day budget.
        const runs = await c.query<{ usd: string }>(RUNS_TODAY_SQL, [userId]);
        return {
          config: toConfig(config.rows[0]),
          spentTodayUsd:
            Number(runs.rows[0]?.usd ?? 0) +
            today.rows.reduce(
              (sum, r) =>
                sum + costUsd(r.model, Number(r.input), Number(r.output)),
              0,
            ),
        };
      });
    },

    /** The encrypted key only. Decrypting is the vault's job. */
    async getProviderKey(
      userId: string,
      provider: string,
    ): Promise<StoredKey | null> {
      return db.withUser(userId, async (c) => {
        const { rows } = await c.query<{
          iv: Buffer;
          ciphertext: Buffer;
          tag: Buffer;
          models: string[];
        }>(
          "SELECT iv, ciphertext, tag, models FROM provider_keys WHERE user_id = $1 AND provider = $2",
          [userId, provider],
        );
        return rows[0] ?? null;
      });
    },

    /** Which providers this user has saved a key for (no secrets). */
    async listKeyProviders(userId: string): Promise<string[]> {
      return db.withUser(userId, async (c) => {
        const { rows } = await c.query<{ provider: string }>(
          "SELECT provider FROM provider_keys WHERE user_id = $1",
          [userId],
        );
        return rows.map((r) => r.provider);
      });
    },
  };
}
