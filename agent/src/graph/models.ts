// Where the chat model for a user comes from: their own saved key, decrypted only here, only for
// the length of the turn.
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { PROVIDERS } from "../../../src/lib/models";
import type { Store } from "../store/sessions";
import { decryptSecret } from "../vault";
import { createChatModel, providerForModel } from "./llm";

export type ModelFactory = (
  userId: string,
  modelId: string,
  maxOutputTokens: number,
) => Promise<BaseChatModel>;

/** The model cannot be used, with the reason and what to do about it. */
export class ModelUnavailable extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = "ModelUnavailable";
  }
}

export function savedKeyModels(
  store: Store,
  encryptionKeyHex: string,
): ModelFactory {
  return async (userId, modelId, maxOutputTokens) => {
    const provider = providerForModel(modelId);
    if (!provider) {
      throw new ModelUnavailable(
        `Rox does not know which provider serves "${modelId}".`,
        "Choose a model in the setup guide.",
      );
    }
    const name = PROVIDERS[provider].name;
    const stored = await store.getProviderKey(userId, provider);
    if (!stored) {
      // This machine's own key (from .env), for local use when the account has none saved.
      const names =
        provider === "google"
          ? ["GOOGLE_API_KEY", "GEMINI_API_KEY"]
          : [PROVIDERS[provider].envName];
      const local = names.map((n) => process.env[n]).find(Boolean);
      if (local) return createChatModel(modelId, local, { maxOutputTokens });
      throw new ModelUnavailable(
        `No ${name} key is saved for this account, so Rox cannot use ${modelId}.`,
        "Add the key in the setup guide (Models step), then send your message again.",
      );
    }
    let apiKey: string;
    try {
      apiKey = decryptSecret(stored, `${userId}:${provider}`, encryptionKeyHex);
    } catch {
      throw new ModelUnavailable(
        `The saved ${name} key could not be read.`,
        "Save the key again in the setup guide (Models step).",
      );
    }
    return createChatModel(modelId, apiKey, { maxOutputTokens });
  };
}
