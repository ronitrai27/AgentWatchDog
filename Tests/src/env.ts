// Paths and settings for Rox Lab. Reads the project's .env, like the rest of Rox.
import path from "node:path";

/** The Tests folder. */
export const labDir = path.resolve(__dirname, "..");
/** The agentwatchdog folder. */
export const rootDir = path.dirname(labDir);
export const runsDir = path.join(labDir, "runs");
export const cacheDir = path.join(labDir, ".cache");

try {
  process.loadEnvFile(path.join(rootDir, ".env"));
} catch {
  // No .env: rely on the real environment.
}

export function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in .env`);
  return value;
}

export const runDir = (run: string) => path.join(runsDir, run);
