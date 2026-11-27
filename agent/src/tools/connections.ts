// Tools about the apps Rox can listen to or report to. Every status here is real: GitHub from the
// setup, Slack from the user's saved connection plus a live check of the bot token. Nothing is
// guessed; a failed check says exactly what failed.
import { z } from "zod";
import { DEMO_REPO } from "../../../src/lib/models";
import { slackFromEnv } from "../integrations/slack";
import { defineTool } from "./define";
import { requireSetup } from "./shared";

type Status = "connected" | "test_mode" | "not_connected" | "error";

type Connection = {
  id: string;
  name: string;
  status: Status;
  detail: string;
  gives?: string;
  canBeConnectedNow: boolean;
  /** Where the user connects it. */
  connectAt?: string;
  note?: string;
};

// Apps that can only wake Rox later; none can be connected yet.
const NOT_BUILT = [
  {
    id: "sentry",
    name: "Sentry",
    gives: "wakes Rox when an error appears, with the stack trace",
  },
  { id: "linear", name: "Linear", gives: "Rox opens and updates issues" },
  { id: "posthog", name: "PostHog", gives: "wakes Rox when a metric drops" },
  { id: "vercel", name: "Vercel", gives: "wakes Rox when a deploy fails" },
  { id: "betterstack", name: "Better Stack", gives: "wakes Rox on downtime" },
] as const;

const SLACK_GIVES =
  "Rox's report after every run: what failed, the cause, the fix and the pull request";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const connectionsList = defineTool({
  name: "connections_list",
  group: "connections",
  description:
    "Lists the apps Rox can connect to (GitHub, Slack, Telegram, Sentry, Linear, PostHog, Vercel, Better Stack) with their real status: connected, not connected, or an error with the exact reason. Slack is checked live against Slack. " +
    "Use it when the user asks what Rox is connected to, what Rox can see or do, or before recommending a connection.",
  input: z.object({}),
  risk: "read",
  timeoutMs: 5_000,
  title: () => "List the connections",
  async run(_input, ctx) {
    const setup = await requireSetup(ctx);
    const user = await ctx.store.getUser(ctx.userId);
    const isDemo = Boolean(user?.isDemo) || setup.repo === DEMO_REPO;

    const github: Connection = {
      id: "github",
      name: "GitHub",
      canBeConnectedNow: true,
      ...(isDemo
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
              connectAt: "/home",
            }),
    };

    const { connections: saved, reportTo } =
      await ctx.store.getReportConnections(ctx.userId);
    const slackRow = saved.find((c) => c.provider === "slack");
    let slack: Connection;
    if (!slackRow) {
      slack = {
        id: "slack",
        name: "Slack",
        status: "not_connected",
        detail: "Not connected.",
        gives: SLACK_GIVES,
        canBeConnectedNow: true,
        connectAt: "/home/connections",
      };
    } else {
      const where = `${slackRow.workspace ?? "the workspace"}, channel #${slackRow.channelName ?? slackRow.channelId}`;
      const reports =
        reportTo === "slack"
          ? " Final reports go here."
          : " Final reports are not sent here (another app is chosen).";
      const client = slackFromEnv();
      if (!client)
        slack = {
          id: "slack",
          name: "Slack",
          status: "error",
          detail: `Connected to ${where}, but the server has no SLACK_BOT_TOKEN, so nothing can be posted.`,
          gives: SLACK_GIVES,
          canBeConnectedNow: true,
          connectAt: "/home/connections",
        };
      else
        try {
          // Inside the tool's own 5 s limit, and stopped with the run.
          const auth = await client.authTest(
            AbortSignal.any([ctx.signal, AbortSignal.timeout(4_000)]),
          );
          slack = {
            id: "slack",
            name: "Slack",
            status: "connected",
            detail: `Connected to ${where} as @${auth.user}; the bot token works.${reports}`,
            gives: SLACK_GIVES,
            canBeConnectedNow: true,
          };
        } catch (error) {
          slack = {
            id: "slack",
            name: "Slack",
            status: "error",
            detail: `Saved as connected to ${where}, but Slack refused the check: ${message(error)}`,
            gives: SLACK_GIVES,
            canBeConnectedNow: true,
            connectAt: "/home/connections",
          };
        }
    }

    const telegram: Connection = saved.some((c) => c.provider === "telegram")
      ? {
          id: "telegram",
          name: "Telegram",
          status: "error",
          detail:
            "Saved as connected, but Telegram reports are not built yet, so nothing is sent.",
          canBeConnectedNow: false,
        }
      : {
          id: "telegram",
          name: "Telegram",
          status: "not_connected",
          detail: "Not connected.",
          gives: "Rox's report after every run, as a Telegram message",
          canBeConnectedNow: false,
          note: "Connecting this app is not built yet.",
        };

    return {
      connections: [
        github,
        slack,
        telegram,
        ...NOT_BUILT.map(
          (app): Connection => ({
            id: app.id,
            name: app.name,
            status: isDemo ? "test_mode" : "not_connected",
            detail: isDemo
              ? "Runs in test mode in Quick Judge Mode."
              : "Not connected.",
            gives: app.gives,
            canBeConnectedNow: false,
            note: "Connecting this app is not built yet.",
          }),
        ),
      ],
      reportTo,
    };
  },
  summarize(output) {
    const list = (output as { connections: { status: Status }[] }).connections;
    const connected = list.filter((c) => c.status === "connected").length;
    const errors = list.filter((c) => c.status === "error").length;
    return `${connected} of ${list.length} connected${errors ? `, ${errors} with an error` : ""}`;
  },
});
