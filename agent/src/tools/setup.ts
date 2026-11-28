// Tools that read what the user chose in the setup guide. Nothing here touches the outside world.
import { z } from "zod";
import { DEMO_REPO, findModel, PROVIDERS } from "../../../src/lib/models";
import { defineTool } from "./define";
import { requireSetup } from "./shared";

const describeModel = (id: string | null) => {
  if (!id) return null;
  const model = findModel(id);
  return {
    id,
    label: model?.label ?? id,
    provider: model ? PROVIDERS[model.provider].name : "unknown",
  };
};

export const setupOverview = defineTool({
  name: "setup_overview",
  group: "setup",
  description:
    "Reads how Rox is set up for this user, in one call: Quick Judge Mode or a real GitHub repository, which repository, the main model (chat and planning) and the helper model, the sandbox chosen in setup and when it was last checked, which model providers have a saved key, and whether setup is complete. " +
    "Use it when the user asks how Rox is configured, which model or repo it uses, or whether setup is finished. It never returns a key or secret. " +
    "It does not cover connections or triggers (connections_list) or the repo's contents (repo_info). To change setup, the user goes to Settings (/home/settings).",
  input: z.object({}),
  risk: "read",
  timeoutMs: 10_000,
  title: () => "Read the setup",
  async run(_input, ctx) {
    const setup = await requireSetup(ctx);
    const user = await ctx.store.getUser(ctx.userId);
    const providers = await ctx.store.listKeyProviders(ctx.userId);
    const isDemo = Boolean(user?.isDemo) || setup.repo === DEMO_REPO;
    return {
      user: { login: user?.login ?? null, name: user?.name ?? null },
      mode: isDemo ? "quick_judge" : "github",
      repository: setup.repo,
      repositoryKind: isDemo ? "bundled demo app" : "GitHub repository",
      mainModel: describeModel(setup.orchestrator),
      helperModel: describeModel(setup.subagent),
      sandbox: setup.sandbox,
      sandboxCheckedAt: setup.sandboxCheckedAt?.toISOString() ?? null,
      modelProvidersWithSavedKey: providers.map((p) =>
        p in PROVIDERS ? PROVIDERS[p as keyof typeof PROVIDERS].name : p,
      ),
      changeAt: "/home/settings",
      setupComplete: Boolean(
        setup.repo && setup.orchestrator && setup.subagent && setup.sandbox,
      ),
    };
  },
  summarize(output) {
    const o = output as {
      repository?: string;
      mainModel?: { label: string } | null;
      sandbox?: string;
    };
    return [o.repository, o.mainModel?.label, o.sandbox]
      .filter(Boolean)
      .join(" · ");
  },
});
