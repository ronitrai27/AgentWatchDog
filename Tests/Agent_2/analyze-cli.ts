// Runs Agent_2's first steps (U0 gate, U1 stack + profile, U2 index + reach) on ANY local git
// repository, without Temporal or GitHub. The repository is copied into a sandbox volume; the
// index runs there with no network. Results go to Tests/runs/<run>/.
//
//   pnpm agent2:analyze --dir <path to a git checkout> --base <ref> [--head <ref>]
//
// The head must be the commit checked out in <dir> (that is what gets indexed).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { destroyRun } from "../src/docker";
import { runDir } from "../src/env";
import { loadVolume } from "../src/source";
import { analyzeStep, gateStep } from "./analyze";
import { resolveRef } from "./git";

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
  const dirArg = flag("dir");
  const baseArg = flag("base");
  if (!dirArg) {
    console.log(
      "Usage: pnpm agent2:analyze --dir <git checkout> --base <ref> [--head <ref>]",
    );
    process.exit(1);
  }
  const dir = path.resolve(dirArg);
  const head = await resolveRef(dir, flag("head") ?? "HEAD");
  const checkedOut = await resolveRef(dir, "HEAD");
  if (head !== checkedOut) {
    console.error(
      `Check out ${head.slice(0, 7)} in ${dir} first: the index reads the files on disk.`,
    );
    process.exit(1);
  }
  const base = baseArg ? await resolveRef(dir, baseArg) : null;
  const dirty = execFileSync(
    "git",
    ["-C", dir, "status", "--porcelain", "--untracked-files=no"],
    { encoding: "utf8" },
  ).trim();
  if (dirty)
    console.warn(
      "Note: the checkout has uncommitted changes; the index reads them, the diff does not.",
    );

  const run = `cli-${randomUUID()}`;
  console.log(
    `run ${run}\n  ${dir}\n  ${base ? `${base.slice(0, 7)}..` : ""}${head.slice(0, 7)}`,
  );
  try {
    const g = await gateStep({ run, dir, base, head });
    console.log(`\nU0 language gate: ${g.gate.ok ? "pass" : "STOP"}`);
    if (g.gate.message) console.log(`  ${g.gate.message}`);
    console.log(
      `\nU1 stack: ${g.stack.summary.frameworks.join(", ") || "no mapped framework"}${g.stack.summary.unmappedServer.length ? ` (unmapped: ${g.stack.summary.unmappedServer.join(", ")})` : ""}; tests: ${g.stack.summary.testRunners.join(", ") || "none"}; ${g.stack.packageManager ?? "no package manager"}; ${g.stack.packages.length} package(s)`,
    );
    if (!g.gate.ok) return;
    const volume = `rox-src-${run}`;
    await loadVolume(dir, volume, run);
    const a = await analyzeStep({ run, dir, base, head, gate: g, volume });
    console.log(
      `\nU2 index: ${a.index.head.files} files, ${a.index.head.symbols} symbols, ${a.routes.head} routes${a.index.base ? ` (base ${a.routes.base})` : ""}, ${Math.round(a.index.ms / 1000)} s`,
    );
    console.log("\nChange profile:");
    for (const f of a.profile.files)
      console.log(
        `  ${f.status} ${f.path}  [${f.kinds.join(", ")}]\n      ${f.reasons.join("\n      ")}`,
      );
    console.log(`\nReach: ${a.reach.changedSymbols.length} changed symbols`);
    for (const s of a.reach.changedSymbols.slice(0, 20))
      console.log(`  ${s.how.padEnd(7)} ${s.id}`);
    console.log(`  callers (depth ≤ 2): ${a.reach.callers.length}`);
    for (const c of a.reach.callers.slice(0, 15))
      console.log(`    ${c.depth} ${c.id}`);
    console.log(`  every route: ${a.reach.global ? "YES" : "no"}`);
    for (const w of a.reach.globalWhy) console.log(`    ${w}`);
    console.log(`  routes reached: ${a.reach.routes.length}`);
    for (const r of a.reach.routes.slice(0, 30))
      console.log(`    ${r.method.padEnd(6)} ${r.path}  (${r.why})`);
    if (a.reach.routesUnknown) {
      console.log("  routes not fully known:");
      for (const w of a.reach.unknownWhy.slice(0, 10)) console.log(`    ${w}`);
    }
    console.log(`\nWritten to ${path.join(runDir(run), "agent2")}`);
  } finally {
    await destroyRun(run);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
