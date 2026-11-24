import { DEMO_REPO } from "../../../src/lib/models";
import type { SetupRow } from "../store/sessions";
import { type ToolContext, ToolError } from "./types";

/** The user's saved setup, or a clear reason it is not there. */
export async function requireSetup(ctx: ToolContext): Promise<SetupRow> {
  const setup = await ctx.store.getSetup(ctx.userId);
  if (!setup) {
    throw new ToolError(
      "not_found",
      "This user has not finished the setup guide",
      {
        hint: "Ask the user to finish the setup guide on the Home page first.",
      },
    );
  }
  return setup;
}

export type GithubTarget = {
  installationId: number;
  repo: string;
  signal: AbortSignal;
};

/** Where to read from on GitHub, or the reason there is nothing to read. */
export async function githubTarget(ctx: ToolContext): Promise<{
  target: GithubTarget;
  client: NonNullable<ToolContext["github"]>;
}> {
  const setup = await requireSetup(ctx);
  const user = await ctx.store.getUser(ctx.userId);

  if (user?.isDemo || setup.repo === DEMO_REPO) {
    throw new ToolError(
      "unavailable",
      "Quick Judge Mode works on the bundled demo app, not on a GitHub repository",
      {
        hint: "GitHub tools are only used in a real GitHub session.",
      },
    );
  }
  if (!setup.repo) {
    throw new ToolError(
      "not_found",
      "No repository was chosen in the setup guide",
      { hint: "Choose a repository in the setup guide." },
    );
  }
  if (setup.installationId === null) {
    throw new ToolError(
      "unavailable",
      `The Rox GitHub App is not linked to ${setup.repo}`,
      {
        hint: "Choose the repository again in the setup guide so Rox records which installation to use.",
      },
    );
  }
  if (!ctx.github) {
    throw new ToolError(
      "unavailable",
      "The Rox GitHub App is not configured on this machine",
      {
        hint: "Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH in .env, then restart the agent service.",
      },
    );
  }
  return {
    client: ctx.github,
    target: {
      installationId: setup.installationId,
      repo: setup.repo,
      signal: ctx.signal,
    },
  };
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
