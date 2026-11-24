// How the chat screen is built from the agent's event log. Pure functions, no React, so the rules
// (which event becomes which part of a message) can be tested on their own.

/** One event as the agent service sends it. */
export type WireEvent = {
  seq: number;
  id: string;
  occurredAt: string;
  turnId: string | null;
  type: string;
  data: Record<string, unknown>;
  durationMs: number | null;
};

export type PlanItem = { text: string; status: "todo" | "doing" | "done" };

export type StepError = {
  kind: string;
  message: string;
  cause?: string;
  hint?: string;
};

export type Step = {
  callId: string;
  name: string;
  title: string;
  status: "running" | "done" | "error";
  summary?: string;
  /** What the tool returned, as the model read it (JSON text, or the error text). */
  output?: string;
  error?: StepError;
  durationMs?: number | null;
  at: string;
};

export type Block =
  | { kind: "thinking"; text: string; durationMs: number | null; live: boolean }
  | { kind: "text"; text: string; live: boolean; at: string }
  | { kind: "steps"; steps: Step[] }
  | { kind: "plan"; items: PlanItem[] }
  | { kind: "error"; message: string; hint?: string; errorKind: string }
  | { kind: "stopped" };

export type TurnStatus = "running" | "completed" | "failed" | "stopped";

export type ChatTurn = {
  key: string;
  /** The person's message. Null for the hidden greeting trigger. */
  user: { text: string; at: string; pending: boolean } | null;
  blocks: Block[];
  status: TurnStatus;
  startedAt: string | null;
  /** Time of the last event of the turn. */
  endedAt?: string;
};

export type ChatState = {
  events: WireEvent[];
  lastSeq: number;
  /** Words streaming right now, before they are written to the log. */
  live: { turnId: string; text: string; thinking: string } | null;
  /** A message just sent, shown at once until the log confirms it. */
  pending: { text: string; at: string } | null;
  runningTurnId: string | null;
  /** The stream has replayed the log and is now live. */
  ready: boolean;
  /** A short note such as "retrying in 2s". */
  note: string | null;
};

export const initialChat: ChatState = {
  events: [],
  lastSeq: 0,
  live: null,
  pending: null,
  runningTurnId: null,
  ready: false,
  note: null,
};

export type ChatAction =
  | { type: "event"; event: WireEvent }
  | {
      type: "delta";
      turnId: string;
      channel: "text" | "thinking";
      text: string;
    }
  | { type: "turn"; turnId: string; status: TurnStatus }
  | { type: "ready"; running: boolean }
  | { type: "note"; text: string }
  | { type: "sent"; text: string; at: string }
  | { type: "sendFailed" }
  | { type: "reset" };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "reset":
      return initialChat;
    case "event": {
      const { event } = action;
      if (event.seq <= state.lastSeq) return state; // already have it
      let live = state.live;
      if (live && event.turnId === live.turnId) {
        if (event.type === "assistant.message") live = { ...live, text: "" };
        if (event.type === "model.thinking") live = { ...live, thinking: "" };
      }
      return {
        ...state,
        events: [...state.events, event],
        lastSeq: event.seq,
        live,
        note: null,
        pending:
          event.type === "user.message" || event.type === "system.trigger"
            ? null
            : state.pending,
        runningTurnId:
          event.turnId &&
          (state.runningTurnId === "pending" ||
            (state.runningTurnId === null && state.ready))
            ? event.turnId
            : state.runningTurnId,
      };
    }
    case "delta": {
      const live =
        state.live?.turnId === action.turnId
          ? state.live
          : { turnId: action.turnId, text: "", thinking: "" };
      return {
        ...state,
        runningTurnId: state.runningTurnId ?? action.turnId,
        live:
          action.channel === "text"
            ? { ...live, text: live.text + action.text }
            : { ...live, thinking: live.thinking + action.text },
      };
    }
    case "turn":
      return action.status === "running"
        ? { ...state, runningTurnId: action.turnId }
        : {
            ...state,
            runningTurnId:
              state.runningTurnId === action.turnId
                ? null
                : state.runningTurnId,
            live: state.live?.turnId === action.turnId ? null : state.live,
            note: null,
          };
    case "ready": {
      const last = state.events[state.events.length - 1];
      return {
        ...state,
        ready: true,
        runningTurnId: action.running
          ? (last?.turnId ?? state.runningTurnId)
          : null,
      };
    }
    case "note":
      return { ...state, note: action.text };
    case "sendFailed":
      return {
        ...state,
        pending: null,
        runningTurnId:
          state.runningTurnId === "pending" ? null : state.runningTurnId,
      };
    case "sent":
      return {
        ...state,
        pending: { text: action.text, at: action.at },
        runningTurnId: state.runningTurnId ?? "pending",
      };
  }
}

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** The whole chat, grouped by turn, ready to draw. */
export function buildTurns(state: ChatState): ChatTurn[] {
  const turns: ChatTurn[] = [];
  const byKey = new Map<string, ChatTurn>();
  const stepByCall = new Map<string, Step>();

  const turnFor = (event: WireEvent): ChatTurn => {
    const key = event.turnId ?? `loose-${event.seq}`;
    let turn = byKey.get(key);
    if (!turn) {
      turn = {
        key,
        user: null,
        blocks: [],
        status: "completed",
        startedAt: event.occurredAt,
      };
      byKey.set(key, turn);
      turns.push(turn);
    }
    return turn;
  };

  for (const event of state.events) {
    const turn = turnFor(event);
    const d = event.data;
    turn.endedAt = event.occurredAt;
    switch (event.type) {
      case "user.message":
        turn.user = { text: str(d.text), at: event.occurredAt, pending: false };
        break;
      case "system.trigger":
        break; // the hidden greeting prompt: the person never wrote it
      case "model.thinking":
        turn.blocks.push({
          kind: "thinking",
          text: str(d.text),
          durationMs: event.durationMs,
          live: false,
        });
        break;
      case "assistant.message":
        turn.blocks.push({
          kind: "text",
          text: str(d.text),
          live: false,
          at: event.occurredAt,
        });
        break;
      case "tool.requested": {
        const step: Step = {
          callId: str(d.callId),
          name: str(d.name),
          title: str(d.title) || str(d.name),
          status: "running",
          at: event.occurredAt,
        };
        stepByCall.set(step.callId, step);
        const last = turn.blocks[turn.blocks.length - 1];
        if (last?.kind === "steps") last.steps.push(step);
        else turn.blocks.push({ kind: "steps", steps: [step] });
        break;
      }
      case "tool.completed": {
        const step = stepByCall.get(str(d.callId));
        if (!step) break;
        step.status = d.ok === true ? "done" : "error";
        step.summary = str(d.summary);
        step.output = str(d.output);
        step.durationMs = event.durationMs;
        if (d.ok !== true && d.error && typeof d.error === "object")
          step.error = d.error as StepError;
        break;
      }
      case "plan.updated": {
        const items = (Array.isArray(d.items) ? d.items : []) as PlanItem[];
        const existing = turn.blocks.find((b) => b.kind === "plan");
        if (existing && existing.kind === "plan") existing.items = items;
        else turn.blocks.push({ kind: "plan", items });
        break;
      }
      case "agent.error":
        turn.blocks.push({
          kind: "error",
          message: str(d.message),
          hint: str(d.hint) || undefined,
          errorKind: str(d.kind),
        });
        turn.status = "failed";
        break;
      case "agent.stopped":
        turn.blocks.push({ kind: "stopped" });
        turn.status = "stopped";
        break;
      default:
        break;
    }
  }

  // Words that are still arriving.
  const live = state.live;
  if (live && (live.text || live.thinking)) {
    const turn = byKey.get(live.turnId) ?? {
      key: live.turnId,
      user: null,
      blocks: [],
      status: "running" as TurnStatus,
      startedAt: null,
    };
    if (!byKey.has(live.turnId)) turns.push(turn);
    if (live.thinking)
      turn.blocks.push({
        kind: "thinking",
        text: live.thinking,
        durationMs: null,
        live: true,
      });
    if (live.text)
      turn.blocks.push({ kind: "text", text: live.text, live: true, at: "" });
  }

  // Which turn is running.
  const runningKey = state.runningTurnId;
  for (const turn of turns) {
    if (runningKey && turn.key === runningKey) turn.status = "running";
  }
  // A message sent a moment ago, before the log has it.
  if (state.pending) {
    turns.push({
      key: "pending",
      user: { text: state.pending.text, at: state.pending.at, pending: true },
      blocks: [],
      status: "running",
      startedAt: state.pending.at,
    });
  }
  // The running turn of a log that has not shown its first event yet.
  return turns;
}

export function isRunning(state: ChatState): boolean {
  return state.runningTurnId !== null;
}

/** "12s", "1m 05s", "340 ms". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** The connection list the greeting shows, read from what connections_list returned. */
export type Connection = {
  id: string;
  name: string;
  status: "connected" | "test_mode" | "not_connected";
  detail: string;
  gives?: string;
  canBeConnectedNow: boolean;
};

export function connectionsFrom(turn: ChatTurn): Connection[] | null {
  for (const block of turn.blocks) {
    if (block.kind !== "steps") continue;
    for (const step of block.steps) {
      if (step.name !== "connections_list" || step.status !== "done") continue;
      try {
        const parsed = JSON.parse(step.output ?? "") as {
          connections?: Connection[];
        };
        if (Array.isArray(parsed.connections)) return parsed.connections;
      } catch {
        return null;
      }
    }
  }
  return null;
}
