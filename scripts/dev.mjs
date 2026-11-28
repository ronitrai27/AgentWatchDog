// pnpm dev: starts the web app, which also runs Rox's agent, and the webhook relay that brings
// GitHub's events from SMEE_URL to this machine. Ctrl+C stops both.
import { spawn } from "node:child_process";
import path from "node:path";
import { root } from "./lib.mjs";

const children = [];
let stopping = false;

function start(name, script, args) {
  const child = spawn(process.execPath, [path.join(root, script), ...args], {
    cwd: root,
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    if (stopping) return;
    console.log(
      `[dev] ${name} stopped (code ${code ?? "?"}); stopping the rest`,
    );
    stop(code ?? 1);
  });
  children.push(child);
}

function stop(code = 0) {
  stopping = true;
  for (const child of children) child.kill();
  setTimeout(() => process.exit(code), 300);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

start("web", "node_modules/next/dist/bin/next", ["dev"]);

const relay = process.env.SMEE_URL;
if (relay) {
  const target = `${process.env.APP_URL ?? "http://localhost:3000"}/api/webhooks/github`;
  console.log(`[dev] GitHub events: ${relay} -> ${target}`);
  start("webhook relay", "node_modules/smee-client/bin/smee.js", [
    "--url",
    relay,
    "--target",
    target,
  ]);
} else {
  console.log("[dev] SMEE_URL is not set, so GitHub events will not arrive.");
}

// Sentry's webhooks come through their own relay channel.
const sentryRelay = process.env.SENTRY_SMEE_URL;
if (sentryRelay) {
  const target = `${process.env.APP_URL ?? "http://localhost:3000"}/api/webhooks/sentry`;
  console.log(`[dev] Sentry events: ${sentryRelay} -> ${target}`);
  start("sentry relay", "node_modules/smee-client/bin/smee.js", [
    "--url",
    sentryRelay,
    "--target",
    target,
  ]);
} else {
  console.log(
    "[dev] SENTRY_SMEE_URL is not set, so Sentry events will not arrive.",
  );
}

const betterstackRelay = process.env.BETTERSTACK_SMEE_URL;
if (betterstackRelay) {
  const target = `${process.env.APP_URL ?? "http://localhost:3000"}/api/webhooks/betterstack`;
  console.log(`[dev] Better Stack events: ${betterstackRelay} -> ${target}`);
  start("betterstack relay", "node_modules/smee-client/bin/smee.js", [
    "--url",
    betterstackRelay,
    "--target",
    target,
  ]);
} else {
  console.log(
    "[dev] BETTERSTACK_SMEE_URL is not set, so Better Stack events will not arrive.",
  );
}
