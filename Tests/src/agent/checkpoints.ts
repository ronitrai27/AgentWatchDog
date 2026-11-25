// Where the graph's checkpoints live: the lab's own Postgres container, only reachable from this
// machine. The real Rox database is never opened.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";
import { docker } from "../docker";
import { cacheDir } from "../env";

const NAME = "rox-lab-db";
const PORT = 5439;
const SECRET = path.join(cacheDir, "lab-db-password");

async function url(): Promise<string> {
  const exists = await docker(["inspect", "-f", "{{.State.Running}}", NAME])
    .then((s) => s.trim())
    .catch(() => null);
  if (exists === null) {
    await mkdir(cacheDir, { recursive: true });
    if (!existsSync(SECRET))
      await writeFile(SECRET, randomBytes(24).toString("hex"));
    const password = await readFile(SECRET, "utf8");
    await docker([
      "run",
      "-d",
      "--name",
      NAME,
      "--label",
      "rox.lab=1",
      "-p",
      `127.0.0.1:${PORT}:5432`,
      "-v",
      "rox-lab-db:/var/lib/postgresql/data",
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-e",
      "POSTGRES_DB=rox_lab",
      "postgres:17",
    ]);
  } else if (exists === "false") await docker(["start", NAME]);
  return `postgres://postgres:${await readFile(SECRET, "utf8")}@127.0.0.1:${PORT}/rox_lab`;
}

let saver: Promise<PostgresSaver> | null = null;

/** One saver per process; the tables are made on first use. */
export function checkpoints(): Promise<PostgresSaver> {
  saver ??= (async () => {
    const pool = new pg.Pool({ connectionString: await url(), max: 4 });
    pool.on("error", () => {}); // A lost idle connection is opened again on the next query.
    for (let i = 0; ; i++) {
      try {
        await pool.query("select 1");
        break;
      } catch (error) {
        if (i >= 30) throw error;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    const s = new PostgresSaver(pool);
    await s.setup();
    return s;
  })();
  saver.catch(() => {
    saver = null;
  });
  return saver;
}
