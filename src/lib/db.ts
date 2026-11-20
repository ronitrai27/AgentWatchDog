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
