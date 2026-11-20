// Applies agent/migrations/*.sql in order, once each.
//   node scripts/migrate.mjs               run pending migrations
//   node scripts/migrate.mjs --roles-only  only create/sync the rox_app role
//                                          (needed before restoring onto a new server)
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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

async function ensureAppRole() {
  const password = need("ROX_APP_DB_PASSWORD");
  const { rowCount } = await client.query(
    "SELECT 1 FROM pg_roles WHERE rolname = 'rox_app'",
  );
  const literal = client.escapeLiteral(password);
  await client.query(
    rowCount
      ? `ALTER ROLE rox_app WITH LOGIN PASSWORD ${literal}`
      : `CREATE ROLE rox_app LOGIN PASSWORD ${literal}`,
  );
  const { rows } = await client.query("SELECT current_database() AS db");
  await client.query(
    `GRANT CONNECT ON DATABASE ${client.escapeIdentifier(rows[0].db)} TO rox_app`,
  );
}

await connectWithRetry();
try {
  await ensureAppRole();
  console.log("role rox_app ready");
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
  console.log(ran ? `${ran} migration(s) applied` : "up to date");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
