// The trace of a run: one row per event in run_events (Rox's database), in order. Every insert is
// announced on the "run_events" channel (see migration 0014), so the web can stream it live.
// Model calls also add their tokens and cost to the run as they happen.
import { redactValue } from "../../agent/src/redact";
import { db } from "./db";

export type Status =
  | "running"
  | "pass"
  | "fail"
  | "skipped"
  | "error"
  | "cancelled";

export type LabEvent = {
  run: string;
  seq: number;
  /** ISO time the event was written. */
  at: string;
  /** Which step it belongs to: prepare, install, a check id, or run. */
  step: string;
  kind: string;
  title: string;
  status?: Status;
  ms?: number;
  /** The Temporal attempt, when a step was retried after a crash. */
  attempt?: number;
  data?: Record<string, unknown>;
};

export type NewEvent = Omit<LabEvent, "run" | "seq" | "at">;

const next = new Map<string, number>();
const queues = new Map<string, Promise<unknown>>();

/**
 * The run's row, so its events have somewhere to belong. startRun (runs.ts) fills in who started
 * it and why; a run started without it (a seeded lab case) still gets a row.
 */
async function ensureRun(run: string) {
  if (next.has(run)) return;
  const { rows } = await db().query<{ last_seq: number }>(
    `INSERT INTO runs (run_id, workflow_id, source, invoked_by)
     VALUES ($1, $1, 'cli', 'cli')
     ON CONFLICT (run_id) DO UPDATE SET run_id = EXCLUDED.run_id
     RETURNING last_seq`,
    [run],
  );
  next.set(run, (rows[0]?.last_seq ?? 0) + 1);
}

const UNIQUE_VIOLATION = "23505";

/** Writes one event. Events of one run are written in order, one at a time. */
export function emit(run: string, event: NewEvent): Promise<LabEvent> {
  const write = async (): Promise<LabEvent> => {
    await ensureRun(run);
    const data = event.data
      ? (redactValue(event.data) as Record<string, unknown>)
      : undefined;
    for (let tries = 0; ; tries++) {
      const seq = next.get(run) as number;
      try {
        const { rows } = await db().query<{ at: Date }>(
          `WITH e AS (
             INSERT INTO run_events (run_id, seq, step, kind, title, status, ms, attempt, data)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING at
           ), r AS (
             UPDATE runs SET
               last_seq = greatest(last_seq, $2),
               model_calls = model_calls + CASE WHEN $4 = 'model.call' THEN 1 ELSE 0 END,
               tokens_in  = tokens_in  + CASE WHEN $4 = 'model.call' THEN coalesce(($9::jsonb ->> 'in')::bigint, 0) ELSE 0 END,
               tokens_out = tokens_out + CASE WHEN $4 = 'model.call' THEN coalesce(($9::jsonb ->> 'out')::bigint, 0) ELSE 0 END,
               cost_usd   = cost_usd   + CASE WHEN $4 = 'model.call' THEN coalesce(($9::jsonb ->> 'usd')::numeric, 0) ELSE 0 END
             WHERE run_id = $1
           )
           SELECT at FROM e`,
          [
            run,
            seq,
            event.step,
            event.kind,
            event.title,
            event.status ?? null,
            event.ms === undefined ? null : Math.round(event.ms),
            event.attempt ?? null,
            data ? JSON.stringify(data) : null,
          ],
        );
        next.set(run, seq + 1);
        return {
          run,
          seq,
          at: (rows[0]?.at ?? new Date()).toISOString(),
          ...event,
          ...(data ? { data } : {}),
        };
      } catch (error) {
        // Another worker wrote this seq (a retried step on another machine): catch up and retry.
        if ((error as { code?: string }).code !== UNIQUE_VIOLATION || tries > 5)
          throw error;
        next.delete(run);
        await ensureRun(run);
      }
    }
  };
  const queued = (queues.get(run) ?? Promise.resolve()).then(write, write);
  queues.set(
    run,
    queued.catch(() => {}),
  );
  return queued;
}

/** Every event of a run after `after`, in order. */
export async function readEvents(run: string, after = 0): Promise<LabEvent[]> {
  const { rows } = await db().query<{
    seq: number;
    at: Date;
    step: string;
    kind: string;
    title: string;
    status: Status | null;
    ms: number | null;
    attempt: number | null;
    data: Record<string, unknown> | null;
  }>(
    `SELECT seq, at, step, kind, title, status, ms, attempt, data
       FROM run_events WHERE run_id = $1 AND seq > $2 ORDER BY seq`,
    [run, after],
  );
  return rows.map((r) => ({
    run,
    seq: r.seq,
    at: r.at.toISOString(),
    step: r.step,
    kind: r.kind,
    title: r.title,
    ...(r.status ? { status: r.status } : {}),
    ...(r.ms !== null ? { ms: r.ms } : {}),
    ...(r.attempt !== null ? { attempt: r.attempt } : {}),
    ...(r.data ? { data: r.data } : {}),
  }));
}
