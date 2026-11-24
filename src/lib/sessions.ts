// Chat sessions, web side: create, list, rename, delete and read. Only the agent
// service writes events and turns (see agent/src/store). Reading uses the web role,
// which the database limits to the signed-in user's own chats.
//
// Every function takes the user id and runs inside withUser(), so the database
// itself refuses to show or change anyone else's sessions.
import { withUser } from "./db";
import { recordAudit } from "./users";

export type Session = {
  id: string;
  name: string;
  createdAt: Date;
  /** Last activity: a rename, an event, or a finished turn. */
  updatedAt: Date;
  lastEventAt: Date | null;
  eventCount: number;
  turnCount: number;
  /** Total agent execution time of finished turns, in milliseconds. */
  execMs: number;
};

export type SessionEvent = {
  seq: number;
  id: string;
  occurredAt: Date;
  turnId: string | null;
  type: string;
  data: Record<string, unknown>;
  durationMs: number | null;
};

export type TurnStatus = "running" | "completed" | "failed" | "stopped";

export type Turn = {
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

export class SessionNotFoundError extends Error {
  constructor() {
    super("session not found");
  }
}

type SessionRow = {
  id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
  last_event_at: Date | null;
  next_seq: string;
  turn_count: number;
  exec_ms: string;
};

const SESSION_COLUMNS =
  "id, name, created_at, updated_at, last_event_at, next_seq, turn_count, exec_ms";

const toSession = (row: SessionRow): Session => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastEventAt: row.last_event_at,
  eventCount: Number(row.next_seq) - 1,
  turnCount: row.turn_count,
  execMs: Number(row.exec_ms),
});

type EventRow = {
  seq: string;
  id: string;
  occurred_at: Date;
  turn_id: string | null;
  type: string;
  data: Record<string, unknown>;
  duration_ms: number | null;
};

const EVENT_COLUMNS = "seq, id, occurred_at, turn_id, type, data, duration_ms";

const toEvent = (row: EventRow): SessionEvent => ({
  seq: Number(row.seq),
  id: row.id,
  occurredAt: row.occurred_at,
  turnId: row.turn_id,
  type: row.type,
  data: row.data,
  durationMs: row.duration_ms,
});

type TurnRow = {
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

const toTurn = (row: TurnRow): Turn => ({
  id: row.id,
  n: row.n,
  status: row.status,
  model: row.model,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  durationMs: row.duration_ms,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  error: row.error,
});

const DEFAULT_NAME = "New chat";
const MAX_NAME = 120;

function cleanName(name: string | undefined): string {
  const trimmed = (name ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return trimmed || DEFAULT_NAME;
}

export async function createSession(
  userId: string,
  name?: string,
): Promise<Session> {
  const session = await withUser(userId, async (client) => {
    const { rows } = await client.query<SessionRow>(
      `INSERT INTO sessions (user_id, name) VALUES ($1, $2)
       RETURNING ${SESSION_COLUMNS}`,
      [userId, cleanName(name)],
    );
    return toSession(rows[0]);
  });
  await recordAudit({
    userId,
    actor: "web",
    type: "session.created",
    data: { sessionId: session.id },
  });
  return session;
}

/** Newest activity first. Pass `before` (an updatedAt) to get the next page. */
export async function listSessions(
  userId: string,
  options: { limit?: number; before?: Date } = {},
): Promise<Session[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  return withUser(userId, async (client) => {
    const { rows } = await client.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions
        WHERE ($1::timestamptz IS NULL OR updated_at < $1)
        ORDER BY updated_at DESC
        LIMIT $2`,
      [options.before ?? null, limit],
    );
    return rows.map(toSession);
  });
}

export async function getSession(
  userId: string,
  sessionId: string,
): Promise<Session | null> {
  return withUser(userId, async (client) => {
    const { rows } = await client.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = $1`,
      [sessionId],
    );
    return rows[0] ? toSession(rows[0]) : null;
  });
}

export async function renameSession(
  userId: string,
  sessionId: string,
  name: string,
): Promise<Session> {
  return withUser(userId, async (client) => {
    const { rows } = await client.query<SessionRow>(
      `UPDATE sessions SET name = $2 WHERE id = $1
       RETURNING ${SESSION_COLUMNS}`,
      [sessionId, cleanName(name)],
    );
    if (!rows[0]) throw new SessionNotFoundError();
    return toSession(rows[0]);
  });
}

/** Deletes the session with all its turns and events. Returns false if there was none. */
export async function deleteSession(
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const deleted = await withUser(userId, async (client) => {
    const { rowCount } = await client.query(
      "DELETE FROM sessions WHERE id = $1",
      [sessionId],
    );
    return (rowCount ?? 0) > 0;
  });
  if (deleted) {
    await recordAudit({
      userId,
      actor: "web",
      type: "session.deleted",
      data: { sessionId },
    });
  }
  return deleted;
}

/** Oldest first. Pass `afterSeq` to read only what is new since the last read. */
export async function listEvents(
  userId: string,
  sessionId: string,
  options: { afterSeq?: number; limit?: number; types?: string[] } = {},
): Promise<SessionEvent[]> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
  return withUser(userId, async (client) => {
    const { rows } = await client.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM session_events
        WHERE session_id = $1
          AND seq > $2
          AND ($3::text[] IS NULL OR type = ANY($3))
        ORDER BY seq
        LIMIT $4`,
      [sessionId, options.afterSeq ?? 0, options.types ?? null, limit],
    );
    return rows.map(toEvent);
  });
}

export function listMessages(
  userId: string,
  sessionId: string,
  options: { afterSeq?: number; limit?: number } = {},
) {
  return listEvents(userId, sessionId, {
    ...options,
    types: ["user.message", "assistant.message"],
  });
}

export async function listTurns(
  userId: string,
  sessionId: string,
): Promise<Turn[]> {
  return withUser(userId, async (client) => {
    const { rows } = await client.query<TurnRow>(
      `SELECT ${TURN_COLUMNS} FROM session_turns
        WHERE session_id = $1 ORDER BY n`,
      [sessionId],
    );
    return rows.map(toTurn);
  });
}
