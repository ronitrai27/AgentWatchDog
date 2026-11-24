// Proves the database guarantees on a throwaway database (rox_selftest), so the
// real audit log is never touched:
//   - the service role can add audit rows but not change or remove them
//   - even the owner cannot edit them without breaking the hash chain
//   - tampering is detected and located
//   - concurrent writers keep one unbroken chain
//   - chat sessions: per-user isolation, append-only events, numbering, timing
//   - queries are fast
import { execFileSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { need, root } from "./lib.mjs";

const SCRATCH = "rox_selftest";
const ownerUrl = new URL(need("DATABASE_OWNER_URL"));
const appUrl = new URL(need("DATABASE_URL"));
const agentUrl = new URL(appUrl);
agentUrl.username = "rox_agent";
agentUrl.password = need("ROX_AGENT_DB_PASSWORD");
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
  const agent = new pg.Pool({ connectionString: scratch(agentUrl), max: 10 });
  // Dropping the scratch database at the end cuts any connection that is still
  // closing; that is expected and must not crash the run.
  owner.on("error", () => {});
  app.on("error", () => {});
  agent.on("error", () => {});
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
  await check("every judge visit can have its own demo user", async () => {
    await app.query(
      "INSERT INTO users (login, is_demo) VALUES ('judge2', true)",
    );
  });
  await check("service role cannot read stored API keys", async () => {
    const { rows } = await app.query("SELECT id FROM users LIMIT 1");
    await app.query(
      `INSERT INTO provider_keys (user_id, provider, iv, ciphertext, tag, last4)
       VALUES ($1, 'openai', decode('00','hex'), decode('00','hex'), decode('00','hex'), 'test')`,
      [rows[0].id],
    );
    await app.query("SELECT provider, last4 FROM provider_keys");
    await expectError(
      app.query("SELECT ciphertext FROM provider_keys"),
      /permission denied/,
    );
    await expectError(
      app.query("UPDATE provider_keys SET last4 = 'x'"),
      /permission denied/,
    );
  });
  await check("GitHub user can be added", async () => {
    await app.query(
      "INSERT INTO users (github_id, login) VALUES (1, 'selftest')",
    );
  });

  console.log("Chat sessions");
  // Everything below runs scoped to one user, the way src/lib/db.ts (web role) and
  // agent/src/db.ts (agent role) do it.
  const scoped = (pool) => async (userId, fn) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('rox.user_id', $1, true)", [
        userId,
      ]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };
  const asUser = scoped(app); // the web role
  const asAgent = scoped(agent); // the agent role
  const mkUser = async (githubId, login) =>
    (
      await app.query(
        "INSERT INTO users (github_id, login) VALUES ($1, $2) RETURNING id",
        [githubId, login],
      )
    ).rows[0].id;
  const alice = await mkUser(9001, "alice");
  const bob = await mkUser(9002, "bob");
  const newSession = (user, name) =>
    asUser(
      user,
      async (c) =>
        (
          await c.query(
            name
              ? "INSERT INTO sessions (user_id, name) VALUES ($1, $2) RETURNING *"
              : "INSERT INTO sessions (user_id) VALUES ($1) RETURNING *",
            name ? [user, name] : [user],
          )
        ).rows[0],
    );
  const addEvent = (user, sessionId, type = "user.message", extra = {}) =>
    asAgent(
      user,
      async (c) =>
        (
          await c.query(
            `INSERT INTO session_events (session_id, turn_id, type, data, duration_ms)
             VALUES ($1, $2, $3, $4, $5) RETURNING seq, occurred_at`,
            [
              sessionId,
              extra.turnId ?? null,
              type,
              extra.data ?? { text: "hi" },
              extra.durationMs ?? null,
            ],
          )
        ).rows[0],
    );
  const startTurn = (user, sessionId) =>
    asAgent(
      user,
      async (c) =>
        (
          await c.query(
            "INSERT INTO session_turns (session_id, model) VALUES ($1, 'test-model') RETURNING *",
            [sessionId],
          )
        ).rows[0],
    );
  const getSession = (user, id) =>
    asUser(
      user,
      async (c) =>
        (await c.query("SELECT * FROM sessions WHERE id = $1", [id])).rows[0],
    );

  const s1 = await newSession(alice);
  await check("a session gets a default name and its times", async () => {
    if (s1.name !== "New chat") throw new Error(`name: ${s1.name}`);
    if (!s1.created_at || !s1.updated_at) throw new Error("times missing");
    if (Number(s1.next_seq) !== 1 || Number(s1.exec_ms) !== 0)
      throw new Error("counters should start at their defaults");
  });
  await check("a user sees only their own sessions", async () => {
    const mine = await asUser(alice, (c) => c.query("SELECT id FROM sessions"));
    const theirs = await asUser(bob, (c) => c.query("SELECT id FROM sessions"));
    if (mine.rowCount !== 1) throw new Error(`alice sees ${mine.rowCount}`);
    if (theirs.rowCount !== 0) throw new Error(`bob sees ${theirs.rowCount}`);
  });
  await check("with no user set, nothing is visible", async () => {
    const { rowCount } = await app.query("SELECT id FROM sessions");
    if (rowCount !== 0) throw new Error(`saw ${rowCount} rows`);
  });
  await check("a user cannot create a session for someone else", () =>
    expectError(
      asUser(bob, (c) =>
        c.query("INSERT INTO sessions (user_id) VALUES ($1)", [alice]),
      ),
      /row-level security/,
    ),
  );
  await check(
    "counters and owner cannot be set or changed by the app",
    async () => {
      await expectError(
        asUser(alice, (c) =>
          c.query("INSERT INTO sessions (user_id, exec_ms) VALUES ($1, 999)", [
            alice,
          ]),
        ),
        /permission denied/,
      );
      await expectError(
        asUser(alice, (c) =>
          c.query("UPDATE sessions SET user_id = $2 WHERE id = $1", [
            s1.id,
            bob,
          ]),
        ),
        /permission denied/,
      );
      await expectError(
        asUser(alice, (c) =>
          c.query("UPDATE sessions SET next_seq = 1 WHERE id = $1", [s1.id]),
        ),
        /permission denied/,
      );
    },
  );
  await check(
    "rename works, bumps the last-activity time, and is checked",
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const renamed = await asUser(
        alice,
        async (c) =>
          (
            await c.query(
              "UPDATE sessions SET name = 'Checkout bug' WHERE id = $1 RETURNING *",
              [s1.id],
            )
          ).rows[0],
      );
      if (renamed.name !== "Checkout bug") throw new Error("name not changed");
      if (!(renamed.updated_at > s1.updated_at))
        throw new Error("updated_at did not move");
      await expectError(
        asUser(alice, (c) =>
          c.query("UPDATE sessions SET name = '   ' WHERE id = $1", [s1.id]),
        ),
        /sessions_name_length/,
      );
      await expectError(
        asUser(alice, (c) =>
          c.query("UPDATE sessions SET name = $2 WHERE id = $1", [
            s1.id,
            "x".repeat(121),
          ]),
        ),
        /sessions_name_length/,
      );
    },
  );
  await check("another user cannot rename or delete it", async () => {
    const renamed = await asUser(bob, (c) =>
      c.query("UPDATE sessions SET name = 'mine now' WHERE id = $1", [s1.id]),
    );
    const removed = await asUser(bob, (c) =>
      c.query("DELETE FROM sessions WHERE id = $1", [s1.id]),
    );
    if (renamed.rowCount !== 0 || removed.rowCount !== 0)
      throw new Error("bob changed alice's session");
  });

  console.log("Session events");
  await check("events are numbered 1, 2, 3 by the database", async () => {
    const a = await addEvent(alice, s1.id);
    const b = await addEvent(alice, s1.id, "assistant.message", {
      data: { text: "hello" },
      durationMs: 1200,
    });
    const c = await addEvent(alice, s1.id, "tool.completed", {
      data: { tool: "read_file" },
      durationMs: 35,
    });
    const seqs = [a, b, c].map((r) => Number(r.seq));
    if (seqs.join() !== "1,2,3") throw new Error(`got ${seqs}`);
    const s = await getSession(alice, s1.id);
    if (Number(s.next_seq) !== 4 || !s.last_event_at)
      throw new Error("session totals not updated");
    return "3 events, next_seq 4";
  });
  await check("callers cannot choose seq or the time", () =>
    expectError(
      asUser(alice, (c) =>
        c.query(
          "INSERT INTO session_events (session_id, seq, type) VALUES ($1, 99, 'user.message')",
          [s1.id],
        ),
      ),
      /permission denied/,
    ),
  );
  await check(
    "30 parallel writers get 30 distinct, gap-free numbers",
    async () => {
      const s = await newSession(alice, "parallel");
      await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          addEvent(alice, s.id, "system.note", { data: { i } }),
        ),
      );
      const { rows } = await asUser(alice, (c) =>
        c.query(
          "SELECT count(*)::int AS n, count(DISTINCT seq)::int AS d, min(seq)::int AS lo, max(seq)::int AS hi FROM session_events WHERE session_id = $1",
          [s.id],
        ),
      );
      const r = rows[0];
      if (r.n !== 30 || r.d !== 30 || r.lo !== 1 || r.hi !== 30)
        throw new Error(JSON.stringify(r));
      return "seq 1..30";
    },
  );
  await check("the app role cannot UPDATE or DELETE events", async () => {
    await expectError(
      asUser(alice, (c) => c.query("UPDATE session_events SET type = 'x.y'")),
      /permission denied/,
    );
    await expectError(
      asUser(alice, (c) => c.query("DELETE FROM session_events")),
      /permission denied/,
    );
  });
  await check(
    "the web role reads events but cannot write events or turns",
    async () => {
      await expectError(
        asUser(alice, (c) =>
          c.query(
            "INSERT INTO session_events (session_id, type) VALUES ($1, 'user.message')",
            [s1.id],
          ),
        ),
        /permission denied/,
      );
      await expectError(
        asUser(alice, (c) =>
          c.query("INSERT INTO session_turns (session_id) VALUES ($1)", [
            s1.id,
          ]),
        ),
        /permission denied/,
      );
      const { rowCount } = await asUser(alice, (c) =>
        c.query("SELECT 1 FROM session_events WHERE session_id = $1", [s1.id]),
      );
      if (rowCount < 3) throw new Error("the web role cannot read events");
    },
  );
  await check(
    "the agent role cannot UPDATE or DELETE events either",
    async () => {
      await expectError(
        asAgent(alice, (c) =>
          c.query("UPDATE session_events SET type = 'x.y'"),
        ),
        /permission denied/,
      );
      await expectError(
        asAgent(alice, (c) => c.query("DELETE FROM session_events")),
        /permission denied/,
      );
    },
  );
  await check(
    "even the owner cannot edit, delete or truncate events",
    async () => {
      await expectError(
        owner.query("UPDATE session_events SET type = 'x.y'"),
        /append-only/,
      );
      await expectError(
        owner.query("DELETE FROM session_events"),
        /append-only/,
      );
      await expectError(owner.query("TRUNCATE session_events"), /append-only/);
    },
  );
  await check("another user cannot read or add to my events", async () => {
    const seen = await asUser(bob, (c) =>
      c.query("SELECT 1 FROM session_events"),
    );
    if (seen.rowCount !== 0) throw new Error("bob can read alice's events");
    await expectError(addEvent(bob, s1.id), /row-level security/);
    const s = await getSession(alice, s1.id);
    if (Number(s.next_seq) !== 4)
      throw new Error("a refused write still moved the counter");
  });
  await check(
    "a bad event type or an oversized payload is rejected",
    async () => {
      await expectError(
        addEvent(alice, s1.id, "NoDots"),
        /session_events_type_check/,
      );
      await expectError(
        addEvent(alice, s1.id, "user.message", {
          data: { text: "x".repeat(1_100_000) },
        }),
        /session_events_data_check/,
      );
    },
  );

  console.log("Agent turns and execution time");
  const t1 = await startTurn(alice, s1.id);
  await check("a turn starts as 'running' with number 1", () => {
    if (t1.status !== "running" || t1.n !== 1 || t1.finished_at)
      throw new Error(JSON.stringify(t1));
  });
  await check("a chat runs one turn at a time", () =>
    expectError(startTurn(alice, s1.id), /session_turns_one_running/),
  );
  await check(
    "an event can only point at a turn of its own session",
    async () => {
      const other = await newSession(alice, "other");
      await expectError(
        addEvent(alice, other.id, "model.request", { turnId: t1.id }),
        /does not belong/,
      );
      await addEvent(alice, s1.id, "model.request", {
        turnId: t1.id,
        data: { model: "test-model" },
      });
    },
  );
  await check(
    "the agent cannot set finish time, duration or start time",
    async () => {
      for (const col of ["finished_at", "duration_ms", "started_at"]) {
        await expectError(
          asAgent(alice, (c) =>
            c.query(`UPDATE session_turns SET ${col} = NULL WHERE id = $1`, [
              t1.id,
            ]),
          ),
          /permission denied|can only be updated to DEFAULT/,
        );
      }
    },
  );
  await check(
    "finishing a turn stamps the time and adds it to the session",
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const done = await asAgent(
        alice,
        async (c) =>
          (
            await c.query(
              `UPDATE session_turns SET status = 'completed', input_tokens = 120, output_tokens = 45
              WHERE id = $1 RETURNING *`,
              [t1.id],
            )
          ).rows[0],
      );
      if (done.status !== "completed" || !done.finished_at)
        throw new Error("not finished");
      if (done.duration_ms < 50)
        throw new Error(`duration ${done.duration_ms} ms is too small`);
      const s = await getSession(alice, s1.id);
      if (Number(s.exec_ms) !== done.duration_ms)
        throw new Error(`session total ${s.exec_ms} vs ${done.duration_ms}`);
      return `${done.duration_ms} ms`;
    },
  );
  await check("a finished turn cannot change", () =>
    expectError(
      asAgent(alice, (c) =>
        c.query("UPDATE session_turns SET status = 'failed' WHERE id = $1", [
          t1.id,
        ]),
      ),
      /is finished/,
    ),
  );
  await check(
    "the next turn is number 2; only failures carry an error",
    async () => {
      const t2 = await startTurn(alice, s1.id);
      if (t2.n !== 2) throw new Error(`n = ${t2.n}`);
      await expectError(
        asAgent(alice, (c) =>
          c.query(
            "UPDATE session_turns SET status = 'completed', error = 'boom' WHERE id = $1",
            [t2.id],
          ),
        ),
        /session_turns_check/,
      );
      await asAgent(alice, (c) =>
        c.query(
          "UPDATE session_turns SET status = 'failed', error = 'boom' WHERE id = $1",
          [t2.id],
        ),
      );
    },
  );
  await check("turns cannot be deleted on their own", async () => {
    await expectError(
      owner.query("DELETE FROM session_turns"),
      /only be removed by deleting its session/,
    );
  });

  console.log("Agent role and stored keys");
  await check(
    "the agent reads a stored key only for the user it serves",
    async () => {
      await app.query(
        `INSERT INTO provider_keys (user_id, provider, iv, ciphertext, tag, last4)
       VALUES ($1, 'anthropic', decode('01','hex'), decode('02','hex'), decode('03','hex'), 'abcd')`,
        [alice],
      );
      const read = (user) =>
        asAgent(user, (c) =>
          c.query("SELECT provider, ciphertext FROM provider_keys"),
        );
      const mine = await read(alice);
      const theirs = await read(bob);
      const noUser = await agent.query("SELECT 1 FROM provider_keys");
      if (mine.rowCount !== 1) throw new Error(`alice: ${mine.rowCount}`);
      if (theirs.rowCount !== 0) throw new Error(`bob sees ${theirs.rowCount}`);
      if (noUser.rowCount !== 0) throw new Error("no user set, still visible");
    },
  );
  await check("the agent reads setup only for the user it serves", async () => {
    await owner.query(
      "INSERT INTO user_setup (user_id, repo) VALUES ($1, 'a/b')",
      [alice],
    );
    const mine = await asAgent(alice, (c) =>
      c.query("SELECT repo FROM user_setup"),
    );
    const theirs = await asAgent(bob, (c) =>
      c.query("SELECT repo FROM user_setup"),
    );
    if (mine.rowCount !== 1 || theirs.rowCount !== 0)
      throw new Error(`${mine.rowCount} / ${theirs.rowCount}`);
  });
  await check("the web role still cannot read a stored key", () =>
    expectError(
      asUser(alice, (c) => c.query("SELECT ciphertext FROM provider_keys")),
      /permission denied/,
    ),
  );
  await check("the agent role cannot change users, keys or setup", async () => {
    await expectError(agent.query("DELETE FROM users"), /permission denied/);
    await expectError(
      agent.query("UPDATE provider_keys SET last4 = 'x'"),
      /permission denied/,
    );
    await expectError(
      agent.query("UPDATE user_setup SET repo = 'x'"),
      /permission denied/,
    );
  });
  await check(
    "the agent can create and rename a chat for its user, not another's",
    async () => {
      const made = await asAgent(
        alice,
        async (c) =>
          (
            await c.query(
              "INSERT INTO sessions (user_id, name) VALUES ($1, 'Welcome') RETURNING id",
              [alice],
            )
          ).rows[0],
      );
      await asAgent(alice, (c) =>
        c.query("UPDATE sessions SET name = 'Setup check' WHERE id = $1", [
          made.id,
        ]),
      );
      await expectError(
        asAgent(bob, (c) =>
          c.query("INSERT INTO sessions (user_id) VALUES ($1)", [alice]),
        ),
        /row-level security/,
      );
    },
  );

  console.log("Deleting a chat");
  await check(
    "another user's delete removes nothing; the owner's removes all",
    async () => {
      const count = async (table) =>
        Number(
          (
            await owner.query(
              `SELECT count(*) FROM ${table} WHERE session_id = $1`,
              [s1.id],
            )
          ).rows[0].count,
        );
      const before = [
        await count("session_events"),
        await count("session_turns"),
      ];
      if (before[0] < 4 || before[1] < 2) throw new Error(`setup: ${before}`);
      const theirs = await asUser(bob, (c) =>
        c.query("DELETE FROM sessions WHERE id = $1", [s1.id]),
      );
      if (theirs.rowCount !== 0) throw new Error("bob deleted alice's chat");
      const mine = await asUser(alice, (c) =>
        c.query("DELETE FROM sessions WHERE id = $1", [s1.id]),
      );
      if (mine.rowCount !== 1) throw new Error("alice could not delete");
      const after = [
        await count("session_events"),
        await count("session_turns"),
      ];
      if (after[0] !== 0 || after[1] !== 0)
        throw new Error(`left behind: ${after}`);
      return `removed ${before[0]} events and ${before[1]} turns`;
    },
  );
  await check("events are still protected after a delete", () =>
    expectError(owner.query("DELETE FROM session_events"), /append-only/),
  );

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
  const sLat = await newSession(alice, "latency");
  await check("append a chat event (one user-scoped transaction)", () =>
    time((i) => addEvent(alice, sLat.id, "system.note", { data: { i } }), 200),
  );
  await check("read the last 50 events of a chat", () =>
    time(
      () =>
        asUser(alice, (c) =>
          c.query(
            "SELECT seq, type, data FROM session_events WHERE session_id = $1 ORDER BY seq DESC LIMIT 50",
            [sLat.id],
          ),
        ),
      200,
    ),
  );
  await check("list a user's chats, newest first", () =>
    time(
      () =>
        asUser(alice, (c) =>
          c.query(
            "SELECT id, name FROM sessions ORDER BY updated_at DESC LIMIT 50",
          ),
        ),
      200,
    ),
  );

  await owner.end();
  await app.end();
  await agent.end();
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
