// Slack Events API & Interactivity verification + parsing.
// Pure functions only: verifies HMAC-SHA256 signature and extracts @rox mentions / DMs
// without invoking any agent code.
import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_SKEW_SECONDS = 60 * 5;

/**
 * Verifies `x-slack-signature` (`v0=<hex>`) over `v0:<timestamp>:<body>` and guards against
 * replay requests older than 5 minutes.
 */
export function validSlackSignature(
  body: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  signingSecret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!timestampHeader || !signatureHeader?.startsWith("v0=")) return false;
  const ts = Number(timestampHeader);
  if (!Number.isInteger(ts)) return false;
  if (Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return false;

  const base = `v0:${timestampHeader}:${body}`;
  const expected = Buffer.from(
    `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`,
  );
  const given = Buffer.from(signatureHeader);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export type SlackDecision =
  | {
      kind: "url_verification";
      challenge: string;
    }
  | {
      kind: "trigger";
      source: "app_mention" | "dm";
      eventId: string;
      teamId: string | null;
      channel: string;
      user: string;
      rawText: string;
      /** Message text with leading `<@U...>` bot mention stripped. */
      prompt: string;
      ts: string;
      threadTs: string;
    }
  | {
      kind: "ignored";
      why: string;
    };

/** Strips leading `<@U12345>` mention tags so `"<@U123> hello, latest PRs?"` becomes `"hello, latest PRs?"`. */
export function stripBotMentions(text: string): string {
  return text.replace(/^(?:<@[A-Z0-9]+>\s*)+/i, "").trim();
}

export function decideSlackEvent(payload: unknown): SlackDecision {
  if (!payload || typeof payload !== "object") {
    return { kind: "ignored", why: "empty or non-object payload" };
  }
  const p = payload as {
    type?: string;
    challenge?: string;
    event_id?: string;
    team_id?: string;
    event?: {
      type?: string;
      subtype?: string;
      bot_id?: string;
      app_id?: string;
      user?: string;
      channel?: string;
      channel_type?: string;
      text?: string;
      ts?: string;
      thread_ts?: string;
    };
  };

  if (p.type === "url_verification" && typeof p.challenge === "string") {
    return { kind: "url_verification", challenge: p.challenge };
  }

  if (p.type !== "event_callback" || !p.event) {
    return {
      kind: "ignored",
      why: `envelope type "${p.type ?? "?"}" is not event_callback`,
    };
  }

  const ev = p.event;
  // Never react to messages sent by Rox or any other bot, or edited/deleted message subtypes.
  if (ev.bot_id || ev.app_id) {
    return { kind: "ignored", why: "bot message ignored to prevent loops" };
  }
  if (ev.subtype) {
    return {
      kind: "ignored",
      why: `message subtype "${ev.subtype}" is ignored`,
    };
  }

  const isMention = ev.type === "app_mention";
  const isDm = ev.type === "message" && ev.channel_type === "im";
  if (!isMention && !isDm) {
    return {
      kind: "ignored",
      why: `event "${ev.type ?? "?"}" (${ev.channel_type ?? "-"}) is not @rox mention or DM`,
    };
  }

  if (!ev.channel || !ev.user || !ev.ts) {
    return { kind: "ignored", why: "missing channel, user, or ts on event" };
  }

  const rawText = ev.text ?? "";
  const prompt = stripBotMentions(rawText);

  return {
    kind: "trigger",
    source: isMention ? "app_mention" : "dm",
    eventId: p.event_id ?? `${ev.channel}:${ev.ts}`,
    teamId: p.team_id ?? null,
    channel: ev.channel,
    user: ev.user,
    rawText,
    prompt,
    ts: ev.ts,
    threadTs: ev.thread_ts ?? ev.ts,
  };
}
