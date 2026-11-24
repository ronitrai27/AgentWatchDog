// All tools, collected. To add a tool: write it in the file for its group (or start a new file),
// and add it here.
import { ToolMessage } from "@langchain/core/messages";
import { type ToolRuntime, tool } from "@langchain/core/tools";
import type { Turn } from "../graph/graph";
import { connectionsList } from "./connections";
import { planUpdate } from "./plan";
import { repoDetectProject, repoOverview } from "./repo";
import { modelText, runTool } from "./run";
import { sandboxCheck } from "./sandbox";
import { setupGet } from "./setup";
import { type ToolDef, ToolError } from "./types";

export const roxTools = [
  // setup: what the user chose
  setupGet,
  // repo: the GitHub repository (read-only)
  repoOverview,
  repoDetectProject,
  // sandbox: where code runs
  sandboxCheck,
  // connections: the apps around Rox
  connectionsList,
  // plan: the agent's own to-do list
  planUpdate,
] as ToolDef[];

const overLimit = (limit: number) => async () => {
  throw new ToolError(
    "unavailable",
    `The limit of ${limit} tool calls in one turn was reached.`,
    { hint: "Answer with what you have, and say what is missing." },
  );
};

/** The same tools as LangChain tools, for bindTools and LangGraph's ToolNode. */
export const langchainTools = roxTools.map((def) =>
  tool(
    async (input: unknown, runtime: ToolRuntime) => {
      const { turn } = runtime.context as unknown as { turn: Turn };
      const max = turn.limits.maxToolCalls;
      const allowed = ++turn.toolCalls <= max;
      const outcome = await runTool(
        allowed ? def : { ...def, run: overLimit(max) },
        input,
        {
          ...turn,
          signal: runtime.signal ?? new AbortController().signal,
          emit: async (event) => runtime.writer?.(event),
        },
      );
      return new ToolMessage({
        content: modelText(outcome),
        artifact: outcome,
        status: outcome.ok ? "success" : "error",
        name: def.name,
        tool_call_id: runtime.toolCallId,
      });
    },
    {
      name: def.name,
      description: def.description,
      schema: def.input as never,
    },
  ),
);

export { modelText, runTool } from "./run";
export * from "./types";
