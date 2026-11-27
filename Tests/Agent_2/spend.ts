// What the models may cost. Every call is priced from its real token usage and written to the
// trace, and the total is rebuilt from the trace after a crash, so a restart never resets it.
import { ChatOpenAI } from "@langchain/openai";
import { need } from "../src/env";
import { emit, readEvents } from "../src/events";

/** US dollars per million tokens. Only these models may be used in tests. */
const PRICES = {
  "gpt-4.1-mini": { in: 0.4, cached: 0.1, out: 1.6 },
  "gpt-4.1-nano": { in: 0.1, cached: 0.025, out: 0.4 },
} as const;
export type ModelName = keyof typeof PRICES;

export const RUN_LIMIT_USD = 0.06;

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
  private constructor(
    readonly run: string,
    readonly limit: number,
  ) {}

  /**
   * @param only Which steps count toward this budget. The security hunt (U4) has a budget of its
   *   own, so the fix agent and the hunt never spend each other's money.
   */
  static async load(
    run: string,
    limit = RUN_LIMIT_USD,
    only: (step: string) => boolean = (s) => !s.startsWith("hunt"),
  ): Promise<Spend> {
    const spend = new Spend(run, limit);
    for (const e of await readEvents(run))
      if (e.kind === "model.call" && only(e.step)) spend.add(e.data ?? {});
    return spend;
  }

  private add(d: Record<string, unknown>) {
    this.usd += Number(d.usd ?? 0);
    this.tokens += Number(d.in ?? 0) + Number(d.out ?? 0);
    this.calls++;
  }

  /** Called before every model call. */
  check() {
    if (this.usd >= this.limit)
      throw new BudgetError(
        `the run reached its model budget ($${this.usd.toFixed(4)} of $${this.limit})`,
      );
  }

  async record(step: string, model: ModelName, usage: Usage, ms: number) {
    const price = PRICES[model];
    const cached = usage.input_token_details?.cache_read ?? 0;
    const usd =
      ((usage.input_tokens - cached) * price.in +
        cached * price.cached +
        usage.output_tokens * price.out) /
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

export const model = (name: ModelName, maxTokens: number) =>
  new ChatOpenAI({
    model: name,
    apiKey: need("OPENAI_API_KEY"),
    temperature: 0,
    maxTokens,
    timeout: 45_000,
    maxRetries: 0, // modelRetryMiddleware decides, so every try is visible.
    // One tool call at a time: two edits of one file must never race.
    modelKwargs: { parallel_tool_calls: false },
  });
