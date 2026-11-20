// Shared helpers for the database scripts.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

try {
  process.loadEnvFile(path.join(root, ".env"));
} catch {
  // No .env file: rely on the real environment.
}

export function need(name) {
  const value = process.env[name];
  if (!value) {
    console.error(
      `${name} is not set. Copy .env.example to .env and fill it in.`,
    );
    process.exit(1);
  }
  return value;
}

/** Runs a command inside the db container. Returns the child process. */
export function dockerExec(args, options = {}) {
  return spawn("docker", ["compose", "exec", "-T", "db", ...args], {
    cwd: root,
    stdio: options.stdio ?? ["pipe", "pipe", "pipe"],
  });
}

export function waitForExit(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}
