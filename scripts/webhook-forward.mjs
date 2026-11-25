// Dev only: the GitHub App sends its webhooks to SMEE_URL (a public relay). This command
// forwards them from there to this machine.   pnpm webhooks:dev
import { spawn } from "node:child_process";
import { need } from "./lib.mjs";

const target = `${process.env.APP_URL ?? "http://localhost:3000"}/api/webhooks/github`;
console.log(`Forwarding ${need("SMEE_URL")} -> ${target}`);

const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["--yes", "smee-client", "--url", need("SMEE_URL"), "--target", target],
  { stdio: "inherit", shell: process.platform === "win32" },
);
child.on("exit", (code) => process.exit(code ?? 0));
