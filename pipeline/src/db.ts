// The pipeline's connection to Rox's database (DATABASE_URL, the rox_app role). It writes the runs
// and run_events tables only. The graph's own checkpoints stay in the lab database (checkpoints.ts).
import pg from "pg";
import { need } from "./env";

let pool: pg.Pool | null = null;

export function db(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: need("DATABASE_URL"),
      max: 5,
      connectionTimeoutMillis: 5000,
    });
    // A dropped idle connection must not crash the worker.
    pool.on("error", () => {});
  }
  return pool;
}
