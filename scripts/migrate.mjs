// Applies agent/migrations/*.sql in order, once each.
//   node scripts/migrate.mjs               run pending migrations
//   node scripts/migrate.mjs --roles-only  only create/sync the rox_app and rox_agent roles
//                                          (needed before restoring onto a new server)
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import pg from "pg";
import { need, root } from "./lib.mjs";

const rolesOnly = process.argv.includes("--roles-only");
const dir = path.join(root, "agent", "migrations");

const client = new pg.Client({ connectionString: need("DATABASE_OWNER_URL") });

async function connectWithRetry() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await client.connect();
      return;
    } catch (error) {
      if (attempt === 30) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

// The web app connects as rox_app; the agent as rox_agent.
const ROLES = [
  { name: "rox_app", passwordVar: "ROX_APP_DB_PASSWORD" },
  { name: "rox_agent", passwordVar: "ROX_AGENT_DB_PASSWORD" },
];

async function ensureRoles() {
  const { rows } = await client.query("SELECT current_database() AS db");
  for (const { name, passwordVar } of ROLES) {
    const literal = client.escapeLiteral(need(passwordVar));
    const { rowCount } = await client.query(
      "SELECT 1 FROM pg_roles WHERE rolname = $1",
      [name],
    );
    await client.query(
      rowCount
        ? `ALTER ROLE ${name} WITH LOGIN PASSWORD ${literal}`
        : `CREATE ROLE ${name} LOGIN PASSWORD ${literal}`,
    );
    await client.query(
      `GRANT CONNECT ON DATABASE ${client.escapeIdentifier(rows[0].db)} TO ${name}`,
    );
  }
}

await connectWithRetry();
try {
  await ensureRoles();
  console.log("roles rox_app and rox_agent ready");
  if (rolesOnly) process.exit(0);

  // One migrator at a time.
  await client.query("SELECT pg_advisory_lock(7240000)");
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`);

  const applied = new Map(
    (
      await client.query("SELECT version, checksum FROM schema_migrations")
    ).rows.map((row) => [row.version, row.checksum]),
  );

  let ran = 0;
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(path.join(dir, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");

    if (applied.has(file)) {
      if (applied.get(file) !== checksum) {
        throw new Error(
          `${file} was changed after it was applied. Add a new migration instead.`,
        );
      }
      continue;
    }

    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
        [file, checksum],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`${file} failed: ${error.message}`);
    }
    console.log(`applied ${file}`);
    ran++;
  }
  // What the model remembers of each chat: LangGraph's own checkpoint tables, in their own schema.
  // Only the agent role may touch them; the web role cannot even see the schema.
  const { PostgresSaver } = createRequire(
    path.join(root, "agent", "package.json"),
  )("@langchain/langgraph-checkpoint-postgres");
  const saver = PostgresSaver.fromConnString(need("DATABASE_OWNER_URL"), {
    schema: "langgraph",
  });
  try {
    await saver.setup();
  } finally {
    await saver.end();
  }
  await client.query(`
    GRANT USAGE ON SCHEMA langgraph TO rox_agent;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA langgraph TO rox_agent;`);

  console.log(ran ? `${ran} migration(s) applied` : "up to date");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
