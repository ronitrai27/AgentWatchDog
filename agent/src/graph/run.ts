// Runs one turn: streams the compiled graph and writes LangGraph's own stream to the chat log.
//   messages  words and reasoning as they arrive
//   updates   what each node finished with
//   tools     each tool, the moment it succeeds or fails
//   custom    what a tool itself reports (the plan)

import {
  type AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { checkInput } from "../guardrails/input";
import { redactText } from "../redact";
import type { TurnStatus } from "../store/sessions";
import { roxTools } from "../tools";
import type { ToolOutcome } from "../tools/types";
import { EVENT, LimitReached, type LiveEvent } from "./events";
import { type RoxGraph, type Turn, usageOf } from "./graph";
import { explainModelError } from "./llm";

export type TurnResult = {
  status: Exclude<TurnStatus, "running">;
  error?: string;
};

/** Splits a message into answer text and reasoning text, whatever the provider calls them. */
function blocksOf(message: BaseMessage): { text: string; thinking: string } {
  let text = "";
  let thinking = "";
  for (const block of message.contentBlocks ?? []) {
    if (block.type === "text") text += (block as { text: string }).text;
    else if (block.type === "reasoning")
      thinking += (block as { reasoning?: string }).reasoning ?? "";
  }
  return { text, thinking };
}

/** A message the input guardrail stopped. */
class InputBlocked extends Error {}

export async function runTurn(
  graph: RoxGraph,
  turn: Turn,
  run: {
    text: string;
    /** Aborted when the user presses stop. */
    signal: AbortSignal;
    live: (event: LiveEvent) => void;
  },
): Promise<TurnResult> {
  const { userId, sessionId, turnId, store, limits } = turn;
  const { live } = run;
  const record = async (
    type: string,
    data: Record<string, unknown>,
    durationMs?: number,
  ) => {
    const event = await store.appendEvent(userId, sessionId, {
      type,
      data,
      turnId,
      durationMs,
    });
    live({ kind: "event", event });
  };

  const timeLimit = AbortSignal.timeout(limits.maxWallMs);
  let since = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let cutOff = false;
  const requested = new Map<string, string>();
  const completed = new Set<string>();
  const thread = { configurable: { thread_id: sessionId } };

  const recordReply = async (reply: AIMessage) => {
    const ms = Date.now() - since;
    const { text, thinking } = blocksOf(reply);
    if (thinking) await record(EVENT.modelThinking, { text: thinking }, ms);
    if (text) await record(EVENT.assistantMessage, { text });
    for (const call of reply.tool_calls ?? []) {
      if (call.id) requested.set(call.id, call.name);
      const def = roxTools.find((t) => t.name === call.name);
      const parsed = def?.input.safeParse(call.args);
      await record(EVENT.toolRequested, {
        callId: call.id,
        name: call.name,
        title: def && parsed?.success ? def.title(parsed.data) : call.name,
        risk: def?.risk ?? "unknown",
        input: call.args,
      });
    }
    const usage = usageOf(reply);
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    await record(EVENT.modelResponse, { model: turn.modelId, usage }, ms);
    const meta = reply.response_metadata as Record<string, unknown>;
    cutOff =
      !reply.tool_calls?.length &&
      /length|max_tokens/i.test(
        String(meta?.finish_reason ?? meta?.stop_reason ?? ""),
      );
  };

  const recordTool = async (message: ToolMessage) => {
    if (completed.has(message.tool_call_id)) return;
    completed.add(message.tool_call_id);
    const outcome = message.artifact as ToolOutcome | undefined;
    const output = redactText(String(message.content));
    const ok = message.status !== "error";
    const error =
      outcome && !outcome.ok
        ? outcome.error
        : { kind: "invalid_input", message: output };
    await record(
      EVENT.toolCompleted,
      {
        callId: message.tool_call_id,
        name: message.name,
        ok,
        summary: ok ? (outcome?.ok ? outcome.summary : "") : error.message,
        output,
        ...(ok ? {} : { error }),
      },
      outcome?.durationMs,
    );
  };

  /**
   * A run that ends early drops what was still queued in its stream. Every tool that was shown as
   * started gets its real ending: the saved result if there is one, otherwise "stopped".
   */
  const settleTools = async () => {
    const { values } = await graph.getState(thread);
    for (const m of (values.messages ?? []) as BaseMessage[])
      if (ToolMessage.isInstance(m) && requested.has(m.tool_call_id))
        await recordTool(m);
    for (const [id, name] of requested) {
      const error = {
        kind: "aborted" as const,
        message: "Stopped before it finished",
        retryable: false,
      };
      const outcome: ToolOutcome = { ok: false, durationMs: 0, error };
      await recordTool(
        new ToolMessage({
          content: error.message,
          artifact: outcome,
          status: "error",
          name,
          tool_call_id: id,
        }),
      );
    }
  };

  let result: TurnResult = { status: "completed" };
  const fail = async (error: {
    message: string;
    kind: string;
    hint?: string;
  }) => {
    const message = redactText(error.message);
    result = { status: "failed", error: message };
    await record(EVENT.agentError, {
      message,
      kind: error.kind,
      ...(error.hint ? { hint: error.hint } : {}),
    });
  };

  try {
    await record(EVENT.userMessage, { text: run.text });
    // The input guardrail, shown as a step: a blocked message never reaches the model.
    const guardCall = `guard-${turnId}`;
    await record(EVENT.toolRequested, {
      callId: guardCall,
      name: "guard_input",
      title: "Check the message for prompt injection",
      risk: "read",
      input: {},
    });
    const verdict = await checkInput(run.text, run.signal);
    await record(
      EVENT.toolCompleted,
      {
        callId: guardCall,
        name: "guard_input",
        ok: !verdict.blocked,
        summary: verdict.blocked
          ? `Blocked: ${verdict.reason}`
          : verdict.decisionError
            ? `Passed the pattern check; the decision model was not used (${verdict.decisionError})`
            : `Safe (injection ${Math.round((verdict.probability ?? 0) * 100)}%)`,
        output: JSON.stringify(verdict),
        ...(verdict.blocked
          ? { error: { kind: "blocked", message: verdict.reason } }
          : {}),
      },
      verdict.ms,
    );
    if (verdict.blocked)
      throw new InputBlocked(
        `Blocked by the input guardrail: ${verdict.reason}. The message was not sent to the model.`,
      );
    const stream = await graph.stream(
      // The model's memory is saved too, so a pasted key must not reach it.
      { messages: [new HumanMessage(redactText(run.text))] },
      {
        streamMode: ["messages", "updates", "tools", "custom"],
        context: { turn },
        ...thread,
        recursionLimit: limits.maxModelCalls * 2 + 5,
        signal: AbortSignal.any([run.signal, timeLimit]),
      },
    );
    for await (const [mode, chunk] of stream) {
      if (mode === "messages") {
        const [message, meta] = chunk;
        if (meta.langgraph_node !== "model") continue;
        const { text, thinking } = blocksOf(message);
        if (thinking)
          live({ kind: "delta", turnId, channel: "thinking", text: thinking });
        if (text) live({ kind: "delta", turnId, channel: "text", text });
      } else if (mode === "updates") {
        const update = chunk as Record<
          string,
          { messages?: BaseMessage[] } | undefined
        >;
        for (const m of update.model?.messages ?? [])
          await recordReply(m as AIMessage);
        for (const m of update.tools?.messages ?? [])
          await recordTool(m as ToolMessage);
        since = Date.now();
      } else if (mode === "tools") {
        if (
          chunk.event === "on_tool_end" &&
          ToolMessage.isInstance(chunk.output)
        )
          await recordTool(chunk.output);
      } else {
        const event = chunk as { type: string; data: Record<string, unknown> };
        await record(event.type, event.data);
      }
    }
    if (run.signal.aborted || timeLimit.aborted) throw new Error("aborted");
    if (cutOff)
      await fail({
        message:
          "The answer was cut off because it reached the length limit. Ask for a shorter answer, or continue with a follow-up message.",
        kind: "max_tokens",
      });
  } catch (error) {
    try {
      await settleTools();
      if (run.signal.aborted) {
        result = { status: "stopped" };
        await record(EVENT.agentStopped, { reason: "user" });
      } else if (timeLimit.aborted) {
        await fail({
          message: `Stopped after ${Math.round(limits.maxWallMs / 1000)} seconds, the time limit for one run. Raise it in Settings > Agent, or break the job into smaller steps.`,
          kind: "limit",
        });
      } else if (error instanceof InputBlocked) {
        await fail({
          message: error.message,
          kind: "guardrail",
          hint: "Rephrase it as an ordinary request. Rox never ignores its rules or reveals secrets.",
        });
      } else if (error instanceof LimitReached) {
        await fail({ message: error.message, kind: "limit" });
      } else {
        await fail(explainModelError(error));
      }
    } catch {
      // the log itself is down; the turn still has to be closed below
      if (result.status === "completed")
        result = { status: "failed", error: "The chat log is not available" };
    }
  }

  try {
    await store.finishTurn(userId, turnId, {
      ...result,
      inputTokens,
      outputTokens,
    });
  } catch {
    // the turn stays 'running' and is closed by failStaleTurns on the next start
  }
  live({ kind: "turn", turnId, status: result.status });
  return result;
}
