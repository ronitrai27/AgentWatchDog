// Standalone Slack Web API adapter for Rox.
// Intentionally decoupled from the LangGraph agent so inbound mentions and outbound fix
// reports can be tested independently before wiring into agent runs.

export type SlackBlock = Record<string, unknown>;

export type SlackAuthInfo = {
  team: string;
  teamId: string;
  user: string;
  userId: string;
  botId: string | null;
};

export type SlackChannelSummary = {
  id: string;
  name: string;
  isPrivate: boolean;
};

export type SlackPostInput = {
  /** Defaults to SLACK_REPORT_CHANNEL_ID when omitted. */
  channel?: string;
  /** Required plain-text summary for notifications and screen readers. */
  text: string;
  threadTs?: string;
  blocks?: SlackBlock[];
  signal?: AbortSignal;
};

export type SlackPostResult = {
  channel: string;
  ts: string;
};

export type FixReportStatus = "pr_opened" | "escalated" | "stopped";

export type FixReportInput = {
  repo: string;
  status: FixReportStatus;
  summary: string;
  rootCause: string;
  checksPassed?: string[];
  prNumber?: number;
  prUrl?: string;
  costUsd?: number;
  channel?: string;
  threadTs?: string;
  signal?: AbortSignal;
};

export interface SlackClient {
  authTest(signal?: AbortSignal): Promise<SlackAuthInfo>;
  listJoinedChannels(signal?: AbortSignal): Promise<SlackChannelSummary[]>;
  postMessage(input: SlackPostInput): Promise<SlackPostResult>;
  replyInThread(input: {
    channel: string;
    threadTs: string;
    text: string;
    blocks?: SlackBlock[];
    signal?: AbortSignal;
  }): Promise<SlackPostResult>;
  addReaction(input: {
    channel: string;
    timestamp: string;
    name: string;
    signal?: AbortSignal;
  }): Promise<void>;
  postFixReport(input: FixReportInput): Promise<SlackPostResult>;
}

type SlackClientOptions = {
  botToken: string;
  defaultChannelId?: string;
  fetch?: typeof fetch;
  apiBase?: string;
};

export class SlackApiError extends Error {
  readonly code: string;
  constructor(method: string, code: string) {
    super(`Slack ${method} failed: ${code}`);
    this.name = "SlackApiError";
    this.code = code;
  }
}

/** Escapes untrusted strings before embedding in Slack mrkdwn so `<url>` or `<!here>` cannot inject mentions/links. */
export function escapeSlackMrkdwn(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const ALLOWED_PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

const STATUS_HEADLINE: Record<FixReportStatus, string> = {
  pr_opened: "Fix verified and pull request opened",
  escalated: "Investigation paused for human review",
  stopped: "Run stopped safely without opening a PR",
};

/**
 * Zone 3 fixed-template payload builder for post-fix reports.
 * Untrusted error/code strings are escaped and cannot choose arbitrary link targets or channels.
 */
export function buildFixReportPayload(input: FixReportInput): {
  text: string;
  blocks: SlackBlock[];
} {
  const headline = `${STATUS_HEADLINE[input.status]}: ${input.repo}`;
  const safeRepo = escapeSlackMrkdwn(input.repo);
  const safeSummary = escapeSlackMrkdwn(input.summary);
  const safeCause = escapeSlackMrkdwn(input.rootCause);
  const checks =
    input.checksPassed && input.checksPassed.length > 0
      ? input.checksPassed.map((c) => `\`${escapeSlackMrkdwn(c)}\``).join(", ")
      : "none";

  const contextParts = [`*Repo:* \`${safeRepo}\``, `*Checks:* ${checks}`];
  if (typeof input.costUsd === "number") {
    contextParts.push(`*Run cost:* $${input.costUsd.toFixed(4)}`);
  }

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: headline.slice(0, 150),
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Summary:* ${safeSummary}\n*Root cause:* ${safeCause}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: contextParts.join(" · "),
        },
      ],
    },
  ];

  if (input.prUrl && ALLOWED_PR_URL.test(input.prUrl)) {
    const label = input.prNumber
      ? `View PR #${input.prNumber}`
      : "View Pull Request";
    blocks.push({
      type: "actions",
      block_id: "rox_fix_report_actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: label },
          style: "primary",
          url: input.prUrl,
          action_id: "rox_open_pr_btn",
        },
      ],
    });
  }

  return { text: headline, blocks };
}

export function slackFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SlackClient | null {
  const botToken = env.SLACK_BOT_TOKEN?.trim();
  if (!botToken) return null;
  return createSlackClient({
    botToken,
    defaultChannelId: env.SLACK_REPORT_CHANNEL_ID?.trim() || undefined,
  });
}

export function createSlackClient(options: SlackClientOptions): SlackClient {
  const fetchImpl = options.fetch ?? fetch;
  const base = options.apiBase ?? "https://slack.com/api";

  async function call<T extends { ok: boolean; error?: string }>(
    method: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await fetchImpl(`${base}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.botToken}`,
        "content-type": "application/json; charset=utf-8",
        "user-agent": "rox-slack-adapter",
      },
      body: JSON.stringify(body ?? {}),
      signal,
    });
    if (!res.ok) {
      throw new SlackApiError(method, `http_${res.status}`);
    }
    const data = (await res.json()) as T;
    if (!data.ok) {
      throw new SlackApiError(method, data.error ?? "unknown_error");
    }
    return data;
  }

  return {
    async authTest(signal) {
      const data = await call<{
        ok: boolean;
        team: string;
        team_id: string;
        user: string;
        user_id: string;
        bot_id?: string;
      }>("auth.test", {}, signal);
      return {
        team: data.team,
        teamId: data.team_id,
        user: data.user,
        userId: data.user_id,
        botId: data.bot_id ?? null,
      };
    },

    async listJoinedChannels(signal) {
      const data = await call<{
        ok: boolean;
        channels?: { id: string; name: string; is_private?: boolean }[];
      }>(
        "users.conversations",
        {
          types: "public_channel,private_channel",
          exclude_archived: true,
          limit: 100,
        },
        signal,
      );
      return (data.channels ?? []).map((ch) => ({
        id: ch.id,
        name: ch.name,
        isPrivate: Boolean(ch.is_private),
      }));
    },

    async postMessage(input) {
      const channel = input.channel ?? options.defaultChannelId;
      if (!channel) {
        throw new SlackApiError("chat.postMessage", "missing_channel");
      }
      const data = await call<{
        ok: boolean;
        channel: string;
        ts: string;
      }>(
        "chat.postMessage",
        {
          channel,
          text: input.text,
          ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
          ...(input.blocks ? { blocks: input.blocks } : {}),
        },
        input.signal,
      );
      return { channel: data.channel, ts: data.ts };
    },

    async replyInThread(input) {
      return this.postMessage({
        channel: input.channel,
        threadTs: input.threadTs,
        text: input.text,
        blocks: input.blocks,
        signal: input.signal,
      });
    },

    async addReaction(input) {
      try {
        await call(
          "reactions.add",
          {
            channel: input.channel,
            timestamp: input.timestamp,
            name: input.name,
          },
          input.signal,
        );
      } catch (err) {
        if (err instanceof SlackApiError && err.code === "already_reacted") {
          return;
        }
        throw err;
      }
    },

    async postFixReport(input) {
      const payload = buildFixReportPayload(input);
      return this.postMessage({
        channel: input.channel ?? options.defaultChannelId,
        threadTs: input.threadTs,
        text: payload.text,
        blocks: payload.blocks,
        signal: input.signal,
      });
    },
  };
}
