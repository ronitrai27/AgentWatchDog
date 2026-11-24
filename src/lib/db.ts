import pg from "pg";

// One pool per server process. In development Next reloads modules often, so
// the pool is kept on globalThis to avoid opening a new one on every reload.
const globalForPool = globalThis as { roxPool?: pg.Pool };

export function db(): pg.Pool {
  if (!globalForPool.roxPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set; see .env.example");
    }
    globalForPool.roxPool = new pg.Pool({
      connectionString,
      max: 10,
      connectionTimeoutMillis: 3000,
    });
    // An idle connection dropped by the server must not crash the process.
    globalForPool.roxPool.on("error", () => {});
  }
  return globalForPool.roxPool;
}

const USER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in one transaction that is scoped to a single user. Row-level
 * security then lets the queries see only that user's chat sessions, even if a
 * query forgets its own WHERE clause. Outside this helper, session tables look
 * empty to the app role.
 */
export async function withUser<T>(
  userId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!USER_ID.test(userId)) throw new Error("withUser needs a user id");
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    // `true` makes the setting local to this transaction, so a pooled
    // connection never carries one user's id to the next caller.
    await client.query("SELECT set_config('rox.user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
