import {
  buildFixReportPayload,
  type FixReportInput,
  slackFromEnv,
} from "@agent/integrations/slack";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const SAMPLE_REPORT: FixReportInput = {
  repo: "ronitrai27/Testing_SRE_Demo_App",
  status: "pr_opened",
  summary:
    "Fixed null pointer crash in coupon discount calculation and added regression test.",
  rootCause:
    "applyCoupon() dereferenced cart.discountCode before checking undefined.",
  checksPassed: ["biome", "tsc", "vitest (5/5)", "semgrep", "gitleaks"],
  prNumber: 42,
  prUrl: "https://github.com/ronitrai27/Testing_SRE_Demo_App/pull/42",
  costUsd: 0.0184,
};

/**
 * GET /api/slack/test
 * Inspects Slack adapter readiness, verifies SLACK_BOT_TOKEN if set, lists channels @rox is
 * invited to, and previews the Zone 3 Fix Report Block Kit card.
 */
export async function GET() {
  const client = slackFromEnv();
  const preview = buildFixReportPayload(SAMPLE_REPORT);

  if (!client) {
    return NextResponse.json({
      ok: true,
      mode: "dry_run",
      note: "Credentials saved! Add SLACK_BOT_TOKEN (xoxb-...) from Slack App -> OAuth & Permissions to post live messages.",
      configured: {
        appId: process.env.SLACK_APP_ID ?? null,
        clientId: Boolean(process.env.SLACK_CLIENT_ID),
        clientSecret: Boolean(process.env.SLACK_CLIENT_SECRET),
        signingSecret: Boolean(process.env.SLACK_SIGNING_SECRET),
        botToken: false,
        appToken: Boolean(process.env.SLACK_APP_TOKEN),
        reportChannelId: process.env.SLACK_REPORT_CHANNEL_ID || null,
      },
      sampleFixReportPayload: preview,
    });
  }

  try {
    const [auth, joinedChannels] = await Promise.all([
      client.authTest(),
      client.listJoinedChannels(),
    ]);
    return NextResponse.json({
      ok: true,
      mode: "live",
      auth,
      joinedChannels,
      reportChannelId:
        process.env.SLACK_REPORT_CHANNEL_ID || joinedChannels[0]?.id || null,
      sampleFixReportPayload: preview,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}

/**
 * POST /api/slack/test
 * Body (optional): { "kind": "fix_report" | "ping", "channel": "C...", "text": "..." }
 * Sends a real message or sample Fix Report card to Slack (or returns a dry-run preview if
 * SLACK_BOT_TOKEN is not yet filled in).
 */
export async function POST(request: Request) {
  let body: {
    kind?: "fix_report" | "ping";
    channel?: string;
    text?: string;
  } = {};
  try {
    const raw = await request.text();
    if (raw) body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const kind = body.kind ?? "fix_report";
  const client = slackFromEnv();

  if (!client) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      reason:
        "SLACK_BOT_TOKEN (xoxb-...) is empty in .env — returning dry-run payload without calling Slack.",
      kind,
      payload:
        kind === "ping"
          ? { text: body.text ?? "Hello from Rox Slack adapter!" }
          : buildFixReportPayload(SAMPLE_REPORT),
    });
  }

  try {
    let channel =
      body.channel?.trim() || process.env.SLACK_REPORT_CHANNEL_ID?.trim();
    if (!channel) {
      const joined = await client.listJoinedChannels();
      channel = joined[0]?.id;
    }
    if (!channel) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "No target channel found. Invite @rox to a Slack channel (`/invite @rox`) or set SLACK_REPORT_CHANNEL_ID in .env.",
        },
        { status: 400 },
      );
    }

    const sent =
      kind === "ping"
        ? await client.postMessage({
            channel,
            text:
              body.text ??
              "Rox Slack adapter connected! (Agent is not wired yet.)",
          })
        : await client.postFixReport({ ...SAMPLE_REPORT, channel });

    return NextResponse.json({
      ok: true,
      dryRun: false,
      kind,
      sent,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
