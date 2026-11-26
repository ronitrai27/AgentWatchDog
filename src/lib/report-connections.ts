// The apps Rox sends its final report to (Slack now, Telegram later). The tokens live in .env on
// the server and never reach the browser: a connection row only records that the user connected
// the app and which channel gets the report. user_setup.report_to picks the app.
import { slackFromEnv } from "@agent/integrations/slack";
import { withUser } from "./db";

export type ReportProvider = "slack" | "telegram";

export type ReportConnection = {
  provider: ReportProvider;
  workspace: string | null;
  botUser: string | null;
  channelId: string;
  channelName: string | null;
  connectedAt: string;
};

/** Where a run's final report goes; handed to the run when it starts. */
export type ReportTarget = {
  to: ReportProvider;
  channel: string;
  channelName: string | null;
};

/** The Slack settings in .env. Only the bot token is needed to post; the rest is shown. */
const SLACK_KEYS = [
  ["SLACK_BOT_TOKEN", "Bot token (posts the reports)", true],
  ["SLACK_SIGNING_SECRET", "Signing secret (checks Slack's requests)", false],
  ["SLACK_APP_ID", "App id", false],
  ["SLACK_CLIENT_ID", "Client id", false],
  ["SLACK_CLIENT_SECRET", "Client secret", false],
  ["SLACK_APP_TOKEN", "App-level token", false],
] as const;

export type SlackCheck = {
  keys: { name: string; label: string; found: boolean; required: boolean }[];
  /** auth.test answered: the token works. */
  ready: boolean;
  workspace: string | null;
  botUser: string | null;
  workspaceId: string | null;
  /** Channels the bot was invited to; the report can only go to one of these. */
  channels: { id: string; name: string; isPrivate: boolean }[];
  error: string | null;
};

/** Checks the tokens in .env against Slack itself. Never returns a token. */
export async function checkSlack(): Promise<SlackCheck> {
  const keys = SLACK_KEYS.map(([name, label, required]) => ({
    name,
    label,
    required,
    found: Boolean(process.env[name]?.trim()),
  }));
  const empty = {
    keys,
    ready: false,
    workspace: null,
    botUser: null,
    workspaceId: null,
    channels: [],
  };
  const client = slackFromEnv();
  if (!client)
    return { ...empty, error: "SLACK_BOT_TOKEN is not set in .env." };
  try {
    const signal = AbortSignal.timeout(8000);
    const [auth, channels] = await Promise.all([
      client.authTest(signal),
      client.listJoinedChannels(signal),
    ]);
    return {
      keys,
      ready: true,
      workspace: auth.team,
      workspaceId: auth.teamId,
      botUser: auth.user,
      channels,
      error: channels.length
        ? null
        : "The bot is not in any channel yet. In Slack, type /invite @rox in the channel for reports, then check again.",
    };
  } catch (error) {
    return {
      ...empty,
      error: `Slack refused the bot token: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

type Row = {
  provider: ReportProvider;
  workspace: string | null;
  bot_user: string | null;
  channel_id: string;
  channel_name: string | null;
  connected_at: Date;
};

export async function getReportConnections(userId: string): Promise<{
  connections: ReportConnection[];
  reportTo: ReportProvider | null;
}> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<Row>(
      `SELECT provider, workspace, bot_user, channel_id, channel_name, connected_at
         FROM report_connections WHERE user_id = $1`,
      [userId],
    );
    const setup = await c.query<{ report_to: ReportProvider | null }>(
      "SELECT report_to FROM user_setup WHERE user_id = $1",
      [userId],
    );
    return {
      connections: rows.map((r) => ({
        provider: r.provider,
        workspace: r.workspace,
        botUser: r.bot_user,
        channelId: r.channel_id,
        channelName: r.channel_name,
        connectedAt: r.connected_at.toISOString(),
      })),
      reportTo: setup.rows[0]?.report_to ?? null,
    };
  });
}

/** Saves the Slack connection and, when no app was chosen yet, sends reports to Slack. */
export async function saveSlackConnection(
  userId: string,
  c: {
    workspace: string | null;
    workspaceId: string | null;
    botUser: string | null;
    channelId: string;
    channelName: string;
  },
) {
  await withUser(userId, async (client) => {
    await client.query(
      `INSERT INTO report_connections
         (user_id, provider, workspace, workspace_id, bot_user, channel_id, channel_name)
       VALUES ($1, 'slack', $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, provider) DO UPDATE
         SET workspace = EXCLUDED.workspace, workspace_id = EXCLUDED.workspace_id,
             bot_user = EXCLUDED.bot_user, channel_id = EXCLUDED.channel_id,
             channel_name = EXCLUDED.channel_name, connected_at = now()`,
      [
        userId,
        c.workspace,
        c.workspaceId,
        c.botUser,
        c.channelId,
        c.channelName,
      ],
    );
    await client.query(
      `INSERT INTO user_setup (user_id, report_to) VALUES ($1, 'slack')
       ON CONFLICT (user_id) DO UPDATE SET report_to = coalesce(user_setup.report_to, 'slack')`,
      [userId],
    );
  });
}

export async function removeReportConnection(
  userId: string,
  provider: ReportProvider,
) {
  await withUser(userId, async (client) => {
    await client.query(
      "DELETE FROM report_connections WHERE user_id = $1 AND provider = $2",
      [userId, provider],
    );
    await client.query(
      "UPDATE user_setup SET report_to = NULL WHERE user_id = $1 AND report_to = $2",
      [userId, provider],
    );
  });
}

/** Chooses which connected app gets the final report (null: none). */
export async function setReportTo(
  userId: string,
  provider: ReportProvider | null,
) {
  await withUser(userId, (client) =>
    client.query("UPDATE user_setup SET report_to = $2 WHERE user_id = $1", [
      userId,
      provider,
    ]),
  );
}

/** Where this user's run reports go, or null when they chose none or it is not connected. */
export async function reportTarget(
  userId: string,
): Promise<ReportTarget | null> {
  const { connections, reportTo } = await getReportConnections(userId);
  const c = connections.find((x) => x.provider === reportTo);
  return c
    ? { to: c.provider, channel: c.channelId, channelName: c.channelName }
    : null;
}
