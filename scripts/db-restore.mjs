// Restores a backup made by db-backup.mjs.
//   node scripts/db-restore.mjs <file> --into rox_restore_check   restore into a scratch database (safe)
//   node scripts/db-restore.mjs <file> --yes                      REPLACE the live database
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { dockerExec, need, root, waitForExit } from "./lib.mjs";

const args = process.argv.slice(2);
const intoIndex = args.indexOf("--into");
const into = intoIndex >= 0 ? args[intoIndex + 1] : null;
const confirmed = args.includes("--yes");
// The value after --into is a database name, not the file.
const skip = intoIndex >= 0 ? intoIndex + 1 : -1;
const fileArg = args.find((a, i) => !a.startsWith("--") && i !== skip);

if (!fileArg) {
  console.error(
    "Usage: db-restore.mjs <file> (--into rox_restore_<name> | --yes)",
  );
  process.exit(1);
}
const file = path.resolve(root, fileArg);
if (!existsSync(file)) {
  console.error(`No such file: ${file}`);
  process.exit(1);
}
if (into && !/^rox_restore_[a-z0-9_]+$/.test(into)) {
  console.error(
    "--into must look like rox_restore_<letters, digits, underscores>",
  );
  process.exit(1);
}
if (!into && !confirmed) {
  console.error(
    "This replaces the live database. Re-run with --yes, or use --into rox_restore_check to try it safely.",
  );
  process.exit(1);
}

const user = need("POSTGRES_USER");
const live = process.env.POSTGRES_DB ?? "rox";
const target = into ?? live;

async function psql(database, ...sql) {
  const flags = sql.flatMap((s) => ["-c", s]);
  const child = dockerExec([
    "psql",
    "-U",
    user,
    "-d",
    database,
    "-v",
    "ON_ERROR_STOP=1",
    "-At",
    ...flags,
  ]);
  let out = "";
  child.stdout.on("data", (c) => {
    out += c;
  });
  const { code, stderr } = await waitForExit(child);
  if (code !== 0) throw new Error(stderr);
  return out.trim();
}

try {
  if (into) {
    await psql(
      "postgres",
      `DROP DATABASE IF EXISTS ${into}`,
      `CREATE DATABASE ${into}`,
    );
    console.log(`created scratch database ${into}`);
  }

  const restore = dockerExec([
    "pg_restore",
    "-U",
    user,
    "-d",
    target,
    "--no-owner",
    ...(into ? [] : ["--clean", "--if-exists"]),
  ]);
  createReadStream(file).pipe(restore.stdin);
  const { code, stderr } = await waitForExit(restore);
  if (code !== 0) throw new Error(`pg_restore failed:\n${stderr}`);

  const users = await psql(target, "SELECT count(*) FROM users");
  const chain = await psql(
    target,
    "SELECT ok || ' (' || checked || ' rows)' FROM audit_chain_status()",
  );
  console.log(
    `restored into ${target}: ${users} users, audit chain ok = ${chain}`,
  );
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
