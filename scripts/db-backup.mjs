// Backs up the Rox database to backups/rox-<time>.dump (pg_dump custom format),
// checks the file can be read back, optionally copies it to BACKUP_COPY_DIR,
// and keeps the newest BACKUP_KEEP files (default 14).
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { dockerExec, need, root, waitForExit } from "./lib.mjs";

const user = need("POSTGRES_USER");
const db = process.env.POSTGRES_DB ?? "rox";
const keep = Number(process.env.BACKUP_KEEP ?? 14);
const dir = path.join(root, "backups");
mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const file = path.join(dir, `rox-${stamp}.dump`);

function fail(message) {
  console.error(message);
  if (existsSync(file)) unlinkSync(file);
  process.exit(1);
}

// 1. Dump. Streamed straight to disk, so binary data is never altered.
const dump = dockerExec(["pg_dump", "-U", user, "-d", db, "-Fc"]);
const [, dumped] = await Promise.all([
  pipeline(dump.stdout, createWriteStream(file)),
  waitForExit(dump),
]);
if (dumped.code !== 0) fail(`pg_dump failed:\n${dumped.stderr}`);
const size = statSync(file).size;
if (size === 0) fail("Backup is empty.");

// 2. Verify: the server must be able to list what is inside.
const check = dockerExec(["pg_restore", "--list"]);
let listing = "";
check.stdout.on("data", (chunk) => {
  listing += chunk;
});
createReadStream(file).pipe(check.stdin);
const checked = await waitForExit(check);
if (checked.code !== 0) fail(`Backup did not verify:\n${checked.stderr}`);
const entries = listing
  .split("\n")
  .filter((l) => l && !l.startsWith(";")).length;

console.log(`backup ok: ${file}`);
console.log(
  `size ${(size / 1024).toFixed(1)} KB, ${entries} objects, verified`,
);

// 3. A backup that stays on the same disk is not a backup.
const copyDir = process.env.BACKUP_COPY_DIR;
if (copyDir) {
  try {
    mkdirSync(copyDir, { recursive: true });
    copyFileSync(file, path.join(copyDir, path.basename(file)));
    console.log(`copied to ${copyDir}`);
  } catch (error) {
    console.error(`WARNING: copy to ${copyDir} failed: ${error.message}`);
    process.exitCode = 2;
  }
} else {
  console.log(
    "note: BACKUP_COPY_DIR is not set, so this only exists on this machine",
  );
}

// 4. Retention: only files this script made.
const dumps = readdirSync(dir)
  .filter((name) => /^rox-.*\.dump$/.test(name))
  .sort()
  .reverse();
for (const old of dumps.slice(keep)) {
  unlinkSync(path.join(dir, old));
  console.log(`removed old backup ${old}`);
}
