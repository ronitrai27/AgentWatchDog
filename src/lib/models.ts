// The models Rox offers, shared by the browser and the server. The ids are the
// providers' own API ids.

export const PROVIDERS = {
  openai: { name: "OpenAI", envName: "OPENAI_API_KEY", keyHint: "sk-..." },
  anthropic: {
    name: "Anthropic",
    envName: "ANTHROPIC_API_KEY",
    keyHint: "sk-ant-...",
  },
  google: {
    name: "Google Gemini",
    envName: "GEMINI_API_KEY",
    keyHint: "Gemini API key",
  },
} as const;

export type Provider = keyof typeof PROVIDERS;

export const MODELS = [
  { id: "gpt-6-sol", label: "GPT-6 Sol", provider: "openai" },
  { id: "gpt-6-luna", label: "GPT-6 Luna", provider: "openai" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini", provider: "openai" },
  {
    id: "gpt-4.1-mini",
    label: "GPT-4.1 mini",
    provider: "openai",
    // The model the lab agent was built and proven with (Tests/). Cheap, no reasoning mode.
    tag: "Cheap",
    // Keys checked before this date never listed it, so they are not taken as refusing it.
    addedAt: "2026-11-27",
  },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", provider: "anthropic" },
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    provider: "anthropic",
  },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", provider: "anthropic" },
  { id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", provider: "google" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", provider: "google" },
] as const satisfies {
  id: string;
  label: string;
  provider: Provider;
  tag?: string;
  addedAt?: string;
}[];

export type ModelId = (typeof MODELS)[number]["id"];

export const findModel = (id: string | null | undefined) =>
  MODELS.find((model) => model.id === id);

/**
 * US dollars per million tokens, list prices read 2026-11-25, used for the budget caps. Where
 * sources differ the higher one is used, so a cap stops early rather than late.
 */
const PRICES: Partial<Record<ModelId, { input: number; output: number }>> = {
  "gpt-6-sol": { input: 2, output: 10 },
  "gpt-6-luna": { input: 0.1, output: 0.5 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  // The rate above 100,000 tokens; shorter prompts cost less.
  "claude-haiku-5-5": { input: 0.5, output: 2.5 },
  "gemini-3.8-flash": { input: 1.5, output: 7.5 },
};

/** A model without a known price (gemini-4-hydrogen, or any new one) counts as expensive. */
const UNKNOWN_PRICE = { input: 5, output: 25 };

export const priceOf = (modelId: string) =>
  PRICES[modelId as ModelId] ?? UNKNOWN_PRICE;

export function costUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = priceOf(modelId);
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/** Which providers a set of choices needs a key for. */
export function providersFor(
  orchestrator: ModelId | null,
  subagent: ModelId | null,
): Provider[] {
  const used = new Set(
    [orchestrator, subagent].map((id) => findModel(id)?.provider),
  );
  return (Object.keys(PROVIDERS) as Provider[]).filter((p) => used.has(p));
}

export type SavedKey = {
  last4: string;
  models: string[];
  /** When the provider accepted it, as an ISO date. */
  savedAt: string;
};

export type SetupState = {
  repo: string | null;
  orchestrator: ModelId | null;
  /** Every sub agent runs on this model. */
  subagent: ModelId | null;
  keys: Partial<Record<Provider, SavedKey>>;
  sandbox: "docker" | null;
};

/** Which required steps are finished. The single definition of "done". */
export function setupProgress(state: SetupState, isJudge: boolean) {
  const models =
    state.orchestrator !== null &&
    state.subagent !== null &&
    (isJudge ||
      providersFor(state.orchestrator, state.subagent).every(
        (provider) => state.keys[provider],
      ));
  return {
    signIn: true,
    repo: state.repo !== null,
    models,
    sandbox: state.sandbox !== null,
  };
}

export const isSetUp = (state: SetupState, isJudge: boolean) =>
  Object.values(setupProgress(state, isJudge)).every(Boolean);

/** The bundled app that Quick Judge Mode works on. */
export const DEMO_REPO = "demo-app";
