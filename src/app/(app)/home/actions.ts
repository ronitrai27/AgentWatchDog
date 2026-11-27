"use server";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { revalidatePath } from "next/cache";
import { type AgentConfig, configProblem } from "@/lib/agent-config";
import { writeAgentConfig } from "@/lib/agent-config-store";
import { db } from "@/lib/db";
import {
  DEMO_REPO,
  findModel,
  PROVIDERS,
  type Provider,
  type SavedKey,
} from "@/lib/models";
import { checkProviderKey } from "@/lib/provider-check";
import {
  checkSlack,
  removeReportConnection,
  type SlackCheck,
  saveSlackConnection,
} from "@/lib/report-connections";
import { getSession } from "@/lib/session";
import { invalidateInsights } from "@/lib/insights";
import { listRepos } from "@/lib/setup";
import { recordAudit } from "@/lib/users";
import { encryptSecret } from "@/lib/vault";

// Every action is a public endpoint, so each one checks the session and never
// trusts what the browser sent.

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const run = promisify(execFile);
const SIGNED_OUT = {
  ok: false,
  error: "Your session ended. Sign in again.",
} as const;
const NOT_SAVED = {
  ok: false,
  error: "Rox could not reach its database, so nothing was saved. Try again.",
} as const;

async function audit(
  userId: string,
  type: string,
  data: Record<string, unknown>,
) {
  await recordAudit({ userId, actor: `user:${userId}`, type, data });
}

/** Refreshes the page and the repository shown in the sidebar. */
const refresh = () => revalidatePath("/home", "layout");

export async function saveRepo(name: string): Promise<Result> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;

  let installationId: number | null = null;
  if (session.mode === "demo") {
    if (name !== DEMO_REPO) {
      return { ok: false, error: "Quick Demo Mode uses the bundled app." };
    }
  } else {
    try {
      const match = (await listRepos(session)).find((r) => r.name === name);
      if (!match) {
        return {
          ok: false,
          error:
            "Rox can no longer see that repository. Choose another, or add it on GitHub.",
        };
      }
      installationId = match.installationId;
    } catch {
      return { ok: false, error: "GitHub did not answer. Try again." };
    }
  }

  try {
    await db().query(
      `INSERT INTO user_setup (user_id, repo, repo_installation_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
         SET repo = EXCLUDED.repo,
             repo_installation_id = EXCLUDED.repo_installation_id,
             updated_at = now()`,
      [session.uid, name, installationId],
    );
  } catch {
    return NOT_SAVED;
  }
  await audit(session.uid, "setup.repo", { repo: name });
  invalidateInsights(session.uid);
  refresh();
  return { ok: true };
}

export async function saveModels(
  orchestrator: string,
  subagent: string,
): Promise<Result> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;

  const model = findModel(orchestrator);
  if (!model) return { ok: false, error: "Choose a brain agent model." };
  const sub = findModel(subagent);
  if (!sub) return { ok: false, error: "Choose a sub agent model." };

  try {
    await db().query(
      `INSERT INTO user_setup (user_id, orchestrator_model, subagent_model)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
         SET orchestrator_model = EXCLUDED.orchestrator_model,
             subagent_model = EXCLUDED.subagent_model,
             updated_at = now()`,
      [session.uid, model.id, sub.id],
    );
  } catch {
    return NOT_SAVED;
  }
  await audit(session.uid, "setup.models", {
    orchestrator: model.id,
    subagent: sub.id,
  });
  refresh();
  return { ok: true };
}

/** Checks the key with its provider, then stores it encrypted. */
export async function saveProviderKey(
  provider: string,
  rawKey: string,
): Promise<Result<{ key: SavedKey }>> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  if (!Object.hasOwn(PROVIDERS, provider)) {
    return { ok: false, error: "Unknown provider." };
  }

  const id = provider as Provider;
  const { name } = PROVIDERS[id];
  const key = String(rawKey).trim();
  if (!/^[\x21-\x7e]{20,300}$/.test(key)) {
    return {
      ok: false,
      error: `That does not look like an API key from ${name}.`,
    };
  }

  const check = await checkProviderKey(id, key);
  if (!check.ok) {
    return {
      ok: false,
      error:
        check.reason === "rejected"
          ? `${name} rejected this key. Check it and paste it again.`
          : `${name} did not answer, so the key was not saved. Try again.`,
    };
  }

  const saved: SavedKey = {
    last4: key.slice(-4),
    models: check.models,
    savedAt: new Date().toISOString(),
  };
  try {
    const { iv, ciphertext, tag } = encryptSecret(key, `${session.uid}:${id}`);
    const client = await db().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM provider_keys WHERE user_id = $1 AND provider = $2",
        [session.uid, id],
      );
      await client.query(
        `INSERT INTO provider_keys
           (user_id, provider, iv, ciphertext, tag, last4, models, verified_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          session.uid,
          id,
          iv,
          ciphertext,
          tag,
          saved.last4,
          saved.models,
          saved.savedAt,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    // Never log the key; the message comes from Postgres or the vault.
    console.error("saving a provider key failed:", (error as Error).message);
    return { ok: false, error: "The key is valid but could not be saved." };
  }
  await audit(session.uid, "setup.key_saved", { provider: id });
  refresh();
  return { ok: true, key: saved };
}

export async function removeProviderKey(provider: string): Promise<Result> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  if (!Object.hasOwn(PROVIDERS, provider)) {
    return { ok: false, error: "Unknown provider." };
  }

  let removed: number | null;
  try {
    const result = await db().query(
      "DELETE FROM provider_keys WHERE user_id = $1 AND provider = $2",
      [session.uid, provider],
    );
    removed = result.rowCount;
  } catch {
    return {
      ok: false,
      error:
        "Rox could not reach its database, so the key was not deleted. Try again.",
    };
  }
  // Already gone, for example from another tab: nothing to record.
  if (removed) await audit(session.uid, "setup.key_removed", { provider });
  refresh();
  return { ok: true };
}

/** Asks the Docker engine for its version. Saved only if it answers. */
export async function checkDocker(): Promise<Result<{ version: string }>> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;

  let version: string;
  try {
    const { stdout } = await run(
      "docker",
      ["version", "--format", "{{.Server.Version}}"],
      { timeout: 8000, windowsHide: true },
    );
    version = stdout.trim();
    if (!version) throw new Error("no version");
  } catch {
    return {
      ok: false,
      error: "Docker is not answering. Start Docker Desktop, then check again.",
    };
  }

  try {
    await db().query(
      `INSERT INTO user_setup (user_id, sandbox, sandbox_checked_at)
       VALUES ($1, 'docker', now())
       ON CONFLICT (user_id) DO UPDATE
         SET sandbox = 'docker', sandbox_checked_at = now(), updated_at = now()`,
      [session.uid],
    );
  } catch {
    return NOT_SAVED;
  }
  await audit(session.uid, "setup.sandbox", { sandbox: "docker", version });
  refresh();
  return { ok: true, version };
}

/** The caps, tone, instructions and schedule under Settings. */
export async function saveAgentConfig(input: AgentConfig): Promise<Result> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  if (!input || typeof input !== "object")
    return { ok: false, error: "Nothing to save." };
  const problem = configProblem(input);
  if (problem) return { ok: false, error: problem };
  const config: AgentConfig = {
    dayBudgetUsd: Math.round(input.dayBudgetUsd * 100) / 100,
    maxMinutes: input.maxMinutes,
    tone: input.tone,
    instructions: input.instructions.trim(),
    schedule: input.schedule,
  };
  try {
    await writeAgentConfig(session.uid, config);
  } catch {
    return NOT_SAVED;
  }
  const { instructions, ...logged } = config;
  await audit(session.uid, "agent.config", {
    ...logged,
    instructionsLength: instructions.length,
  });
  refresh();
  return { ok: true };
}

// ---------- Report connections (Slack now, Telegram later) ----------

/** Checks the Slack tokens in .env against Slack. Returns no token, only what they can do. */
export async function checkSlackConnection(): Promise<
  Result<{ check: SlackCheck }>
> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  return { ok: true, check: await checkSlack() };
}

/** Connects Slack: checks the token again and saves the channel the report goes to. */
export async function connectSlack(channelId: string): Promise<Result> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  const check = await checkSlack();
  if (!check.ready)
    return { ok: false, error: check.error ?? "Slack is not ready." };
  // The channel must be one the bot is really in; the browser's word is not enough.
  const channel = check.channels.find((c) => c.id === channelId);
  if (!channel)
    return {
      ok: false,
      error: "Rox is not in that channel. Invite @rox to it in Slack first.",
    };
  try {
    await saveSlackConnection(session.uid, {
      workspace: check.workspace,
      workspaceId: check.workspaceId,
      botUser: check.botUser,
      channelId: channel.id,
      channelName: channel.name,
    });
  } catch {
    return NOT_SAVED;
  }
  await audit(session.uid, "connection.slack", {
    workspace: check.workspace,
    channel: channel.name,
  });
  revalidatePath("/home/connections");
  return { ok: true };
}

export async function disconnectReport(provider: string): Promise<Result> {
  const session = await getSession();
  if (!session) return SIGNED_OUT;
  if (provider !== "slack" && provider !== "telegram")
    return { ok: false, error: "Unknown app." };
  try {
    await removeReportConnection(session.uid, provider);
  } catch {
    return NOT_SAVED;
  }
  await audit(session.uid, "connection.removed", { provider });
  revalidatePath("/home/connections");
  return { ok: true };
}
