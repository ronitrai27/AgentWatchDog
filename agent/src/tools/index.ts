// All tools, collected. To add a tool: write it in the file for its group (or start a new file),
// and add it here.
import { ToolMessage } from "@langchain/core/messages";
import { type ToolRuntime, tool } from "@langchain/core/tools";
import type { Turn } from "../graph/graph";
import { connectionsList } from "./connections";
import { planUpdate } from "./plan";
import { repoInfo } from "./repo";
import { modelText, runTool } from "./run";
import { runsGet, runsQuery } from "./runs";
import { setupOverview } from "./setup";
import { type ToolDef, ToolError } from "./types";

// The brain's whole tool set. Each tool answers one kind of question in one call; the work
// (joins, counts, timeouts, errors) is in code, so the model only chooses and reads.
export const roxTools = [
  // connections: the apps around Rox and the triggers that wake it
  connectionsList,
  // runs: the pipeline's runs and their steps
  runsQuery,
  runsGet,
  // repo: the GitHub repository and its activity (read-only)
  repoInfo,
  // setup: what the user chose in the setup guide
  setupOverview,
  // plan: the plan or queue the user sees for a job with several steps
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
