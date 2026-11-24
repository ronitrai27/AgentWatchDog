// Rox's graph. Compiled once, when the server starts:
//
//   START -> sanitize -> model --(asked for tools)--> tools -> model ...
//                           \--(answered)--> END
//
// Everything that belongs to one turn (the user, their model, the limits) arrives as LangGraph
// run context, so the same compiled graph serves every chat.
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { type AIMessage, SystemMessage } from "@langchain/core/messages";
import {
  type BaseCheckpointSaver,
  END,
  MessagesValue,
  type Runtime,
  START,
  StateGraph,
  StateSchema,
} from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import type { AgentConfig } from "../../../src/lib/agent-config";
import { costUsd } from "../../../src/lib/models";
import { langchainTools } from "../tools";
import type { ToolServices } from "../tools/types";
import { LimitReached, type Limits } from "./events";
import { sanitize } from "./nodes/sanitize";
import { buildSystemPrompt } from "./prompt";

export const RoxState = new StateSchema({ messages: MessagesValue });
export type RoxStateType = typeof RoxState.State;

/** What one turn brings with it. */
export type Turn = ToolServices & {
  /** The model the user chose, already connected with their key. */
  model: BaseChatModel;
  modelId: string;
  /** The longest answer the model was told it may give, in tokens. */
  outputCap: number;
  config: Pick<AgentConfig, "tone" | "instructions">;
  limits: Limits;
  spentUsd: number;
  /** What the model call being made right now could cost at most. */
  pendingUsd: number;
  /** Holds money for one model call, if the day's budget still has it. */
  reserve: (usd: number) => Promise<{ ok: boolean; leftUsd: number }>;
  modelCalls: number;
  toolCalls: number;
};

/** Tokens one reply used. Reasoning that a provider counts separately is billed as output. */
export function usageOf(reply: AIMessage) {
  const u = reply.usage_metadata;
  const input = u?.input_tokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: Math.max(
      u?.output_tokens ?? 0,
      (u?.total_tokens ?? 0) - input,
    ),
  };
}

/** Instructions and tool definitions, plus some room. */
const FIXED_INPUT_TOKENS = 3_000;

const RoxContext = z.object({ turn: z.custom<Turn>() });

async function model(
  state: RoxStateType,
  runtime: Runtime<z.infer<typeof RoxContext>>,
) {
  const turn = runtime.context?.turn as Turn;
  if (++turn.modelCalls > turn.limits.maxModelCalls)
    throw new LimitReached(
      `Stopped after ${turn.limits.maxModelCalls} model calls in one turn. Ask again, or break the job into smaller steps.`,
    );
  // The cap is hard: the most this call could cost must still fit, or it is not made.
  const worst = costUsd(
    turn.modelId,
    JSON.stringify(state.messages).length / 3 + FIXED_INPUT_TOKENS,
    turn.outputCap,
  );
  const { ok, leftUsd } = await turn.reserve(worst);
  if (!ok)
    throw new LimitReached(
      `Stopped by the budget: about $${Math.max(0, leftUsd).toFixed(2)} is left for today, and the next step could pass it. Raise it in Settings > Agent, or wait until midnight UTC.`,
    );
  const llm = turn.model.bindTools?.(langchainTools) ?? turn.model;
  const system = buildSystemPrompt({
    today: new Date().toISOString().slice(0, 10),
    ...turn.config,
  });
  try {
    const reply = await llm.invoke(
      [new SystemMessage(system), ...state.messages],
      { signal: runtime.signal },
    );
    const used = usageOf(reply as AIMessage);
    // A provider that reports no usage is counted at the most it could have cost.
    turn.spentUsd +=
      used.inputTokens + used.outputTokens > 0
        ? costUsd(turn.modelId, used.inputTokens, used.outputTokens)
        : worst;
    return { messages: [reply] };
  } finally {
    turn.pendingUsd = 0;
  }
}

export function buildRoxGraph(checkpointer: BaseCheckpointSaver) {
  return new StateGraph(RoxState, RoxContext)
    .addNode("sanitize", sanitize)
    .addNode("model", model)
    .addNode("tools", new ToolNode(langchainTools))
    .addEdge(START, "sanitize")
    .addEdge("sanitize", "model")
    .addConditionalEdges("model", toolsCondition, ["tools", END])
    .addEdge("tools", "model")
    .compile({ checkpointer });
}

export type RoxGraph = ReturnType<typeof buildRoxGraph>;
