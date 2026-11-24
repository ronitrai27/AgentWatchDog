// Removes anything that looks like a secret before it is written to the chat log or sent
// to a screen. This is a second line of defence: secrets should never reach this point.

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, // OpenAI
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, // GitHub
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

export const REDACTED = "[redacted]";

export function redactText(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/** Redacts every string inside a JSON-like value. Returns a copy. */
export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value))
      out[key] = redactValue(item);
    return out as T;
  }
  return value;
}
