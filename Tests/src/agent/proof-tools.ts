// Proves the agent's sandbox tools and path rules, without any AI.   pnpm --dir Tests proof:tools
import { CASES } from "./cases";
import { startCase } from "./lab-run";
import { editDenied, inspectPatch } from "./policy";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(
    `${ok ? "OK     " : "BROKEN "} ${name.padEnd(46)} ${detail.replaceAll("\n", " ").slice(0, 90)}`,
  );
};

async function main() {
  const c = CASES[0];
  const t0 = Date.now();
  const s = await startCase(c);
  console.log(`prepared in ${Math.round((Date.now() - t0) / 1000)}s`);
  try {
    const { ws } = s;
    const list = await ws.file("list", { dir: "apps/api/src/modules" });
    check(
      "list_files",
      list.ok && JSON.stringify(list.files).includes("catalog.service.ts"),
    );
    const found = await ws.file("search", { text: "nextCursor" });
    check(
      "search_code",
      found.ok && JSON.stringify(found.matches).includes("catalog.service.ts:"),
    );
    const read = await ws.file("read", { path: c.file });
    check("read_file", read.ok && String(read.text).includes(c.put));
    for (const [name, p] of [
      ["parent folder", "../etc/passwd"],
      ["absolute path", "/etc/passwd"],
      ["node_modules", "node_modules/zod/package.json"],
      ["git folder", ".git/config"],
    ] as const) {
      const r = await ws.file("read", { path: p });
      check(`read refused: ${name}`, !r.ok, r.error);
    }
    await ws.exec(["sh", "-c", "ln -s /etc/passwd /agent/leak.ts"]);
    const link = await ws.file("read", { path: "leak.ts" });
    check("read refused: link out of the repository", !link.ok, link.error);
    await ws.exec(["rm", "/agent/leak.ts"]);
    const missing = await ws.file("edit", {
      path: c.file,
      old_text: "not there",
      new_text: "x",
    });
    check("edit refused: text not found", !missing.ok, missing.error);

    for (const p of [
      "apps/api/test/integration/catalog.test.ts",
      ".github/workflows/ci.yml",
      "package.json",
      "apps/api/migrations/0001_init.sql",
      "src/auth/login.ts",
      "tsconfig.base.json",
      "vitest.config.ts",
      ".env",
    ])
      check(`policy refuses ${p}`, editDenied(p) !== null, editDenied(p) ?? "");
    check("policy allows source", editDenied(c.file) === null);

    const before = await ws.tests(c.ws);
    const failing = before.cases.filter((x) => x.failed);
    check(
      "the seeded bug breaks exactly its test",
      failing.length === 1 && failing[0]?.name === c.test,
      failing.map((f) => f.name).join(", "),
    );
    check(
      "failure message is captured",
      (failing[0]?.message ?? "").length > 20,
      failing[0]?.message,
    );

    const edit = await ws.file("edit", {
      path: c.file,
      old_text: c.put,
      new_text: c.find,
    });
    check("edit_file", edit.ok, edit.error);
    const after = await ws.tests(c.ws, [failing[0]?.file ?? ""]);
    check(
      "the known fix makes it pass",
      after.ok && after.cases.length > 0 && after.cases.every((x) => !x.failed),
    );
    const facts = inspectPatch(await ws.patch());
    check(
      "the patch is small and clean",
      facts.problems.length === 0 && facts.files.length === 1,
      JSON.stringify(facts),
    );
    await ws.file("reset");
    check("reset restores the starting point", (await ws.patch()) === "");
  } finally {
    await s.end();
  }
  console.log(failed ? `\n${failed} BROKEN` : "\nEverything held.");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
