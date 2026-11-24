// Live check of Rox's graph against a real model, without a database.
//
//   $env:OPENAI_API_KEY = "sk-..."; pnpm --dir agent run smoke
//   $env:SMOKE_MODEL = "claude-sonnet-5-5"; $env:ANTHROPIC_API_KEY = "..."; pnpm --dir agent run smoke
//
// It runs the real graph with the real tool loop (setup, sandbox, connections and plan tools
// answer from fake data; GitHub is off) and prints what the screen would show.
import { MemorySaver } from "@langchain/langgraph";
import "./config";
import { DEFAULT_LIMITS } from "./graph/events";
import { buildRoxGraph } from "./graph/graph";
import { createChatModel, type Provider, providerForModel } from "./graph/llm";
import { runTurn } from "./graph/run";
import { fakeDocker, fakeStore, USER_ID } from "./tools/fakes";

const KEYS: Record<Provider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
};
const DEFAULTS: Record<Provider, string> = {
  openai: "gpt-6-luna",
  anthropic: "claude-sonnet-5-5",
  google: "gemini-3.8-flash",
};

const modelId =
  process.env.SMOKE_MODEL ??
  (Object.keys(KEYS) as Provider[])
    .filter((p) => process.env[KEYS[p]])
    .map((p) => DEFAULTS[p])[0];
if (!modelId) {
  console.error(
    "Set OPENAI_API_KEY, ANTHROPIC_API_KEY or GOOGLE_API_KEY (and optionally SMOKE_MODEL).",
  );
  process.exit(1);
}
const provider = providerForModel(modelId);
if (!provider || !process.env[KEYS[provider]]) {
  console.error(
    `No key for ${modelId}: set ${provider ? KEYS[provider] : "a key"}.`,
  );
  process.exit(1);
}

async function main() {
  const events: { seq: number; type: string; data: Record<string, unknown> }[] =
    [];
  const store = {
    ...fakeStore(),
    appendEvent: async (
      _u: string,
      _s: string,
      e: { type: string; data?: Record<string, unknown> },
    ) => {
      const event = {
        seq: events.length + 1,
        id: String(events.length + 1),
        occurredAt: new Date(),
        turnId: "t",
        type: e.type,
        data: e.data ?? {},
        durationMs: null,
      };
      events.push(event);
      return event;
    },
    finishTurn: async () => ({}),
  };

  const model = createChatModel(
    modelId as string,
    process.env[KEYS[provider as Provider]] as string,
    {
      maxOutputTokens: 2000,
    },
  );
  let streamed = "";
  let thought = "";
  const result = await runTurn(
    buildRoxGraph(new MemorySaver()),
    {
      userId: USER_ID,
      sessionId: "smoke",
      turnId: "smoke-turn",
      store: store as never,
      github: null,
      docker: fakeDocker(),
      model,
      limits: { ...DEFAULT_LIMITS, maxWallMs: 90_000 },
      modelCalls: 0,
      toolCalls: 0,
      modelId: modelId as string,
      outputCap: 500,
      spentUsd: 0,
      pendingUsd: 0,
      reserve: async () => ({ ok: true, leftUsd: 1 }),
      config: { tone: "strict", instructions: "" },
    },
    {
      text: "Use setup_get and sandbox_check, then tell me in two sentences what my setup is.",
      signal: new AbortController().signal,
      live: (e) => {
        if (e.kind === "delta" && e.channel === "text") streamed += e.text;
        if (e.kind === "delta" && e.channel === "thinking") thought += e.text;
      },
    },
  );

  console.log(`model: ${modelId} (${provider})`);
  console.log(
    `status: ${result.status}${result.error ? ` - ${result.error}` : ""}`,
  );
  console.log(
    `reasoning streamed: ${thought ? `yes (${thought.length} chars)` : "no"}`,
  );
  for (const e of events) {
    const d = e.data;
    if (e.type === "tool.requested")
      console.log(`  tool  ${d.name}  ${d.title}`);
    else if (e.type === "tool.completed")
      console.log(
        `  ${d.ok ? "ok   " : "FAIL "} ${d.name}  ${String(d.summary).slice(0, 80)}`,
      );
    else if (e.type === "agent.error") console.log(`  ERROR ${d.message}`);
  }
  console.log(`answer: ${streamed.trim()}`);
  process.exit(result.status === "completed" ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
