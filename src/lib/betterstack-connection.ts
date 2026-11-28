// The user's Better Stack connection. The API token and webhook secret stay in .env; user_setup only
// records which heartbeat or monitor is theirs, so an incident on it can find them.
import {
  type BetterStackSource,
  betterstackFromEnv,
  listSources,
} from "@agent/integrations/betterstack";
import { checkBetterStackMcp } from "@agent/integrations/betterstack-mcp";
import { withUser } from "./db";

export type BetterStackConnection = {
  kind: "heartbeat" | "monitor";
  id: string;
  name: string;
  connectedAt: string;
};

export type BetterStackCheck = {
  ready: boolean;
  /** BETTERSTACK_WEBHOOK_SECRET is set, so incident webhooks can be checked. */
  secret: boolean;
  /** Where Better Stack will send incidents (BETTERSTACK_WEBHOOK_URL), or null. */
  webhookUrl: string | null;
  sources: BetterStackSource[];
  /** Better Stack's MCP server, which the brain will query through. Same token. */
  mcp: { ok: boolean; tools: number; error: string | null } | null;
  error: string | null;
};

/** The public address Better Stack posts to: the relay in development, the app in production. */
export function betterstackWebhookUrl(): string | null {
  return process.env.BETTERSTACK_WEBHOOK_URL?.trim() || null;
}

/** Checks BETTERSTACK_API_TOKEN against Better Stack. Never returns the token. */
export async function checkBetterStack(): Promise<BetterStackCheck> {
  const secret = Boolean(process.env.BETTERSTACK_WEBHOOK_SECRET?.trim());
  const webhookUrl = betterstackWebhookUrl();
  const s = betterstackFromEnv();
  if (!s)
    return {
      ready: false,
      secret,
      webhookUrl,
      sources: [],
      mcp: null,
      error: "BETTERSTACK_API_TOKEN is not set in .env.",
    };
  // The API (webhook setup) and the MCP server (queries) are checked together, with one token.
  const mcpCheck = checkBetterStackMcp(s).then((m) =>
    m.ok
      ? { ok: true, tools: m.tools.length, error: null }
      : { ok: false, tools: 0, error: m.error },
  );
  try {
    const sources = await listSources(s);
    return {
      ready: true,
      secret,
      webhookUrl,
      sources,
      mcp: await mcpCheck,
      error: sources.length
        ? null
        : "The token sees no heartbeat or monitor. Create a heartbeat in Better Stack first.",
    };
  } catch (error) {
    return {
      ready: false,
      secret,
      webhookUrl,
      sources: [],
      mcp: await mcpCheck,
      error: `Better Stack refused the token: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function getBetterStackConnection(
  userId: string,
): Promise<BetterStackConnection | null> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{
      betterstack_source_kind: "heartbeat" | "monitor" | null;
      betterstack_source_id: string | null;
      betterstack_source_name: string | null;
      betterstack_connected_at: Date | null;
    }>(
      `SELECT betterstack_source_kind, betterstack_source_id, betterstack_source_name,
              betterstack_connected_at
         FROM user_setup WHERE user_id = $1`,
      [userId],
    );
    const r = rows[0];
    return r?.betterstack_source_kind &&
      r.betterstack_source_id &&
      r.betterstack_connected_at
      ? {
          kind: r.betterstack_source_kind,
          id: r.betterstack_source_id,
          name: r.betterstack_source_name ?? r.betterstack_source_id,
          connectedAt: r.betterstack_connected_at.toISOString(),
        }
      : null;
  });
}

export async function saveBetterStackConnection(
  userId: string,
  c: { kind: "heartbeat" | "monitor"; id: string; name: string } | null,
) {
  await withUser(userId, (client) =>
    client.query(
      `INSERT INTO user_setup (user_id, betterstack_source_kind, betterstack_source_id,
                               betterstack_source_name, betterstack_connected_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $3::text IS NULL THEN NULL ELSE now() END)
       ON CONFLICT (user_id) DO UPDATE
         SET betterstack_source_kind = EXCLUDED.betterstack_source_kind,
             betterstack_source_id = EXCLUDED.betterstack_source_id,
             betterstack_source_name = EXCLUDED.betterstack_source_name,
             betterstack_connected_at = EXCLUDED.betterstack_connected_at`,
      [userId, c?.kind ?? null, c?.id ?? null, c?.name ?? null],
    ),
  );
}
