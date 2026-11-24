// A throwaway database for tests: created fresh, migrated with the real runner, dropped after.
// If Postgres is not running, scratchDb returns null and the tests that need it are skipped.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { after, before, type TestContext } from "node:test";
import pg from "pg";
import { agentDatabaseUrl, rootDir } from "./config";
import { createDb, type Db } from "./db";

export type Scratch = {
  name: string;
  /** The table owner: sees everything, for setting up and checking. */
  owner: pg.Pool;
  /** The agent role, the way the service uses it. */
  agentDb: Db;
  agentUrl: string;
  /** The web role. */
  web: pg.Pool;
  createUser(login: string): Promise<string>;
  close(): Promise<void>;
};

const swapDatabase = (url: string, name: string) => {
  const copy = new URL(url);
  copy.pathname = `/${name}`;
  return copy.toString();
};

export async function scratchDb(label: string): Promise<Scratch | null> {
  const ownerUrl = process.env.DATABASE_OWNER_URL;
  const appUrl = process.env.DATABASE_URL;
  if (!ownerUrl || !appUrl || !process.env.ROX_AGENT_DB_PASSWORD) return null;

  const name = `rox_t_${label}_${process.pid}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");
  const admin = new pg.Client({ connectionString: ownerUrl });
  admin.on("error", () => {});
  try {
    await admin.connect();
  } catch {
    return null;
  }
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  execFileSync(
    process.execPath,
    [path.join(rootDir, "scripts", "migrate.mjs")],
    {
      cwd: rootDir,
      env: { ...process.env, DATABASE_OWNER_URL: swapDatabase(ownerUrl, name) },
      stdio: "pipe",
    },
  );

  const owner = new pg.Pool({
    connectionString: swapDatabase(ownerUrl, name),
    max: 4,
  });
  const web = new pg.Pool({
    connectionString: swapDatabase(appUrl, name),
    max: 4,
  });
  owner.on("error", () => {});
  web.on("error", () => {});
  const agentUrl = swapDatabase(agentDatabaseUrl(), name);
  const agentDb = createDb(agentUrl);

  return {
    name,
    owner,
    agentDb,
    agentUrl,
    web,
    async createUser(login) {
      const { rows } = await owner.query<{ id: string }>(
        "INSERT INTO users (login, name, is_demo) VALUES ($1, $1, true) RETURNING id",
        [login],
      );
      return rows[0].id;
    },
    async close() {
      await Promise.allSettled([agentDb.close(), owner.end(), web.end()]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await admin
        .query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
        .catch(() => {});
      await admin.end().catch(() => {});
    },
  };
}

/**
 * For a test file: sets up one scratch database before the tests and drops it after.
 * The returned function gives the database to a test, or skips the test if Postgres is down.
 */
export function scratchForTests(label: string) {
  let value: Scratch | null = null;
  before(async () => {
    value = await scratchDb(label);
  });
  after(async () => {
    await value?.close();
  });
  return (t: TestContext): Scratch | null => {
    if (!value) {
      t.skip("Postgres is not running");
      return null;
    }
    return value;
  };
}
