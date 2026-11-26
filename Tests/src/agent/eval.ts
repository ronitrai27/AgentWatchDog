// Runs the agent on the seeded bugs.   pnpm --dir Tests eval [case]
import { MemorySaver } from "@langchain/langgraph";
import { CASES } from "./cases";
import { startCase } from "./lab-run";
import { runFix } from "./run";

async function main() {
  const only = process.argv[2] === "all" ? undefined : process.argv[2];
  const times = Number(process.argv[3] ?? 1);
  let total = 0;
  const cases = CASES.filter((x) => !only || x.id === only);
  for (const c of Array.from({ length: times }, () => cases).flat()) {
    const s = await startCase(c);
    const t0 = Date.now();
    console.log(`\n${c.id}  run ${s.run}`);
    try {
      const r = await runFix(
        { run: s.run, workspaces: [c.ws] },
        { workspace: async () => s.ws, fresh: s.fresh },
        { checkpointer: new MemorySaver() },
      );
      total += r.usd;
      console.log(
        `  ${r.outcome} in ${Math.round((Date.now() - t0) / 1000)}s, ${r.attempts.length} attempts, ${r.modelCalls} model calls, ${r.tokens} tokens, $${r.usd.toFixed(4)}`,
      );
      console.log(`  cause: ${r.findings?.cause ?? "-"}`);
      console.log(`  reason: ${r.reason.slice(0, 400)}`);
      console.log(
        (r.attempts.at(-1)?.patch ?? "")
          .split("\n")
          .filter((l) => /^[+-][^+-]/.test(l))
          .map((l) => `    ${l}`)
          .join("\n"),
      );
    } finally {
      await s.end();
    }
  }
  console.log(`\nTotal $${total.toFixed(4)}`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
