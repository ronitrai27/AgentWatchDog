// U3: Agent_2's check runner. Lint, TypeScript, tests and Semgrep run Agent_2's way (per package,
// with the detected tools, Semgrep counting only findings new since the base); every other check
// is the shared one, unchanged. A check never throws: a crash becomes an "error" result with the
// reason, and the run goes on.
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type CheckResult,
  type Installed,
  type RunInput,
  runCheck,
} from "../src/checks";
import { sandbox } from "../src/docker";
import { runDir } from "../src/env";
import { copyReports, junitCounts } from "../src/reports";
import type { Facts } from "../src/source";
import { volumes } from "../src/source";
import type { Plan2Item } from "./check-plan";
import type { Stack } from "./stack";

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const SEMGREP =
  "--config /opt/rules/registry --config /opt/rules/rox --metrics off --disable-version-check --quiet";

export async function runCheck2(
  input: RunInput,
  item: Plan2Item,
  facts: Facts,
  installed: Installed,
  prior: CheckResult[],
  stack: Stack | null,
  signal?: AbortSignal,
): Promise<CheckResult> {
  const base = { id: item.id, title: item.title };
  try {
    if (!item.applies)
      return {
        ...base,
        status: "skipped",
        summary: item.why ?? "",
        ms: 0,
        reports: [],
      };
    if (item.runner === "shared")
      return await runCheck(input, item, facts, installed, prior, signal);
    if (item.on === "work" && !installed.head)
      return {
        ...base,
        status: "error",
        summary: "dependencies were not installed",
        ms: 0,
        reports: [],
      };
    if (item.id === "lint") return await lint(input, item, stack, signal);
    if (item.id === "typecheck")
      return await typecheck(input, item, stack, signal);
    if (item.id === "test") return await tests(input, item, stack, signal);
    if (item.id === "semgrep") return await semgrep(input, item, signal);
    return await runCheck(input, item, facts, installed, prior, signal);
  } catch (e) {
    return {
      ...base,
      status: signal?.aborted ? "cancelled" : "error",
      summary:
        `Rox could not run this check (not a problem in your code): ${e instanceof Error ? e.message : String(e)}`.slice(
          0,
          400,
        ),
      ms: 0,
      reports: [],
    };
  }
}

async function exec(
  input: RunInput,
  id: string,
  script: string,
  signal?: AbortSignal,
  volume: "work" | "src" = "work",
) {
  const v = volumes(input.run);
  const r = await sandbox({
    name: `rox-${input.run}-${id}-a2`,
    run: input.run,
    script: `mkdir -p /out/${id}\n${script}`,
    mounts: [
      volume === "work"
        ? { volume: v.work, at: "/work", readOnly: false }
        : { volume: v.src, at: "/src", readOnly: true },
      { volume: v.out, at: "/out", readOnly: false },
    ],
    network: "none",
    workdir: volume === "work" ? "/work" : "/src",
    timeoutMs: id === "test" ? 15 * 60_000 : 10 * 60_000,
    env: {
      CI: "1",
      NO_COLOR: "1",
      NODE_ENV: "test",
      HOME: "/tmp",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*",
      ROX_BASE: input.base ?? "",
    },
    signal,
  });
  const copied = r.cancelled
    ? { files: [], rejected: [] }
    : await copyReports(input.run, id, signal);
  return { ...r, copied };
}

const tail = (s: string, n = 300) =>
  s.trim().split("\n").slice(-4).join(" | ").slice(-n);

/** Groups files by the deepest package folder in `dirs` that contains them, relative to it. */
function byPackage(
  dirs: string[],
  files: string[] | undefined,
): Map<string, string[] | null> {
  const out = new Map<string, string[] | null>();
  if (!files) {
    for (const d of dirs) out.set(d, null);
    return out;
  }
  for (const f of files) {
    const d = dirs
      .filter((x) => x === "." || f.startsWith(`${x}/`))
      .sort((a, b) => b.length - a.length)[0];
    if (!d) continue;
    out.set(d, [...(out.get(d) ?? []), d === "." ? f : f.slice(d.length + 1)]);
  }
  return out;
}

async function lint(
  input: RunInput,
  item: Plan2Item,
  stack: Stack | null,
  signal?: AbortSignal,
): Promise<CheckResult> {
  const lintersOf = new Map(
    (stack?.packages ?? []).map((p) => [p.dir, p.linters]),
  );
  const lines: string[] = ["code=0"];
  for (const [dir, files] of byPackage(item.packages ?? [], item.files)) {
    const targets = files ? files.map(q).join(" ") : ".";
    const cd = `cd /work/${dir === "." ? "" : q(dir)}`;
    for (const l of lintersOf.get(dir) ?? []) {
      const cmd =
        l === "biome"
          ? `npx --no-install biome check --no-errors-on-unmatched --files-ignore-unknown=true ${targets}`
          : l === "eslint"
            ? `npx --no-install eslint --no-warn-ignored ${targets}`
            : l === "prettier"
              ? `npx --no-install prettier --check --ignore-unknown ${targets}`
              : `npx --no-install oxlint ${targets}`;
      lines.push(`echo "== ${l} in ${dir}" >> /out/lint/output.txt`);
      lines.push(
        `(${cd} && ${cmd}) >> /out/lint/output.txt 2>&1; c=$?; [ $c -eq 1 ] && [ $code -ne 2 ] && code=1; [ $c -gt 1 ] && code=2`,
      );
    }
  }
  lines.push("tail -c 6000 /out/lint/output.txt; exit $code");
  const r = await exec(input, "lint", lines.join("\n"), signal);
  return result(item, r, r.code === 0 ? "passed" : tail(r.stdout));
}

async function typecheck(
  input: RunInput,
  item: Plan2Item,
  stack: Stack | null,
  signal?: AbortSignal,
): Promise<CheckResult> {
  const scripts = new Map(
    (stack?.packages ?? []).map((p) => [p.dir, p.scripts]),
  );
  const lines = ["code=0"];
  for (const dir of item.packages ?? []) {
    const cmd = scripts.get(dir)?.includes("typecheck")
      ? "npm run -s typecheck"
      : "npx --no-install tsc --noEmit -p .";
    lines.push(`echo "== ${dir}" >> /out/typecheck/output.txt`);
    lines.push(
      `(cd /work/${dir === "." ? "" : q(dir)} && ${cmd}) >> /out/typecheck/output.txt 2>&1; c=$?; [ $c -eq 1 -o $c -eq 2 ] && [ $code -ne 3 ] && code=1; [ $c -gt 2 ] && code=3`,
    );
  }
  lines.push("tail -c 6000 /out/typecheck/output.txt; exit $code");
  const r = await exec(input, "typecheck", lines.join("\n"), signal);
  return result(item, r, r.code === 0 ? "passed" : tail(r.stdout));
}

async function tests(
  input: RunInput,
  item: Plan2Item,
  stack: Stack | null,
  signal?: AbortSignal,
): Promise<CheckResult> {
  const runner = new Map(
    (stack?.packages ?? []).map((p) => [p.dir, p.testRunner]),
  );
  const lines = ["code=0"];
  for (const dir of item.packages ?? []) {
    const n = dir === "." ? "root" : dir.replace(/[^\w.-]/g, "_");
    const cmd =
      runner.get(dir) === "jest"
        ? `npx --no-install jest --ci --json --outputFile=/out/test/${n}.json`
        : `npx --no-install vitest run --reporter=default --reporter=junit --outputFile.junit=/out/test/${n}.xml`;
    lines.push(
      `echo ${q(dir)} > /out/test/${n}.ws.txt; echo "== ${dir}" >> /out/test/output.txt`,
    );
    lines.push(
      `(cd /work/${dir === "." ? "" : q(dir)} && ${cmd}) >> /out/test/output.txt 2>&1; c=$?; [ $c -ne 0 ] && code=1`,
    );
  }
  lines.push("tail -c 6000 /out/test/output.txt; exit $code");
  const r = await exec(input, "test", lines.join("\n"), signal);
  let total = 0;
  let failed = 0;
  const names: string[] = [];
  for (const f of r.copied.files) {
    const text = await readFile(path.join(runDir(input.run), f), "utf8").catch(
      () => "",
    );
    if (f.endsWith(".xml")) {
      const c = junitCounts(text);
      total += c.tests;
      failed += c.failed;
      names.push(...c.names);
    } else if (f.endsWith(".json")) {
      try {
        const j = JSON.parse(text) as {
          numTotalTests?: number;
          numFailedTests?: number;
          testResults?: {
            assertionResults?: { status: string; fullName: string }[];
          }[];
        };
        total += j.numTotalTests ?? 0;
        failed += j.numFailedTests ?? 0;
        for (const t of j.testResults ?? [])
          for (const a of t.assertionResults ?? [])
            if (a.status === "failed") names.push(a.fullName);
      } catch {}
    }
  }
  const counted = total > 0;
  const status: CheckResult["status"] = r.cancelled
    ? "cancelled"
    : r.timedOut
      ? "error"
      : r.code === 0
        ? "pass"
        : counted && failed > 0
          ? "fail"
          : "error";
  return {
    id: item.id,
    title: item.title,
    status,
    summary: counted
      ? failed
        ? `${failed} of ${total} tests failed: ${names.slice(0, 3).join("; ")}`
        : `${total} tests passed`
      : status === "pass"
        ? "passed"
        : tail(r.stdout),
    ms: r.ms,
    reports: r.copied.files,
    ...(counted ? { counts: { tests: total, failed } } : {}),
  };
}

type SemgrepJson = {
  results?: {
    check_id: string;
    path: string;
    start: { line: number };
    extra?: { lines?: string; message?: string };
  }[];
};

async function semgrep(
  input: RunInput,
  item: Plan2Item,
  signal?: AbortSignal,
): Promise<CheckResult> {
  const files = item.files ?? null;
  const list = files ? files.map(q).join(" ") : "";
  const script = files
    ? `set --
for f in ${list}; do [ -f "$f" ] && set -- "$@" "$f"; done
[ $# -eq 0 ] && { echo "no changed file to scan"; exit 0; }
semgrep scan ${SEMGREP} --sarif-output=/out/semgrep/semgrep.sarif --json-output=/out/semgrep/head.json "$@" > /out/semgrep/output.txt 2>&1 || true
if [ -n "$ROX_BASE" ]; then
  mkdir -p /tmp/b
  for f in "$@"; do git cat-file -e "$ROX_BASE:$f" 2>/dev/null && git show "$ROX_BASE:$f" > /tmp/b/.x && mkdir -p "/tmp/b/$(dirname "$f")" && mv /tmp/b/.x "/tmp/b/$f"; done
  cd /tmp/b && set -- && for f in ${list}; do [ -f "$f" ] && set -- "$@" "$f"; done
  if [ $# -gt 0 ]; then semgrep scan ${SEMGREP} --json-output=/out/semgrep/base.json "$@" >> /out/semgrep/output.txt 2>&1 || true; else echo '{"results":[]}' > /out/semgrep/base.json; fi
fi
tail -c 3000 /out/semgrep/output.txt; exit 0`
    : `semgrep scan ${SEMGREP} --exclude node_modules --sarif-output=/out/semgrep/semgrep.sarif --json-output=/out/semgrep/head.json /src > /out/semgrep/output.txt 2>&1 || true; tail -c 3000 /out/semgrep/output.txt; exit 0`;
  const r = await exec(input, "semgrep", script, signal, "src");
  if (r.cancelled)
    return {
      id: item.id,
      title: item.title,
      status: "cancelled",
      summary: "stopped: the run was cancelled",
      ms: r.ms,
      reports: [],
    };
  if (/no changed file to scan/.test(r.stdout))
    return {
      id: item.id,
      title: item.title,
      status: "pass",
      summary: "no changed file Semgrep can scan",
      ms: r.ms,
      reports: [],
    };
  const read = async (n: string) => {
    const f = r.copied.files.find((x) => x.endsWith(`/${n}`));
    if (!f) return null;
    try {
      return JSON.parse(
        await readFile(path.join(runDir(input.run), f), "utf8"),
      ) as SemgrepJson;
    } catch {
      return null;
    }
  };
  const head = await read("head.json");
  if (!head)
    return {
      id: item.id,
      title: item.title,
      status: "error",
      summary: `Semgrep did not finish: ${tail(r.stdout)}`,
      ms: r.ms,
      reports: r.copied.files,
    };
  const basej = files && input.base ? await read("base.json") : null;
  // A finding is "the same" when the rule, the file and the code line match, wherever the line moved.
  const key = (x: NonNullable<SemgrepJson["results"]>[number]) =>
    `${x.check_id}|${x.path}|${(x.extra?.lines ?? "").replace(/\s+/g, " ").trim()}`;
  const before = new Map<string, number>();
  for (const x of basej?.results ?? [])
    before.set(key(x), (before.get(key(x)) ?? 0) + 1);
  const fresh = (head.results ?? []).filter((x) => {
    const n = before.get(key(x)) ?? 0;
    if (n > 0) {
      before.set(key(x), n - 1);
      return false;
    }
    return true;
  });
  const old = (head.results ?? []).length - fresh.length;
  return {
    id: item.id,
    title: item.title,
    status: fresh.length ? "fail" : "pass",
    summary: fresh.length
      ? `${fresh.length} new finding${fresh.length === 1 ? "" : "s"}${old ? ` (${old} already on the base, not counted)` : ""}: ${fresh
          .slice(0, 3)
          .map(
            (x) =>
              `${x.check_id.split(".").pop()} in ${x.path}:${x.start.line}`,
          )
          .join(", ")}`
      : old
        ? `no new findings (${old} already on the base, not counted)`
        : "no findings",
    ms: r.ms,
    reports: r.copied.files,
    counts: { findings: fresh.length, existing: old },
  };
}

function result(
  item: Plan2Item,
  r: {
    code: number | null;
    ms: number;
    timedOut: boolean;
    cancelled: boolean;
    copied: { files: string[] };
  },
  summary: string,
): CheckResult {
  const status: CheckResult["status"] = r.cancelled
    ? "cancelled"
    : r.timedOut
      ? "error"
      : r.code === 0
        ? "pass"
        : r.code === 1
          ? "fail"
          : "error";
  return {
    id: item.id,
    title: item.title,
    status,
    summary: r.timedOut
      ? `timed out after ${Math.round(r.ms / 1000)}s`
      : summary,
    ms: r.ms,
    reports: r.copied.files,
  };
}
