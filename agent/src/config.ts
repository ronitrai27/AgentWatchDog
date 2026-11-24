// Settings for the agent. It runs inside the Next.js server, which has already loaded .env;
// tests and scripts started from agent/ load it here.
import path from "node:path";

/** The repository root. */
export const rootDir =
  path.basename(process.cwd()) === "agent"
    ? path.dirname(process.cwd())
    : process.cwd();

try {
  process.loadEnvFile(path.join(/*turbopackIgnore: true*/ rootDir, ".env"));
} catch {
  // No .env file: rely on the real environment.
}

export function need(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in.`,
    );
  return value;
}

/**
 * The agent connects to the same database as the web app, but as its own role.
 * Host, port and database come from DATABASE_URL; the user and password do not.
 */
export function agentDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.DATABASE_URL;
  const password = env.ROX_AGENT_DB_PASSWORD;
  if (!base) throw new Error("DATABASE_URL is not set");
  if (!password) throw new Error("ROX_AGENT_DB_PASSWORD is not set");
  const url = new URL(base);
  url.username = "rox_agent";
  url.password = password;
  return url.toString();
}
