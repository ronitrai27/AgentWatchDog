import pg from "pg";

const USER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Db = {
  /**
   * Runs `fn` in one transaction scoped to one user. The database then shows only that
   * user's chats, setup and keys, even if a query forgets its own WHERE clause.
   */
  withUser<T>(
    userId: string,
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T>;
  /** For things that belong to no user, like the audit log. */
  query: pg.Pool["query"];
  close(): Promise<void>;
};

export function createDb(connectionString: string): Db {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 3000,
  });
  // An idle connection dropped by the server must not crash the process.
  pool.on("error", () => {});

  return {
    async withUser(userId, fn) {
      if (!USER_ID.test(userId)) throw new Error("withUser needs a user id");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Local to this transaction, so a pooled connection never carries one user's id to the next.
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
    },
    query: pool.query.bind(pool) as pg.Pool["query"],
    close: () => pool.end(),
  };
}
