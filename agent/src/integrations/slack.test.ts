import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  decideSlackEvent,
  stripBotMentions,
  validSlackSignature,
} from "../../../src/lib/slack-webhook";
import {
  buildFixReportPayload,
  createSlackClient,
  escapeSlackMrkdwn,
  SlackApiError,
} from "./slack";

describe("Slack adapter (standalone, no agent wiring)", () => {
  it("escapes untrusted mrkdwn characters and blocks non-GitHub PR URLs", () => {
    assert.equal(
      escapeSlackMrkdwn("<!channel> <https://evil.example|click> & more"),
      "&lt;!channel&gt; &lt;https://evil.example|click&gt; &amp; more",
    );

    const poisoned = buildFixReportPayload({
      repo: "org/repo",
      status: "pr_opened",
      summary: "Fixed <!here> bug",
      rootCause: "Bad <script> input",
      prUrl: "https://evil.example/steal",
      prNumber: 9,
    });
    assert.equal(
      poisoned.blocks.some((b) => b.type === "actions"),
      false,
      "non-GitHub PR URL must never render an action button",
    );

    const clean = buildFixReportPayload({
      repo: "ronitrai27/Testing_SRE_Demo_App",
      status: "pr_opened",
      summary: "Fixed null check",
      rootCause: "Missing guard",
      checksPassed: ["biome", "vitest"],
      prUrl: "https://github.com/ronitrai27/Testing_SRE_Demo_App/pull/42",
      prNumber: 42,
      costUsd: 0.0123,
    });
    assert.equal(clean.blocks.length, 4);
    assert.equal(clean.blocks[3]?.type, "actions");
  });

  it("posts messages, thread replies, and ignores already_reacted", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const client = createSlackClient({
      botToken: "xoxb-test-token",
      defaultChannelId: "C0DEFAULT",
      apiBase: "https://slack.test/api",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        const body = JSON.parse(String(init?.body ?? "{}"));
        calls.push({ url: u, body });
        if (u.endsWith("/reactions.add")) {
          return new Response(
            JSON.stringify({ ok: false, error: "already_reacted" }),
          );
        }
        return new Response(
          JSON.stringify({ ok: true, channel: "C0DEFAULT", ts: "123.456" }),
        );
      }) as typeof fetch,
    });

    await client.addReaction({
      channel: "C0DEFAULT",
      timestamp: "123.000",
      name: "eyes",
    });
    const res = await client.postFixReport({
      repo: "org/repo",
      status: "pr_opened",
      summary: "Fixed crash",
      rootCause: "Undefined prop",
    });

    assert.equal(res.channel, "C0DEFAULT");
    assert.equal(res.ts, "123.456");
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.body.channel, "C0DEFAULT");

    const noDefault = createSlackClient({
      botToken: "xoxb-test",
      fetch: (async () =>
        new Response(JSON.stringify({ ok: true }))) as typeof fetch,
    });
    await assert.rejects(
      () => noDefault.postMessage({ text: "hi" }),
      SlackApiError,
    );
  });
});

describe("Slack webhook verification & event parser", () => {
  const secret = "dad5bb9edb19290314a483df983d19a1";

  it("verifies valid HMAC-SHA256 signatures and rejects stale/forged ones", () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc" });
    const now = 1_764_160_000;
    const sig = `v0=${createHmac("sha256", secret).update(`v0:${now}:${body}`).digest("hex")}`;

    assert.equal(
      validSlackSignature(body, String(now), sig, secret, now),
      true,
    );
    assert.equal(
      validSlackSignature(body, String(now - 600), sig, secret, now),
      false,
    );
    assert.equal(
      validSlackSignature(body, String(now), "v0=deadbeef", secret, now),
      false,
    );
  });

  it("parses url_verification, @rox mentions, DMs, and ignores bot loops", () => {
    assert.equal(
      stripBotMentions("<@U0ROX> hello, what are latest PRs?"),
      "hello, what are latest PRs?",
    );

    const verify = decideSlackEvent({
      type: "url_verification",
      challenge: "xyz",
    });
    assert.deepEqual(verify, { kind: "url_verification", challenge: "xyz" });

    const mention = decideSlackEvent({
      type: "event_callback",
      event_id: "Ev1",
      team_id: "T1",
      event: {
        type: "app_mention",
        user: "U123",
        channel: "C456",
        text: "<@U0ROX> what are latest PRs?",
        ts: "100.1",
      },
    });
    assert.equal(mention.kind, "trigger");
    if (mention.kind === "trigger") {
      assert.equal(mention.source, "app_mention");
      assert.equal(mention.prompt, "what are latest PRs?");
      assert.equal(mention.threadTs, "100.1");
    }

    const botLoop = decideSlackEvent({
      type: "event_callback",
      event: {
        type: "app_mention",
        bot_id: "B999",
        user: "U0ROX",
        channel: "C456",
        text: "<@U0ROX> echo",
        ts: "100.2",
      },
    });
    assert.equal(botLoop.kind, "ignored");
  });
});
