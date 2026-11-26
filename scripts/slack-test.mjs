// Sends signed sample Slack events to /api/webhooks/slack and exercises /api/slack/test,
// plus optional Socket Mode listener when SLACK_APP_TOKEN (xapp-...) is set!
//   pnpm slack:test           -> tests signed webhook + /api/slack/test route
//   pnpm slack:socket         -> listens for live @rox mentions in Slack via Socket Mode (no ngrok!)
import { createHmac } from "node:crypto";
import { need } from "./lib.mjs";

const appUrl = process.env.APP_URL ?? "http://localhost:3000";
const webhookUrl = `${appUrl}/api/webhooks/slack`;
const testRouteUrl = `${appUrl}/api/slack/test`;

const SCENARIOS = {
  "url-verify": {
    type: "url_verification",
    token: "verification-token",
    challenge: "rox_challenge_ok_2027",
  },
  mention: {
    type: "event_callback",
    team_id: "T0ROX2027",
    event_id: "Ev01MENTIONTEST",
    event: {
      type: "app_mention",
      user: "U01DEVUSER",
      channel: process.env.SLACK_REPORT_CHANNEL_ID || "C01TESTCHAN",
      text: "<@U0ROXBOT> hello, what are latest PRs?",
      ts: "1764160000.000100",
    },
  },
  dm: {
    type: "event_callback",
    team_id: "T0ROX2027",
    event_id: "Ev01DMTEST",
    event: {
      type: "message",
      channel_type: "im",
      user: "U01DEVUSER",
      channel: "D01DMTEST",
      text: "status of last fix?",
      ts: "1764160005.000200",
    },
  },
  "bot-loop": {
    type: "event_callback",
    team_id: "T0ROX2027",
    event_id: "Ev01BOTLOOP",
    event: {
      type: "app_mention",
      bot_id: "B0ROXSELF",
      user: "U0ROXBOT",
      channel: "C01TESTCHAN",
      text: "<@U0ROXBOT> my own message",
      ts: "1764160010.000300",
    },
  },
};

function signSlack(body, timestamp, secret) {
  const digest = createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  return `v0=${digest}`;
}

async function sendSigned(name, payload, secretOverride) {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = signSlack(
    body,
    ts,
    secretOverride ?? need("SLACK_SIGNING_SECRET"),
  );
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sig,
    },
    body,
  });
  console.log(`${name.padEnd(14)} -> ${res.status} ${await res.text()}`);
}

async function runHttpTests() {
  console.log(`\n1. Testing signed Slack webhook (${webhookUrl})`);
  for (const [name, payload] of Object.entries(SCENARIOS)) {
    await sendSigned(name, payload);
  }
  await sendSigned("bad-signature", SCENARIOS.mention, "wrong_signing_secret");

  console.log(`\n2. Testing Slack adapter test route (${testRouteUrl})`);
  const statusRes = await fetch(testRouteUrl);
  console.log(`GET  /api/slack/test -> ${statusRes.status}`);
  console.log(await statusRes.text());

  const postRes = await fetch(testRouteUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "fix_report" }),
  });
  console.log(`\nPOST /api/slack/test -> ${postRes.status}`);
  console.log(await postRes.text());
}

async function runSocketMode() {
  const appToken = need("SLACK_APP_TOKEN");
  const botToken = need("SLACK_BOT_TOKEN");

  const openRes = await fetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: { authorization: `Bearer ${appToken}` },
  });
  const opened = await openRes.json();
  if (!opened.ok || !opened.url) {
    console.error("Failed to open Slack Socket Mode connection:", opened);
    process.exit(1);
  }

  console.log("[slack:socket] Connecting to Slack Socket Mode...");
  const ws = new WebSocket(opened.url);

  ws.addEventListener("open", () => {
    console.log(
      "[slack:socket] Connected! Tag @rox in a channel where it is invited (Ctrl+C to stop).",
    );
  });

  ws.addEventListener("message", async (msg) => {
    const envelope = JSON.parse(String(msg.data));
    if (envelope.envelope_id) {
      ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }
    if (envelope.type !== "events_api") return;
    const ev = envelope.payload?.event;
    if (!ev || ev.bot_id || ev.subtype) return;

    if (
      ev.type === "app_mention" ||
      (ev.type === "message" && ev.channel_type === "im")
    ) {
      const prompt = String(ev.text ?? "")
        .replace(/^(?:<@[A-Z0-9]+>\s*)+/i, "")
        .trim();
      console.log(
        `[slack:socket] Heard from ${ev.user} in ${ev.channel}: "${prompt}"`,
      );
      await fetch("https://slack.com/api/reactions.add", {
        method: "POST",
        headers: {
          authorization: `Bearer ${botToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel: ev.channel,
          timestamp: ev.ts,
          name: "eyes",
        }),
      });
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          authorization: `Bearer ${botToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel: ev.channel,
          thread_ts: ev.thread_ts ?? ev.ts,
          text: `Rox Slack adapter connected! Heard <@${ev.user}> say: "${prompt || "hello"}" (Agent is not wired yet.)`,
        }),
      });
    }
  });

  ws.addEventListener("close", () => {
    console.log("[slack:socket] Connection closed.");
  });
}

if (process.argv.includes("--socket")) {
  await runSocketMode();
} else {
  await runHttpTests();
}
