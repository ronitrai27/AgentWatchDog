// What the models may cost, and which model runs. Both come from the user's settings for every run:
// the sub-agent model chosen in the setup guide (with their own key), and what is left of their
// day budget (Settings > Agent). Every call is priced from its real token usage and written to the
// trace, and the total is rebuilt from the trace after a crash, so a restart never resets it.
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import { priceOf } from "../../src/lib/models";
import { emit, readEvents } from "../src/events";
import type { Decide } from "./decisions";

/** The run's model, built in the worker from the user's saved key. Never passed through Temporal. */
export type RunModels = {
  /** The provider's model id, e.g. "gpt-6-luna". */
  modelId: string;
  /** A fresh chat model with this output limit. */
  llm: (maxTokens: number) => BaseChatModel;
  /** The Decisions API (always gpt-6-luna). */
  decide: Decide;
};

export class BudgetError extends Error {}

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  input_token_details?: { cache_read?: number };
};

export class Spend {
  usd = 0;
  calls = 0;
  tokens = 0;
  /** What this budget had already spent when it was loaded (rebuilt from the trace). */
  private atLoad = 0;
  private constructor(
    readonly run: string,
    /** What was left of the user's day budget when this was loaded. */
    readonly limit: number,
    readonly models: RunModels,
  ) {}

  get modelId() {
    return this.models.modelId;
  }

  /** The model for one call: the run's model, never one chosen in code. */
  llm(maxTokens: number) {
    return this.models.llm(maxTokens);
  }

  /**
   * @param leftUsd What is left of the user's day budget now (chat and every run of the day).
   * @param only Which steps count toward this budget. The security hunt keeps its own count, so
   *   the fix agent and the hunt never spend each other's share of what is left.
   */
  static async load(
    run: string,
    leftUsd: number,
    models: RunModels,
    only: (step: string) => boolean = (s) => !s.startsWith("hunt"),
  ): Promise<Spend> {
    const spend = new Spend(run, leftUsd, models);
    for (const e of await readEvents(run))
      if (e.kind === "model.call" && only(e.step)) spend.add(e.data ?? {});
    spend.atLoad = spend.usd;
    return spend;
  }

  private add(d: Record<string, unknown>) {
    this.usd += Number(d.usd ?? 0);
    this.tokens += Number(d.in ?? 0) + Number(d.out ?? 0);
    this.calls++;
  }

  /** Called before every model call. */
  check() {
    if (this.usd - this.atLoad >= this.limit)
      throw new BudgetError(
        `the day budget is used up ($${this.limit.toFixed(4)} was left when this step started; Settings > Agent)`,
      );
  }

  async record(step: string, usage: Usage, ms: number) {
    const model = this.modelId;
    const price = priceOf(model);
    const cached = usage.input_token_details?.cache_read ?? 0;
    // Cached input is priced as full input: the cap stops early rather than late.
    const usd =
      (usage.input_tokens * price.input + usage.output_tokens * price.output) /
      1e6;
    const data = {
      model,
      in: usage.input_tokens,
      cached,
      out: usage.output_tokens,
      usd: Number(usd.toFixed(6)),
    };
    this.add(data);
    await emit(this.run, {
      step,
      kind: "model.call",
      title: `${model}: ${data.in} in (${cached} cached), ${data.out} out`,
      ms,
      data,
    });
  }
}

/**
 * Stands in for the model when an agent is built. It is never called: the Ledger middleware
 * swaps in the run's own model (Spend.llm) before every call.
 */
export const placeholder = () =>
  new ChatOpenAI({ model: "set-per-run", apiKey: "set-per-run" });
