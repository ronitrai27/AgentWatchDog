// Better Stack's hosted MCP server: how Rox QUERIES Better Stack (incidents, monitors, uptime, logs).
// Webhooks wake the pipeline; this is only for answering questions. Same BETTERSTACK_API_TOKEN as the
// webhook setup, sent as a header from the server, never shown to a model. Rox writes no query tools
// of its own: the brain's Better Stack subagent (not built yet) gets the server's tools from here.
import { MCPAdapter } from "@langchain/mcp-adapters";
import type { BetterStackEnv } from "./betterstack";

export const BETTERSTACK_MCP_URL = "https://mcp.betterstack.com";

/**
 * A client for Better Stack's MCP server. `onlyTools` becomes Better Stack's X-MCP-Tools-Only
 * header, so the server itself hides every other tool (used to keep the agent read-only).
 */
export function betterstackMcp(
  s: BetterStackEnv,
  options: { onlyTools?: string[] } = {},
): MCPAdapter {
  return new MCPAdapter({
    servers: {
      betterstack: {
        url: BETTERSTACK_MCP_URL,
        headers: {
          Authorization: `Bearer ${s.token}`,
          ...(options.onlyTools?.length
            ? { "X-MCP-Tools-Only": options.onlyTools.join(",") }
            : {}),
        },
      },
    },
    prefixToolNameWithServerName: false,
  });
}

export type McpCheck =
  | { ok: true; tools: string[] }
  | { ok: false; error: string };

/** Connects with the token and lists the tools the server offers. Changes nothing. */
export async function checkBetterStackMcp(
  s: BetterStackEnv,
): Promise<McpCheck> {
  const mcp = betterstackMcp(s);
  try {
    const tools = await Promise.race([
      mcp.listTools(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("no answer in 15s")), 15_000),
      ),
    ]);
    return { ok: true, tools: tools.map((t) => t.name).sort() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await mcp.close().catch(() => {});
  }
}
