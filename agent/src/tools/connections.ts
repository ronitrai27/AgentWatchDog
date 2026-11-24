// Tools about the apps Rox can listen to or report to.
import { z } from "zod";
import { DEMO_REPO } from "../../../src/lib/models";
import { defineTool } from "./define";
import { requireSetup } from "./shared";

type Status = "connected" | "test_mode" | "not_connected";

// What each app would give Rox. Only GitHub can be connected today.
const OTHER_APPS = [
  {
    id: "sentry",
    name: "Sentry",
    gives: "wakes Rox when an error appears, with the stack trace",
  },
  {
    id: "slack",
    name: "Slack",
    gives: "Rox's reports, and approval requests in a thread",
  },
  { id: "linear", name: "Linear", gives: "Rox opens and updates issues" },
  { id: "posthog", name: "PostHog", gives: "wakes Rox when a metric drops" },
  { id: "vercel", name: "Vercel", gives: "wakes Rox when a deploy fails" },
  { id: "betterstack", name: "Better Stack", gives: "wakes Rox on downtime" },
] as const;

export const connectionsList = defineTool({
  name: "connections_list",
  group: "connections",
  description:
    "Lists the apps Rox can connect to (GitHub, Sentry, Slack, Linear, PostHog, Vercel, Better Stack), whether each is connected, and what connecting it would give the user. " +
    "Use it when the user asks what Rox can see or do, or before recommending a connection.",
  input: z.object({}),
  risk: "read",
  timeoutMs: 5_000,
  title: () => "List the connections",
  async run(_input, ctx) {
    const setup = await requireSetup(ctx);
    const user = await ctx.store.getUser(ctx.userId);
    const isDemo = Boolean(user?.isDemo) || setup.repo === DEMO_REPO;
    const github: { status: Status; detail: string } = isDemo
      ? {
          status: "test_mode",
          detail:
            "Quick Judge Mode uses the bundled demo app and simulates GitHub.",
        }
      : setup.installationId !== null && setup.repo
        ? {
            status: "connected",
            detail: `Rox GitHub App installed; working on ${setup.repo} with read access to code, pull requests and checks.`,
          }
        : {
            status: "not_connected",
            detail:
              "The Rox GitHub App is not linked to the chosen repository.",
          };

    return {
      connections: [
        { id: "github", name: "GitHub", ...github, canBeConnectedNow: true },
        ...OTHER_APPS.map((app) => ({
          id: app.id,
          name: app.name,
          status: (isDemo ? "test_mode" : "not_connected") as Status,
          detail: isDemo
            ? "Runs in test mode in Quick Judge Mode."
            : "Not connected.",
          gives: app.gives,
          canBeConnectedNow: false,
          note: "Connecting this app is not built yet.",
        })),
      ],
    };
  },
  summarize(output) {
    const list = (output as { connections: { status: Status }[] }).connections;
    const connected = list.filter((c) => c.status === "connected").length;
    return `${connected} of ${list.length} connected`;
  },
});
