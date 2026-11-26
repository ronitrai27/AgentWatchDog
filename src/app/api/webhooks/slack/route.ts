import { slackFromEnv } from "@agent/integrations/slack";
import { NextResponse } from "next/server";
import { decideSlackEvent, validSlackSignature } from "@/lib/slack-webhook";

export const dynamic = "force-dynamic";

/** Quick readiness check for the Slack webhook endpoint. */
export async function GET() {
  return NextResponse.json({
    ok: true,
    adapter: "slack-webhook",
    agentWired: false,
    configured: {
      appId: process.env.SLACK_APP_ID ?? null,
      signingSecret: Boolean(process.env.SLACK_SIGNING_SECRET),
      botToken: Boolean(process.env.SLACK_BOT_TOKEN),
      appToken: Boolean(process.env.SLACK_APP_TOKEN),
      reportChannelId: process.env.SLACK_REPORT_CHANNEL_ID || null,
    },
  });
}

/**
 * Receives signed Slack Events API requests (`url_verification`, `app_mention`, `message.im`).
 * Agent execution is intentionally NOT wired yet: mentions are verified, logged, and (when
 * SLACK_BOT_TOKEN is present) acknowledged in-thread with a basic adapter echo.
 */
export async function POST(request: Request) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }

  const body = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature");

  if (!validSlackSignature(body, timestamp, signature, signingSecret)) {
    console.warn(
      "[slack] REJECTED webhook: invalid or expired x-slack-signature",
    );
    return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  }

  // Ignore Slack's automatic HTTP retries so we never reply twice.
  const retryNum = request.headers.get("x-slack-retry-num");
  if (retryNum) {
    return NextResponse.json({ ok: true, duplicateRetry: Number(retryNum) });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const decision = decideSlackEvent(payload);

  if (decision.kind === "url_verification") {
    console.log("[slack] url_verification challenge echoed");
    return NextResponse.json({ challenge: decision.challenge });
  }

  if (decision.kind === "ignored") {
    console.log(`[slack] ignored: ${decision.why}`);
    return NextResponse.json({ ok: true, listened: false, why: decision.why });
  }

  console.log(
    [
      `[slack] ${decision.source}  event=${decision.eventId}`,
      `  channel       ${decision.channel}`,
      `  user          ${decision.user}`,
      `  thread_ts     ${decision.threadTs}`,
      `  prompt        ${decision.prompt || "(empty)"}`,
      "  agent         not wired yet (adapter-only mode)",
    ].join("\n"),
  );

  const client = slackFromEnv();
  if (client) {
    // Fire-and-forget acknowledgement so Slack gets a 200 within its 3-second deadline.
    void (async () => {
      try {
        await client.addReaction({
          channel: decision.channel,
          timestamp: decision.ts,
          name: "eyes",
        });
        await client.replyInThread({
          channel: decision.channel,
          threadTs: decision.threadTs,
          text: `Rox Slack adapter connected! Heard <@${decision.user}> say: "${decision.prompt || "hello"}" (Agent wiring is disabled for now.)`,
        });
      } catch (err) {
        console.error(
          `[slack] could not send stub reply: ${err instanceof Error ? err.message : err}`,
        );
      }
    })();
  }

  return NextResponse.json(
    {
      ok: true,
      listened: true,
      source: decision.source,
      eventId: decision.eventId,
      channel: decision.channel,
      user: decision.user,
      prompt: decision.prompt,
      repliedViaBotToken: Boolean(client),
    },
    { status: 202 },
  );
}
