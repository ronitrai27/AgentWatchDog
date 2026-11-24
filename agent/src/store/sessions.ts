// The agent's side of the chat log: it is the only writer of events and turns. Every call
// names the user it acts for, and the database refuses anything outside that user's rows.
import {
  type AgentConfig,
  CONFIG_COLUMNS,
  type ConfigRow,
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

    async getSetup(userId: string): Promise<SetupRow | null> {
      return db.withUser(userId, async (c) => {
        const { rows } = await c.query<{
          repo: string | null;
          repo_installation_id: string | null;
          orchestrator_model: string | null;
          subagent_model: string | null;
          sandbox: string | null;
          sandbox_checked_at: Date | null;
        }>(
          `SELECT repo, repo_installation_id, orchestrator_model, subagent_model, sandbox, sandbox_checked_at
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
            }
          : null;
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
        return {
          config: toConfig(config.rows[0]),
          spentTodayUsd: today.rows.reduce(
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
