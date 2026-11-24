// Builds the chat model Rox thinks with, from the model id the user chose and their key.
// Any provider works: the graph only ever sees a LangChain chat model.

import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { MODELS } from "../../../src/lib/models";

export type Provider = "openai" | "anthropic" | "google";

/** Which provider serves a model id. The setup guide's list wins; otherwise the usual naming. */
export function providerForModel(modelId: string): Provider | undefined {
  const known = MODELS.find((model) => model.id === modelId);
  if (known) return known.provider;
  if (/^claude[-.]/i.test(modelId)) return "anthropic";
  if (/^gemini[-.]/i.test(modelId)) return "google";
  if (/^(gpt|o\d|chatgpt)[-.\d]/i.test(modelId)) return "openai";
  return undefined;
}

export type ChatModelOptions = {
  maxOutputTokens: number;
  /** Ask for a readable summary of the model's reasoning. Default true. */
  reasoningSummary?: boolean;
  baseUrl?: string;
};

/** LangChain's own retry for temporary provider failures. */
const MAX_RETRIES = 2;

/** Models that accept the reasoning options. Others would reject them, so they are left out. */
const OPENAI_REASONING = /^(o\d|gpt-5|gpt-6)/i;
const ANTHROPIC_THINKING = /^claude-.*-5|^claude-(opus|sonnet)-4/i;

export function createChatModel(
  modelId: string,
  apiKey: string,
  options: ChatModelOptions,
): BaseChatModel {
  const provider = providerForModel(modelId);
  const summary = options.reasoningSummary ?? true;
  switch (provider) {
    case "openai":
      return new ChatOpenAI({
        model: modelId,
        apiKey,
        maxTokens: options.maxOutputTokens,
        maxRetries: MAX_RETRIES,
        // The Responses API is the one that returns reasoning summaries.
        useResponsesApi: true,
        ...(summary && OPENAI_REASONING.test(modelId)
          ? { reasoning: { effort: "medium", summary: "auto" } }
          : {}),
        ...(options.baseUrl
          ? { configuration: { baseURL: options.baseUrl } }
          : {}),
      });
    case "anthropic":
      return new ChatAnthropic({
        model: modelId,
        apiKey,
        maxTokens: options.maxOutputTokens,
        maxRetries: MAX_RETRIES,
        ...(summary && ANTHROPIC_THINKING.test(modelId)
          ? { thinking: { type: "adaptive", display: "summarized" } }
          : {}),
        ...(options.baseUrl ? { anthropicApiUrl: options.baseUrl } : {}),
      } as ConstructorParameters<typeof ChatAnthropic>[0]);
    case "google":
      return new ChatGoogleGenerativeAI({
        model: modelId,
        apiKey,
        maxOutputTokens: options.maxOutputTokens,
        maxRetries: MAX_RETRIES,
        ...(summary ? { thinkingConfig: { includeThoughts: true } } : {}),
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      });
    default:
      throw new Error(
        `Rox does not know which provider serves "${modelId}". Choose a model from the setup guide.`,
      );
  }
}

// ---- when the model call fails

/** Plain words for a failed model call: what happened, and what to do about it. */
export function explainModelError(error: unknown): {
  message: string;
  kind: string;
  hint?: string;
  transient: boolean;
} {
  const raw = error instanceof Error ? error.message : String(error);
  const status = Number(
    (error as { status?: number; response?: { status?: number } })?.status ??
      (error as { response?: { status?: number } })?.response?.status ??
      raw.match(/\b(4\d\d|5\d\d)\b/)?.[1] ??
      0,
  );
  const code = String((error as { code?: string })?.code ?? "");
  const detail = raw.replace(/\s+/g, " ").slice(0, 300);

  if (
    status === 401 ||
    status === 403 ||
    /api key|authentication|unauthor/i.test(raw)
  )
    return {
      message: `The model provider rejected the key. ${detail}`,
      kind: "auth",
      hint: "Check the key for this provider in the setup guide.",
      transient: false,
    };
  if (status === 404 || /model.*(not found|does not exist)/i.test(raw))
    return {
      message: `The provider does not know this model. ${detail}`,
      kind: "not_found",
      hint: "Choose another model in the setup guide.",
      transient: false,
    };
  if (status === 429 || /rate.?limit|quota/i.test(raw)) {
    // A daily or monthly quota will not clear in a few seconds, so retrying only wastes time.
    const longWait = /per.?day|per.?month|daily|retry in \d+h|billing/i.test(
      raw,
    );
    return {
      message: longWait
        ? `The provider's quota for this key is used up. ${detail}`
        : `The provider is limiting requests (rate limit). ${detail}`,
      kind: "rate_limit",
      hint: longWait
        ? "Wait for the quota to reset, add billing on the provider's site, or choose another model in the setup guide."
        : "Wait a little and send the message again.",
      transient: !longWait,
    };
  }
  if (
    [408, 500, 502, 503, 504, 529].includes(status) ||
    /overload|high demand|unavailable/i.test(raw)
  )
    return {
      message: `The provider is having trouble right now. ${detail}`,
      kind: "overloaded",
      hint: "Send the message again in a minute.",
      transient: true,
    };
  if (
    /ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|fetch failed|network/i.test(
      `${code} ${raw}`,
    )
  )
    return {
      message: `Could not reach the model provider. ${detail}`,
      kind: "network",
      hint: "Check the internet connection and try again.",
      transient: true,
    };
  if (status === 400)
    return {
      message: `The provider refused the request. ${detail}`,
      kind: "bad_request",
      transient: false,
    };
  return {
    message: `The model call failed: ${detail}`,
    kind: "internal",
    transient: false,
  };
}
