import { cache } from "react";
import { db } from "./db";
import { getInstallationRepos } from "./github-app";
import { findModel, type Provider, type SetupState } from "./models";
import type { Session } from "./session-token";

/** What this user has chosen so far. Cached per request: layout and page share it. */
export const getSetup = cache(async (userId: string): Promise<SetupState> => {
  const [setup, keys] = await Promise.all([
    db().query<{
      repo: string | null;
      orchestrator_model: string | null;
      subagent_model: string | null;
      sandbox: string | null;
      sandbox_checked_at: Date | null;
    }>(
      `SELECT repo, orchestrator_model, subagent_model, sandbox, sandbox_checked_at
         FROM user_setup WHERE user_id = $1`,
      [userId],
    ),
    db().query<{ provider: Provider; last4: string; models: string[] }>(
      "SELECT provider, last4, models FROM provider_keys WHERE user_id = $1",
      [userId],
    ),
  ]);

  const row = setup.rows[0];
  return {
    repo: row?.repo ?? null,
    orchestrator: findModel(row?.orchestrator_model)?.id ?? null,
    subagent: findModel(row?.subagent_model)?.id ?? null,
    keys: Object.fromEntries(
      keys.rows.map(({ provider, last4, models }) => [
        provider,
        { last4, models },
      ]),
    ),
    sandbox:
      row?.sandbox === "docker" && row.sandbox_checked_at ? "docker" : null,
  };
});

export type ChoosableRepo = {
  name: string;
  private: boolean;
  installationId: number;
};

/**
 * The repositories this user's installations can see right now. An
 * installation that was removed on GitHub is skipped, not an error.
 */
export async function listRepos(session: Session): Promise<ChoosableRepo[]> {
  const results = await Promise.allSettled(
    session.installations.map(async (installationId) =>
      (await getInstallationRepos(installationId)).map((repo) => ({
        name: repo.full_name,
        private: repo.private,
        installationId,
      })),
    ),
  );
  const ok = results.filter((result) => result.status === "fulfilled");
  if (results.length > 0 && ok.length === 0) {
    throw new Error("no installation could be read");
  }
  return ok
    .flatMap((result) => result.value)
    .sort((a, b) => a.name.localeCompare(b.name));
}
