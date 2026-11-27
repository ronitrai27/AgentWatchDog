// What the user chose, read fresh for every run: the sub-agent model (setup guide) with their own
// key, the day budget, the time limit and the PR action (Settings > Agent). Nothing here has a
// default model: a run without a chosen model stops and says so.
//
// Read as rox_agent (the only role that may read the encrypted keys), one user per transaction.
import { ChatOpenAI } from "@langchain/openai";
import { agentDatabaseUrl } from "../../agent/src/config";
import { createDb } from "../../agent/src/db";
import { createChatModel, providerForModel } from "../../agent/src/graph/llm";
import { createStore } from "../../agent/src/store/sessions";
import { decryptSecret } from "../../agent/src/vault";
import type { PrAction } from "../../src/lib/agent-config";
import { PROVIDERS } from "../../src/lib/models";
import { decisionsFor } from "../agent/decisions";
import type { RunModels } from "../agent/spend";
import { need } from "./env";

let shared: ReturnType<typeof createStore> | null = null;
const store = () => {
  shared ??= createStore(createDb(agentDatabaseUrl()));
  return shared;
};

/** Plain settings for the workflow (Temporal records them, so no key is ever in here). */
export type RunSettings = {
  userId: string;
  modelId: string;
  dayBudgetUsd: number;
  maxMinutes: number;
  prAction: PrAction;
};

export class SettingsError extends Error {}

export async function runSettings(
  userId: string | null | undefined,
): Promise<RunSettings> {
  if (!userId)
    throw new SettingsError(
      "This run has no Rox user, so Rox does not know which model, budget and time limit to use.",
    );
  const s = store();
  const [setup, { config }] = await Promise.all([
    s.getSetup(userId),
    s.getConfig(userId),
  ]);
  // The pipeline's agents are the sub agents (investigator, engineer, reviewer).
  const modelId = setup?.subagent ?? setup?.orchestrator ?? null;
  if (!modelId)
    throw new SettingsError(
      "No model is chosen. Choose the sub-agent model in the setup guide (Models step).",
    );
  return {
    userId,
    modelId,
    dayBudgetUsd: config.dayBudgetUsd,
    maxMinutes: config.maxMinutes,
    prAction: config.prAction,
  };
}

/** What is left of the user's day budget now: chat turns and every pipeline run of the day. */
export async function dayLeftUsd(userId: string): Promise<number> {
  const { config, spentTodayUsd } = await store().getConfig(userId);
  return Math.max(0, config.dayBudgetUsd - spentTodayUsd);
}

/** The user's own key for the provider of this model, or this machine's key from .env. */
async function apiKey(userId: string, modelId: string): Promise<string> {
  const provider = providerForModel(modelId);
  if (!provider)
    throw new SettingsError(
      `Rox does not know which provider serves "${modelId}".`,
    );
  const stored = await store().getProviderKey(userId, provider);
  if (stored)
    return decryptSecret(
      stored,
      `${userId}:${provider}`,
      need("ENCRYPTION_KEY"),
    );
  const names =
    provider === "google"
      ? ["GOOGLE_API_KEY", "GEMINI_API_KEY"]
      : [PROVIDERS[provider].envName];
  const local = names.map((n) => process.env[n]).find(Boolean);
  if (local) return local;
  throw new SettingsError(
    `No ${PROVIDERS[provider].name} key is saved for this account, so Rox cannot use ${modelId}. Add it in the setup guide.`,
  );
}

/** An OpenAI key for the Decisions API when the agents run on another provider. */
async function openaiKey(userId: string): Promise<string | null> {
  const stored = await store().getProviderKey(userId, "openai");
  if (stored)
    return decryptSecret(stored, `${userId}:openai`, need("ENCRYPTION_KEY"));
  return process.env.OPENAI_API_KEY ?? null;
}

/** The run's model and Decisions API, built in the worker from the user's key. */
export async function runModels(
  userId: string,
  modelId: string,
): Promise<RunModels> {
  const key = await apiKey(userId, modelId);
  const openai = providerForModel(modelId) === "openai";
  return {
    modelId,
    llm: (maxTokens) =>
      openai
        ? new ChatOpenAI({
            model: modelId,
            apiKey: key,
            maxTokens,
            timeout: 45_000,
            maxRetries: 0, // modelRetryMiddleware decides, so every try is visible.
            // GPT-5/6 reasoning models refuse tools together with reasoning on Chat Completions
            // ("use /v1/responses"); every sub-agent has tools, so they go through the Responses API.
            useResponsesApi: true,
            // One tool call at a time: two edits of one file must never race.
            modelKwargs: { parallel_tool_calls: false },
          })
        : createChatModel(modelId, key, {
            maxOutputTokens: maxTokens,
            reasoningSummary: false,
          }),
    // Always gpt-6-luna, with the user's OpenAI key (or this machine's).
    decide: decisionsFor(openai ? key : await openaiKey(userId)),
  };
}
