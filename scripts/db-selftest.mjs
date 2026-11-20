// Proves the database guarantees on a throwaway database (rox_selftest), so the
// real audit log is never touched:
//   - the service role can add audit rows but not change or remove them
//   - even the owner cannot edit them without breaking the hash chain
//   - tampering is detected and located
//   - concurrent writers keep one unbroken chain
//   - queries are fast
import { execFileSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { need, root } from "./lib.mjs";

const SCRATCH = "rox_selftest";
const ownerUrl = new URL(need("DATABASE_OWNER_URL"));
const appUrl = new URL(need("DATABASE_URL"));
const scratch = (url) => {
  const copy = new URL(url);
  copy.pathname = `/${SCRATCH}`;
  return copy.toString();
};

const admin = new pg.Client({ connectionString: ownerUrl.toString() });
let failures = 0;

async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`  ok    ${name}${detail ? `  (${detail})` : ""}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

async function expectError(promise, pattern) {
  try {
    await promise;
  } catch (error) {
    if (pattern.test(error.message)) return error.message;
    throw new Error(`wrong error: ${error.message}`);
  }
  throw new Error("expected an error, but it succeeded");
}

const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length * p)];

await admin.connect();
try {
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH}`);

  // Run the real migration runner against the scratch database.
  execFileSync(process.execPath, [path.join(root, "scripts", "migrate.mjs")], {
    cwd: root,
    env: { ...process.env, DATABASE_OWNER_URL: scratch(ownerUrl) },
    stdio: "pipe",
  });

  const owner = new pg.Client({ connectionString: scratch(ownerUrl) });
  const app = new pg.Pool({ connectionString: scratch(appUrl), max: 10 });
  // Dropping the scratch database at the end cuts any connection that is still
  // closing; that is expected and must not crash the run.
  owner.on("error", () => {});
  app.on("error", () => {});
  await owner.connect();
  const status = async (client) =>
    (await client.query("SELECT * FROM audit_chain_status()")).rows[0];
  const add = (type, data = {}) =>
    app.query(
      "INSERT INTO audit_events (actor, type, verdict, data) VALUES ('selftest', $1, 'INFO', $2) RETURNING seq, occurred_at",
      [type, data],
    );

  console.log("Audit log");
  await check("service role can append events", async () => {
    for (let i = 1; i <= 3; i++) await add("selftest.append", { i });
    const s = await status(app);
    if (!s.ok || Number(s.checked) !== 3) throw new Error(JSON.stringify(s));
    return "3 rows, chain ok";
  });
  await check("service role cannot UPDATE", () =>
    expectError(
      app.query("UPDATE audit_events SET type = 'x'"),
      /permission denied|append-only/,
    ),
  );
  await check("service role cannot DELETE", () =>
    expectError(
      app.query("DELETE FROM audit_events"),
      /permission denied|append-only/,
    ),
  );
  await check("service role cannot TRUNCATE", () =>
    expectError(
      app.query("TRUNCATE audit_events"),
      /permission denied|append-only/,
    ),
  );
  await check("even the owner cannot UPDATE or DELETE", async () => {
    await expectError(
      owner.query("UPDATE audit_events SET type = 'x'"),
      /append-only/,
    );
    await expectError(owner.query("DELETE FROM audit_events"), /append-only/);
    await expectError(owner.query("TRUNCATE audit_events"), /append-only/);
  });
  await check("callers cannot choose seq or backdate events", async () => {
    const { rows } = await app.query(
      "INSERT INTO audit_events (seq, occurred_at, actor, type, hash) VALUES (9999, '2000-01-01', 'selftest', 'selftest.forge', '\\x00') RETURNING seq, occurred_at",
    );
    if (Number(rows[0].seq) === 9999) throw new Error("seq was accepted");
    if (rows[0].occurred_at.getUTCFullYear() < 2026)
      throw new Error("timestamp was accepted");
  });

  console.log("Tamper detection (a superuser who disables the guard)");
  await check("an edited row is found and located", async () => {
    await owner.query("BEGIN");
    await owner.query(
      "ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete",
    );
    await owner.query(
      "UPDATE audit_events SET data = '{\"forged\":true}' WHERE seq = 2",
    );
    const s = await status(owner);
    await owner.query("ROLLBACK");
    if (s.ok || Number(s.first_bad_seq) !== 2)
      throw new Error(JSON.stringify(s));
    return `first bad seq = ${s.first_bad_seq}`;
  });
  await check("a removed row is found", async () => {
    await owner.query("BEGIN");
    await owner.query(
      "ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete",
    );
    await owner.query("DELETE FROM audit_events WHERE seq = 2");
    const s = await status(owner);
    await owner.query("ROLLBACK");
    if (s.ok) throw new Error("deletion went unnoticed");
    return `first bad seq = ${s.first_bad_seq}`;
  });
  await check("chain is intact again after the rollback", async () => {
    if (!(await status(owner)).ok) throw new Error("chain not ok");
  });

  console.log("Concurrency");
  await check("25 parallel writers keep one unbroken chain", async () => {
    const before = Number((await status(app)).checked);
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => add("selftest.parallel", { i })),
    );
    const s = await status(app);
    if (!s.ok || Number(s.checked) !== before + 25)
      throw new Error(JSON.stringify(s));
    return `${s.checked} rows, chain ok`;
  });

  console.log("Users");
  await check("service role cannot delete users", () =>
    expectError(app.query("DELETE FROM users"), /permission denied/),
  );
  await check("a person needs a GitHub id", () =>
    expectError(
      app.query("INSERT INTO users (login) VALUES ('nobody')"),
      /users_identity/,
    ),
  );
  await check("only one demo user", () =>
    expectError(
      app.query("INSERT INTO users (login, is_demo) VALUES ('judge2', true)"),
      /users_one_demo/,
    ),
  );
  await check("GitHub user can be added", async () => {
    await app.query(
      "INSERT INTO users (github_id, login) VALUES (1, 'selftest')",
    );
  });

  console.log("Latency (localhost, no network hop)");
  const time = async (fn, n) => {
    const samples = [];
    for (let i = 0; i < n; i++) {
      const start = process.hrtime.bigint();
      await fn(i);
      samples.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    return `p50 ${percentile(samples, 0.5).toFixed(2)} ms, p95 ${percentile(samples, 0.95).toFixed(2)} ms`;
  };
  await check("audit insert (hash chain, serialised)", () =>
    time((i) => add("selftest.latency", { i }), 300),
  );
  await check("read recent events by type", () =>
    time(
      () =>
        app.query(
          "SELECT seq, type FROM audit_events WHERE type = 'selftest.latency' ORDER BY seq DESC LIMIT 20",
        ),
      300,
    ),
  );
  await check("look up user by GitHub id", () =>
    time(() => app.query("SELECT id FROM users WHERE github_id = 1"), 300),
  );

  await owner.end();
  await app.end();
} catch (error) {
  failures++;
  console.error(error.message);
} finally {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
  await admin.end();
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
