import { MODELS, type Provider } from "./models";

// Fixed addresses: the key is only ever sent to the provider it belongs to.
const LIST: Record<
  Provider,
  (key: string) => { url: string; headers: Record<string, string> }
> = {
  openai: (key) => ({
    url: "https://api.openai.com/v1/models",
    headers: { Authorization: `Bearer ${key}` },
  }),
  anthropic: (key) => ({
    url: "https://api.anthropic.com/v1/models?limit=1000",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  }),
  google: (key) => ({
    url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    headers: { "x-goog-api-key": key },
  }),
};

export type KeyCheck =
  | { ok: true; models: string[] }
  | { ok: false; reason: "rejected" | "unreachable" };

/**
 * Lists the provider's models with this key. That proves the key works, costs
 * no tokens, and tells us which of Rox's models it can use.
 */
export async function checkProviderKey(
  provider: Provider,
  key: string,
): Promise<KeyCheck> {
  const { url, headers } = LIST[provider](key);
  try {
    const response = await fetch(url, {
      headers,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    // Google answers 400 for a malformed key, the others 401 or 403.
    if ([400, 401, 403].includes(response.status)) {
      return { ok: false, reason: "rejected" };
    }
    if (!response.ok) return { ok: false, reason: "unreachable" };

    const body = (await response.json()) as {
      data?: { id: string }[];
      models?: { name: string }[];
    };
    const ids = new Set([
      ...(body.data ?? []).map((model) => model.id),
      ...(body.models ?? []).map((model) =>
        model.name.replace(/^models\//, ""),
      ),
    ]);
    return {
      ok: true,
      models: MODELS.filter(
        (model) => model.provider === provider && ids.has(model.id),
      ).map((model) => model.id),
    };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}
