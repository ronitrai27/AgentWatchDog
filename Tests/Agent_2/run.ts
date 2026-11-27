// Runs the graph for one run. The checkpoint of every finished node is written before the next one
// starts (durability "sync"), so calling this again with the same run continues after the last
// finished node, on any worker.
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { emit } from "../src/events";
import { type Decide, decide } from "./decisions";
import {
  AGENTS,
  type Agents,
  buildGraph,
  type FixContext,
  type FixState,
  type Publisher,
} from "./graph";
import { Spend } from "./spend";

export type FixResult = Pick<
  typeof FixState.State,
  "outcome" | "reason" | "attempts" | "findings" | "verdict" | "pr"
> & { usd: number; tokens: number; modelCalls: number; resumed: boolean };

export async function runFix(
  input: { run: string; workspaces: string[]; change?: string },
  deps: Pick<FixContext, "workspace" | "fresh">,
  options: {
    checkpointer: BaseCheckpointSaver;
    signal?: AbortSignal;
    publish?: Publisher;
    services?: FixContext["services"];
    agents?: Agents;
    /** Where the final report goes; without it, nowhere. */
    report?: FixContext["report"];
    repo?: string;
    /** The Decisions API; the proofs hand in a scripted stand-in. */
    decide?: Decide;
    /** Model budget of the run in US dollars. */
    limitUsd?: number;
  },
): Promise<FixResult> {
  const { run, workspaces } = input;
  const graph = buildGraph(options.checkpointer);
  const config = {
    configurable: { thread_id: run },
    context: {
      run,
      spend: await Spend.load(run, options.limitUsd),
      agents: options.agents ?? AGENTS,
      decide: options.decide ?? decide,
      report: options.report,
      repo: options.repo,
      publish: options.publish,
      services: options.services,
      ...deps,
    } satisfies FixContext,
    durability: "sync" as const,
    recursionLimit: 30,
    signal: options.signal,
  };
  const saved = await graph.getState({ configurable: { thread_id: run } });
  const resumed = saved.next.length > 0;
  const finished = !resumed && Boolean(saved.values?.outcome);
  if (resumed)
    await emit(run, {
      step: "agent",
      kind: "agent.resumed",
      title: `Continuing at ${saved.next.join(", ")} after a restart`,
    });
  if (!finished) {
    let t = Date.now();
    const stream = await graph.stream(
      resumed ? null : { workspaces, change: input.change ?? "" },
      {
        ...config,
        streamMode: "updates",
      },
    );
    for await (const update of stream)
      for (const node of Object.keys(update)) {
        await emit(run, {
          step: node,
          kind: "node.finished",
          title: `${node} finished`,
          ms: Date.now() - t,
        });
        t = Date.now();
      }
  }
  const { values } = await graph.getState({
    configurable: { thread_id: run },
  });
  const { spend } = config.context;
  return {
    outcome: values.outcome ?? null,
    reason: values.reason ?? "",
    attempts: values.attempts ?? [],
    findings: values.findings ?? null,
    verdict: values.verdict ?? null,
    pr: values.pr ?? null,
    usd: spend.usd,
    tokens: spend.tokens,
    modelCalls: spend.calls,
    resumed,
  };
}
