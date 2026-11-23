// The models Rox offers, shared by the browser and the server. The ids are the
// providers' own API ids.

export const PROVIDERS = {
  openai: { name: "OpenAI", keyHint: "sk-..." },
  anthropic: { name: "Anthropic", keyHint: "sk-ant-..." },
  google: { name: "Google Gemini", keyHint: "Gemini API key" },
} as const;

export type Provider = keyof typeof PROVIDERS;

export const MODELS = [
  { id: "gpt-6-sol", label: "GPT-6 Sol", provider: "openai" },
  { id: "gpt-6-luna", label: "GPT-6 Luna", provider: "openai" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini", provider: "openai" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", provider: "anthropic" },
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    provider: "anthropic",
  },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", provider: "anthropic" },
  { id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", provider: "google" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", provider: "google" },
] as const satisfies { id: string; label: string; provider: Provider }[];

export type ModelId = (typeof MODELS)[number]["id"];

export const findModel = (id: string | null | undefined) =>
  MODELS.find((model) => model.id === id);

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

export type SavedKey = { last4: string; models: string[] };

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

/** The bundled app that Quick Judge Mode works on. */
export const DEMO_REPO = "demo-app";
