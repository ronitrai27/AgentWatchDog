// Tools about the apps Rox can listen to or report to. Every status here is real: GitHub and Sentry
// from the setup, Slack from the user's saved connection plus a live check of the bot token. Nothing is
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

const SLACK_GIVES =
  "Rox's report after every run: what failed, the cause, the fix and the pull request";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const connectionsList = defineTool({
  name: "connections_list",
  group: "connections",
  description:
    "Reads the user's connections from the database right now (GitHub, Slack, Sentry; Telegram only when saved): connected, not connected, or an error with the exact reason. Slack is also checked live against Slack. " +
    "Call it every time the user asks what Rox is connected to, what Rox can see or do, or before recommending a connection. The user can connect or disconnect at any moment, so never answer from an earlier call.",
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

    // Read from the database on every call, so a connect or disconnect shows at once.
    const SENTRY_GIVES =
      "wakes Rox on a new issue, an error spike or a regression, with the stack trace";
    const sentryOn = (setup.triggers ?? []).filter((t) =>
      t.startsWith("sentry:"),
    );
    const sentry: Connection = setup.sentry
      ? {
          id: "sentry",
          name: "Sentry",
          status: "connected",
          detail: `Connected to project ${setup.sentry.project} in ${setup.sentry.org}. Triggers on: ${sentryOn.length ? sentryOn.map((t) => t.replace("sentry:", "")).join(", ") : "none (turn them on in Settings > Workflow)"}.`,
          gives: SENTRY_GIVES,
          canBeConnectedNow: true,
        }
      : {
          id: "sentry",
          name: "Sentry",
          status: "not_connected",
          detail: "Not connected.",
          gives: SENTRY_GIVES,
          canBeConnectedNow: true,
          connectAt: "/home/connections",
        };

    // Telegram reports are not built: it appears only when a saved row says the user connected it.
    const telegram: Connection[] = saved.some((c) => c.provider === "telegram")
      ? [
          {
            id: "telegram",
            name: "Telegram",
            status: "error",
            detail:
              "Saved as connected, but Telegram reports are not built yet, so nothing is sent.",
            canBeConnectedNow: false,
          },
        ]
      : [];

    return {
      connections: [github, slack, sentry, ...telegram],
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
