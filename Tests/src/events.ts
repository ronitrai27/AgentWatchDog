// The trace of a run: one JSON line per event in Tests/runs/<run>/events.jsonl. The viewer
// streams this file, so the chat and the side sheet can show every step live.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { redactValue } from "../../agent/src/redact";
import { runDir } from "./env";

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

const fileOf = (run: string) => path.join(runDir(run), "events.jsonl");

async function lastSeq(run: string): Promise<number> {
  try {
    return (await readFile(fileOf(run), "utf8")).split("\n").filter(Boolean)
      .length;
  } catch {
    return 0;
  }
}

/** Writes one event. Events of one run are written in order, one at a time. */
export function emit(run: string, event: NewEvent): Promise<LabEvent> {
  const write = async () => {
    await mkdir(runDir(run), { recursive: true });
    if (!next.has(run)) next.set(run, (await lastSeq(run)) + 1);
    const seq = next.get(run) as number;
    next.set(run, seq + 1);
    const full: LabEvent = {
      run,
      seq,
      at: new Date().toISOString(),
      ...event,
      ...(event.data ? { data: redactValue(event.data) } : {}),
    };
    await appendFile(fileOf(run), `${JSON.stringify(full)}\n`);
    return full;
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
  try {
    return (await readFile(fileOf(run), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LabEvent)
      .filter((e) => e.seq > after);
  } catch {
    return [];
  }
}
