// Starts a local Temporal Service for development. Local only:
//   - bound to 127.0.0.1, never reachable from the network
//   - state kept in .temporal/temporal.db, so workflows survive a restart
//     (without --db-filename the dev server keeps everything in memory)
// GRPC: 127.0.0.1:7233   Web UI: http://127.0.0.1:8233
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { root } from "./lib.mjs";

const dataDir = path.join(root, ".temporal");
mkdirSync(dataDir, { recursive: true });

const args = [
  "server",
  "start-dev",
  "--ip",
  "127.0.0.1",
  "--port",
  "7233",
  "--ui-ip",
  "127.0.0.1",
  "--ui-port",
  "8233",
  "--db-filename",
  path.join(dataDir, "temporal.db"),
];

console.log("Temporal dev server (local only)");
console.log("  gRPC  127.0.0.1:7233");
console.log("  UI    http://127.0.0.1:8233");
console.log("  data  .temporal/temporal.db");
console.log("Press Ctrl+C to stop.\n");

const child = spawn("temporal", args, { stdio: "inherit" });

child.on("error", (error) => {
  if (error.code === "ENOENT") {
    console.error(
      "The temporal CLI was not found on PATH.\n" +
        "Download it from https://temporal.download/cli/archive/latest?platform=windows&arch=amd64,\n" +
        "extract it and add temporal.exe to PATH.",
    );
  } else {
    console.error(error.message);
  }
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 0));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
