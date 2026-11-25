// Verify: code decides whether a fix is good, never a model. The patch is applied to a fresh copy
// that the agent never touched, and every gate must pass.
import { inspectPatch } from "./policy";
import type { Workspace } from "./workspace";

export type TestId = { ws: string; file: string; name: string };
export type Failing = TestId & { message: string };

/** What the fix has to make true, frozen before any edit. */
export type Contract = {
  tests: Failing[];
  /** The type checker failed before the fix, so it has to pass after it. */
  typecheck: string | null;
};
/** Tests that passed before the fix, so they have to pass after it. */
export type Baseline = { workspaces: string[]; passing: TestId[] };

export type Gate = { name: string; ok: boolean; detail: string; ms: number };
export type Verdict = {
  ok: boolean;
  gates: Gate[];
  /** The sandbox failed, not the fix. Never counts as a failed attempt. */
  infra: boolean;
};

const RUNS = 5;
const same = (a: TestId, b: TestId) =>
  a.ws === b.ws && a.file === b.file && a.name === b.name;

export class InfraError extends Error {}

/** One run of test files. No result at all is a sandbox problem, not a failing test. */
export async function runTests(
  ws: Workspace,
  dir: string,
  files: string[] = [],
) {
  for (let i = 0; ; i++) {
    const r = await ws.tests(dir, files);
    if (r.cases.length > 0)
      return r.cases.map((c) => ({
        ws: dir,
        file: c.file,
        name: c.name,
        failed: c.failed,
        message: c.message,
      }));
    if (i === 1)
      throw new InfraError(
        `no test results from ${dir}: ${r.output.slice(-300)}`,
      );
  }
}

const shell = (ws: Workspace, script: string, args: string[], ms: number) =>
  ws.exec(["sh", "-c", `cd ${ws.root} && ${script}`, "sh", ...args], "", ms);

export async function typecheck(ws: Workspace): Promise<string | null> {
  const r = await shell(ws, "npm run typecheck 2>&1", [], 120_000);
  if (r.code === null || r.code === 124)
    throw new InfraError(`the type checker did not finish (exit ${r.code})`);
  if (r.code === 0) return null;
  const lines = r.stdout.split("\n");
  const errors = lines.filter((l) => /error TS\d+/.test(l));
  return (errors.length ? errors : lines)
    .slice(0, 12)
    .join("\n")
    .slice(0, 1500);
}

/** Lets the formatter fix style in the files the agent changed. No model is spent on it. */
export async function tidy(ws: Workspace, files: string[]): Promise<void> {
  if (files.length)
    await shell(
      ws,
      'npx --no-install biome format --write "$@"',
      files,
      60_000,
    );
}

export async function verify(
  fresh: Workspace,
  patch: string,
  contract: Contract,
  baseline: Baseline,
  onGate: (g: Gate) => Promise<unknown> = async () => {},
): Promise<Verdict> {
  const gates: Gate[] = [];
  const gate = async (
    name: string,
    check: () => Promise<string | null> | string | null,
  ) => {
    const t0 = Date.now();
    const problem = await check();
    const g: Gate = {
      name,
      ok: problem === null,
      detail: problem ?? "",
      ms: Date.now() - t0,
    };
    gates.push(g);
    await onGate(g);
    return g.ok;
  };
  const facts = inspectPatch(patch);
  const done = (infra = false): Verdict => ({
    ok: !infra && gates.length > 0 && gates.every((g) => g.ok),
    gates,
    infra,
  });

  const checks: [string, () => Promise<string | null> | string | null][] = [
    // Cheapest first; the first failure stops it, the rest would only be noise.
    ["rules", () => facts.problems.join("; ") || null],
    [
      "applies cleanly",
      async () => {
        const r = await fresh.exec(
          ["git", "-C", fresh.root, "apply", "--whitespace=nowarn", "-"],
          patch,
        );
        return r.code === 0 ? null : r.stderr.slice(0, 300);
      },
    ],
    [
      "no secrets",
      async () => {
        const r = await fresh.exec(
          ["gitleaks", "stdin", "--no-banner", "--redact"],
          patch,
        );
        if (r.code === 0) return null;
        if (r.code === 1) return "the patch contains something like a secret";
        throw new InfraError(
          `gitleaks exit ${r.code}: ${r.stderr.slice(-200)}`,
        );
      },
    ],
    ["types", () => typecheck(fresh)],
    [
      `failing tests pass ${RUNS} of ${RUNS}`,
      async () => {
        const dirs = [...new Set(contract.tests.map((t) => t.ws))];
        for (let i = 1; i <= RUNS; i++)
          for (const dir of dirs) {
            const mine = contract.tests.filter((t) => t.ws === dir);
            const cases = await runTests(fresh, dir, [
              ...new Set(mine.map((t) => t.file)),
            ]);
            for (const t of mine) {
              const c = cases.find((x) => same(x, t));
              if (!c) return `"${t.name}" no longer exists (run ${i})`;
              if (c.failed)
                return `"${t.name}" still fails (run ${i} of ${RUNS}): ${c.message.slice(0, 500)}`;
            }
          }
        return null;
      },
    ],
    [
      "nothing else broke",
      async () => {
        for (const dir of baseline.workspaces) {
          const cases = await runTests(fresh, dir);
          const before = baseline.passing.filter((t) => t.ws === dir);
          const gone = before.filter((t) => !cases.some((c) => same(c, t)));
          if (gone.length)
            return `${gone.length} tests disappeared, such as "${gone[0]?.name}"`;
          const broke = before.filter((t) =>
            cases.some((c) => c.failed && same(c, t)),
          );
          if (!broke.length) continue;
          // Once more, alone: a test that passes now was noise, not this patch.
          const again = await runTests(fresh, dir, [
            ...new Set(broke.map((t) => t.file)),
          ]);
          const real = again.filter(
            (c) => c.failed && broke.some((t) => same(c, t)),
          );
          if (real.length)
            return `broke "${real[0]?.name}": ${real[0]?.message.slice(0, 500)}`;
        }
        return null;
      },
    ],
    [
      "lint",
      async () => {
        const r = await shell(
          fresh,
          'npx --no-install biome check "$@" 2>&1',
          facts.files,
          60_000,
        );
        return r.code === 0 ? null : r.stdout.slice(-600);
      },
    ],
    [
      "build",
      async () => {
        // A build can fail from machine load alone (seen once here), so it gets a second try.
        for (let i = 1; ; i++) {
          const r = await shell(
            fresh,
            "env -u NODE_ENV NEXT_TELEMETRY_DISABLED=1 npm run build 2>&1",
            [],
            240_000,
          );
          if (r.code === 0) return null;
          if (i < 2) continue;
          if (r.code === null || r.code === 124)
            throw new InfraError("the build did not finish");
          return `exit ${r.code}: ${r.stdout.slice(-800)}`;
        }
      },
    ],
  ];

  try {
    for (const [name, check] of checks)
      if (!(await gate(name, check))) return done();
    return done();
  } catch (error) {
    if (!(error instanceof InfraError)) throw error;
    await gate("sandbox", () => error.message);
    return done(true);
  }
}
