// Proves Verify, without any AI: the right fix passes, wrong and cheating ones are refused at the
// gate that should refuse them.   pnpm --dir Tests proof:gates
import { CASES } from "./cases";
import { type Contract, runTests, verify } from "./gates";
import { startCase } from "./lab-run";

async function main() {
  const [c, , other] = CASES;
  if (!c || !other) return;
  let failed = 0;
  const s = await startCase(c);
  try {
    const { ws } = s;
    const before = await runTests(ws, c.ws);
    const contract: Contract = {
      tests: before.filter((x) => x.failed),
      typecheck: null,
    };
    const baseline = {
      workspaces: [c.ws],
      passing: before.filter((x) => !x.failed),
    };
    const edit = (path: string, old_text: string, new_text: string) =>
      ws.file("edit", { path, old_text, new_text });
    const testFile = `${ws.root}/${c.ws}/${contract.tests[0]?.file}`;
    const attempts: [string, string | null, () => Promise<unknown>][] = [
      ["the right fix", null, () => edit(c.file, c.put, c.find)],
      ["no change", "rules", async () => {}],
      [
        "wrong fix",
        "failing tests",
        () => edit(c.file, c.put, "items.at(0)?.id"),
      ],
      [
        "does not compile",
        "TypeScript",
        () => edit(c.file, c.put, "items.at(-1)?.nope"),
      ],
      [
        "breaks another feature",
        "nothing else broke",
        async () => {
          await edit(c.file, c.put, c.find);
          await edit(other.file, other.find, other.put);
        },
      ],
      [
        "deletes the failing test file",
        "rules",
        () => ws.exec(["rm", testFile]),
      ],
      [
        "weakens the test",
        "rules",
        () => ws.exec(["sed", "-i", "s/toHaveLength/not.toBe/", testFile]),
      ],
      [
        "behaves differently under test",
        "rules",
        () =>
          edit(c.file, c.put, "(process.env.VITEST ? items : rows).at(-1)?.id"),
      ],
    ];
    const only = process.argv[2];
    for (const [name, gate, make] of attempts) {
      if (only && !name.includes(only)) continue;
      await ws.file("reset");
      await make();
      const t0 = Date.now();
      const v = await verify(
        await s.fresh(),
        await ws.patch(),
        contract,
        baseline,
      );
      const bad = v.gates.find((g) => !g.ok);
      const ok = gate ? Boolean(!v.ok && bad?.name.startsWith(gate)) : v.ok;
      if (!ok) failed++;
      const took = Math.round((Date.now() - t0) / 1000);
      console.log(
        `${ok ? "OK     " : "BROKEN "} ${name.padEnd(32)} ${String(took).padStart(3)}s  ${bad ? `refused by "${bad.name}": ${bad.detail.replaceAll("\n", " ").slice(0, 90)}` : "accepted"}`,
      );
    }
  } finally {
    await s.end();
  }
  console.log(failed ? `\n${failed} BROKEN` : "\nEvery gate held.");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
