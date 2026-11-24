// What a turn writes to the chat log (persisted), and what it only streams to a watching
// browser (live). Both come from the graph's own stream; nothing here is made up.
import type { StoredEvent, TurnStatus } from "../store/sessions";

export const EVENT = {
  userMessage: "user.message",
  modelThinking: "model.thinking",
  assistantMessage: "assistant.message",
  toolRequested: "tool.requested",
  /** One model call finished: usage and timing. */
  modelResponse: "model.response",
  toolCompleted: "tool.completed",
  agentError: "agent.error",
  agentStopped: "agent.stopped",
} as const;

export type LiveEvent =
  | { kind: "event"; event: StoredEvent }
  | {
      kind: "delta";
      turnId: string;
      channel: "text" | "thinking";
      text: string;
    }
  | { kind: "turn"; turnId: string; status: TurnStatus };

export type Limits = {
  maxModelCalls: number;
  maxToolCalls: number;
  maxWallMs: number;
};

export const DEFAULT_LIMITS: Limits = {
  maxModelCalls: 15,
  maxToolCalls: 40,
  maxWallMs: 5 * 60_000,
};

/** A budget ran out. The message is shown to the user as it is. */
export class LimitReached extends Error {}
