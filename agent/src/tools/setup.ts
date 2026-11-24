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

export const setupGet = defineTool({
  name: "setup_get",
  group: "setup",
  description:
    "Reads what the user chose in the setup guide: the repository, the main and helper models, the sandbox, and which model providers have a saved key. " +
    "Use it first when you need to know how Rox is configured. It never returns any key or secret.",
  input: z.object({}),
  risk: "read",
  timeoutMs: 5_000,
  title: () => "Read the saved setup",
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
