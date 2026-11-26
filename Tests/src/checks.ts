// The checks. Each one runs in its own sandbox, writes its reports to /out/<id>, and ends with
// one plain result: pass, fail, skipped (with the reason) or error (with the reason).
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createNetwork,
  type Mount,
  type Network,
  sandbox,
  serviceLogs,
  startEgress,
  stopService,
} from "./docker";
import { runDir } from "./env";
import {
  type Copied,
  copyReports,
  junitCases,
  junitCounts,
  sarifCounts,
} from "./reports";
import type { Facts } from "./source";
import { networks, volumes } from "./source";
import { ensureStage, ensureToxiproxy, hostOf } from "./stage";

export type Area = "quality" | "security" | "performance" | "reliability";
export type CheckStatus = "pass" | "fail" | "skipped" | "error" | "cancelled";

export type CheckId =
  | "lint"
  | "format"
  | "typecheck"
  | "test"
  | "build"
  | "replay"
  | "flaky"
  | "mutation"
  | "semgrep"
  | "gitleaks"
  | "osv"
  | "trivy"
  | "k6"
  | "perf-compare"
  | "toxiproxy"
  | "schemathesis";

export type PlanItem = {
  id: CheckId;
  title: string;
  area: Area;
  /** Runs on the installed copies (needs dependencies) or on the read-only source. */
  on: "work" | "source";
  applies: boolean;
  why?: string;
};

export type CheckResult = {
  id: CheckId;
  title: string;
  status: CheckStatus;
  summary: string;
  ms: number;
  reports: string[];
  counts?: Record<string, number>;
};

export type RunInput = {
  run: string;
  repo: string;
  head: string;
  base: string | null;
  pr: number | null;
  /** "full" runs k6, the performance comparison, Toxiproxy and Schemathesis even when no server code changed. */
  profile?: "fast" | "full";
};

/** Did the change touch the code of a service the app runs (not its tests)? */
export function touchesServer(files: string[], stage: Facts["stage"]): boolean {
  const dirs = (stage?.services ?? []).map(
    (s) => `${s.dir.replace(/\/$/, "")}/`,
  );
  return files.some(
    (f) =>
      SOURCE_FILE.test(f) &&
      !TEST_FILE.test(f) &&
      dirs.some((d) => f.startsWith(d)),
  );
}

/** Did the change touch API routes or the API spec? */
export const touchesRoutes = (files: string[]) =>
  files.some((f) =>
    /(route|router|controller|handler|endpoint)s?\.\w+$|(^|\/)(openapi|swagger)\.(ya?ml|json)$/i.test(
      f,
    ),
  );

export type Installed = { head: boolean; base: boolean; summary: string };

/** Below this mutation score on the changed code, the check fails. */
const MUTATION_THRESHOLD = 60;
/** At most this many changed files are mutated, so the run stays in minutes. */
const MUTATION_MAX_FILES = 6;
const FLAKY_RUNS = 5;

const SOURCE_FILE = /\.(ts|tsx|js|mjs|cjs)$/;
const TEST_FILE = /(\.(test|spec)\.\w+$)|(^|\/)(test|tests|__tests__)\//;

/** The workspace folder a file belongs to, from the root package.json's workspace patterns. */
function workspaceOf(file: string, f: Facts): string | null {
  for (const pattern of f.workspaces) {
    if (pattern.endsWith("/*")) {
      const root = pattern.slice(0, -1);
      if (file.startsWith(root)) {
        const name = file.slice(root.length).split("/")[0];
        return name ? `${root}${name}` : null;
      }
    } else if (file.startsWith(`${pattern}/`)) return pattern;
  }
  return null;
}

/** Changed source files to mutate, grouped by workspace. */
function mutationTargets(f: Facts): Map<string, string[]> {
  const byWs = new Map<string, string[]>();
  let count = 0;
  for (const file of f.changed) {
    if (
      !SOURCE_FILE.test(file) ||
      TEST_FILE.test(file) ||
      count >= MUTATION_MAX_FILES
    )
      continue;
    const ws = workspaceOf(file, f);
    if (!ws) continue;
    byWs.set(ws, [...(byWs.get(ws) ?? []), file.slice(ws.length + 1)]);
    count++;
  }
  return byWs;
}

/** Which checks apply to this repository, and why the others do not. */
export function planChecks(
  f: Facts,
  hasBase: boolean,
  profile: "fast" | "full" = "full",
): PlanItem[] {
  const item = (
    id: CheckId,
    title: string,
    area: Area,
    on: PlanItem["on"],
    applies: boolean,
    why?: string,
  ): PlanItem => ({
    id,
    title,
    area,
    on,
    applies,
    ...(applies ? {} : { why }),
  });
  const linter = [f.biome && "Biome", f.eslint && "ESLint"]
    .filter(Boolean)
    .join(" + ");
  const tests = f.vitest || Boolean(f.scripts.test);
  const app = f.stage !== null;
  const full = profile === "full";
  const server = full || touchesServer(f.changed, f.stage);
  const routes = full || touchesRoutes(f.changed);
  const notServer = hasBase
    ? "the change does not touch server code"
    : "no base commit, so what changed is unknown";
  return [
    item(
      "lint",
      `Lint + format (${linter || "none"})`,
      "quality",
      "work",
      Boolean(linter),
      "no Biome or ESLint config",
    ),
    //     item(
    //       "format",
    //       `Format (${formatter || "none"})`,
    //       "quality",
    //       "work",
    //       Boolean(formatter),
    //       "no Biome or Prettier config",
    //     ),
    item(
      "typecheck",
      "TypeScript",
      "quality",
      "work",
      f.typescript,
      "no tsconfig.json",
    ),
    item("test", "Tests (Vitest)", "quality", "work", tests, "no test script"),
    item(
      "build",
      "Production build",
      "quality",
      "work",
      Boolean(f.scripts.build),
      "no build script",
    ),
    //     item(
    //       "replay",
    //       "Regression replay (base vs head)",
    //       "reliability",
    //       "work",
    //       tests && hasBase,
    //       hasBase ? "no tests" : "no base commit to compare with",
    //     ),
    //     item(
    //       "flaky",
    //       `Flaky test detection (${FLAKY_RUNS} runs)`,
    //       "reliability",
    //       "work",
    //       f.vitest,
    //       "no Vitest",
    //     ),
    //     item(
    //       "mutation",
    //       "Mutation testing (Stryker)",
    //       "quality",
    //       "work",
    //       f.vitest && mutable,
    //       !f.vitest
    //         ? "no Vitest"
    //         : !hasBase
    //           ? "no base commit, so the changed files are unknown"
    //           : "no source files changed in a Vitest workspace",
    //     ),
    item("semgrep", "Semgrep (SAST)", "security", "source", true),
    item("gitleaks", "Gitleaks (secrets)", "security", "source", true),
    item(
      "osv",
      "OSV-Scanner (dependencies)",
      "security",
      "source",
      f.lockfiles.length > 0,
      "no lockfile",
    ),
    item("trivy", "Trivy (filesystem and IaC)", "security", "source", true),
    item(
      "k6",
      "k6 (smoke and load)",
      "performance",
      "work",
      app && Boolean(f.k6Script) && server,
      !app
        ? "no way to run the app is known"
        : !f.k6Script
          ? "no k6 script in the repository or the lab fixtures"
          : notServer,
    ),
    item(
      "perf-compare",
      "Performance against the base",
      "reliability",
      "work",
      app && Boolean(f.k6Script) && hasBase && server,
      !hasBase
        ? "no base commit to compare with"
        : !app || !f.k6Script
          ? "needs the app and a k6 script"
          : notServer,
    ),
    item(
      "toxiproxy",
      "Toxiproxy (network faults)",
      "performance",
      "work",
      app && server,
      !app ? "no way to run the app is known" : notServer,
    ),
    item(
      "schemathesis",
      "Schemathesis (API fuzzing)",
      "security",
      "work",
      app && Boolean(f.openapi) && routes,
      !app
        ? "no way to run the app is known"
        : !f.openapi
          ? "no OpenAPI spec in the repository or the lab fixtures"
          : hasBase
            ? "no API route or spec changed"
            : "no base commit, so what changed is unknown",
    ),
  ];
}

// --- static checks: a single command each

/** Workspaces whose test script runs Vitest, as folders (run from the copy's root). */
const VITEST_DIRS = `node -e '
const fs=require("fs"),path=require("path");const root=require("./package.json");
const ws=(root.workspaces||[]).flatMap(w=>w.endsWith("/*")?fs.readdirSync(w.slice(0,-2)).map(d=>w.slice(0,-1)+d):[w]);
for(const d of ws){try{const p=require(path.resolve(d,"package.json"));if(/vitest/.test((p.scripts||{}).test||""))console.log(d)}catch{}}'`;

const tailOf = (id: string) =>
  `code=$?; tail -c 6000 /out/${id}/output.txt 2>/dev/null; exit $code`;

function staticScript(id: CheckId, f: Facts, input: RunInput): string {
  const out = `/out/${id}`;
  const start = `mkdir -p ${out}; `;
  switch (id) {
    case "lint":
      return `${start}code=0
${f.biome ? `npx --no-install biome check . >> ${out}/output.txt 2>&1 || code=1` : ""}
${f.prettier ? `npx --no-install prettier --check . >> ${out}/output.txt 2>&1 || code=1` : ""}
${f.eslint ? `npx --no-install eslint . -f json -o ${out}/eslint.json >> ${out}/output.txt 2>&1 || code=1` : ""}
tail -c 6000 ${out}/output.txt; exit $code`;
    case "format":
      return `${start}code=0
${f.biome ? `npx --no-install biome format . >> ${out}/output.txt 2>&1 || code=1` : ""}
${f.prettier ? `npx --no-install prettier --check . >> ${out}/output.txt 2>&1 || code=1` : ""}
tail -c 6000 ${out}/output.txt; exit $code`;
    case "typecheck":
      return `${start}${f.scripts.typecheck ? "npm run typecheck" : "npx --no-install tsc --noEmit -p ."} > ${out}/output.txt 2>&1; ${tailOf(id)}`;
    case "test":
      return `${start}code=0; ran=0
for d in $(${VITEST_DIRS}); do
  ran=1; n=$(echo "$d" | tr / _)
  echo "$d" > ${out}/$n.ws.txt
  echo "== $d" >> ${out}/output.txt
  (cd "$d" && npx --no-install vitest run --reporter=default --reporter=junit --outputFile.junit=${out}/$n.xml) >> ${out}/output.txt 2>&1 || code=1
done
if [ $ran = 0 ]; then npm test > ${out}/output.txt 2>&1 || code=1; fi
tail -c 6000 ${out}/output.txt; exit $code`;
    case "build":
      return `${start}npm run build > ${out}/output.txt 2>&1; ${tailOf(id)}`;
    case "semgrep":
      return `${start}semgrep scan --config /opt/rules/registry --config /opt/rules/rox --sarif --output ${out}/semgrep.sarif --error --metrics off --disable-version-check --quiet --exclude node_modules /src > ${out}/output.txt 2>&1; ${tailOf(id)}`;
    case "gitleaks": {
      const range = input.base
        ? `--log-opts="${input.base}..${input.head}"`
        : "";
      return `${start}gitleaks git ${range} --report-format sarif --report-path ${out}/gitleaks.sarif --no-banner --redact /src > ${out}/output.txt 2>&1; ${tailOf(id)}`;
    }
    case "osv":
      return `${start}osv-scanner scan source --offline-vulnerabilities --format sarif -r /src > ${out}/osv.sarif 2> ${out}/output.txt; code=$?; tail -c 6000 ${out}/output.txt; exit $code`;
    case "trivy":
      return `${start}trivy fs --skip-db-update --offline-scan --cache-backend memory --scanners vuln,misconfig,secret --severity HIGH,CRITICAL --exit-code 1 --no-progress --format sarif --output ${out}/trivy.sarif /src > ${out}/output.txt 2>&1; ${tailOf(id)}`;
    default:
      return `echo "${id} has no single command"; exit 2`;
  }
}

/** Exit codes that mean "the tool found problems", per tool. Anything else non-zero is an error. */
const FOUND: Partial<Record<CheckId, number[]>> = {
  lint: [1],
  format: [1],
  typecheck: [1, 2],
  test: [1],
  build: [1],
  semgrep: [1],
  gitleaks: [1],
  osv: [1],
  trivy: [1],
  k6: [99],
  toxiproxy: [1],
  schemathesis: [1],
};

const firstLines = (text: string, n = 3) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /error|fail|✗|×|expected/i.test(l))
    .slice(0, n)
    .join(" | ")
    .slice(0, 300);

const readRun = (run: string, file: string) =>
  readFile(path.join(runDir(run), file), "utf8");

async function summarizeStatic(
  id: CheckId,
  status: CheckStatus,
  copied: Copied,
  output: string,
  run: string,
): Promise<{ summary: string; counts?: Record<string, number> }> {
  const xml = copied.files.filter((f) => f.endsWith(".xml"));
  const sarif = copied.files.find((f) => f.endsWith(".sarif"));
  if (id === "test" && xml.length) {
    let tests = 0;
    let failed = 0;
    const names: string[] = [];
    for (const f of xml) {
      const c = junitCounts(await readRun(run, f));
      tests += c.tests;
      failed += c.failed;
      names.push(...c.names);
    }
    return {
      summary: failed
        ? `${failed} of ${tests} tests failed: ${names.slice(0, 3).join("; ")}`
        : `${tests} tests passed`,
      counts: { tests, failed },
    };
  }
  if (sarif) {
    const c = sarifCounts(await readRun(run, sarif));
    return {
      summary: c.findings
        ? `${c.findings} finding${c.findings === 1 ? "" : "s"}: ${c.top.map(([r, n]) => `${r.split(".").pop()} (${n})`).join(", ")}`
        : "no findings",
      counts: { findings: c.findings },
    };
  }
  if (status === "pass") return { summary: "passed" };
  return {
    summary:
      firstLines(output) ||
      output.trim().split("\n").slice(-2).join(" ").slice(0, 300),
  };
}

// --- one sandbox for a check, then its reports

type Exec = {
  code: number | null;
  output: string;
  ms: number;
  timedOut: boolean;
  cancelled: boolean;
  copied: Copied;
};

async function execCheck(
  input: RunInput,
  id: CheckId,
  script: string,
  options: {
    mounts: Mount[];
    network?: Network;
    workdir: string;
    timeoutMs: number;
    env?: Record<string, string>;
    name?: string;
    signal?: AbortSignal;
    copy?: boolean;
  },
): Promise<Exec> {
  const v = volumes(input.run);
  const r = await sandbox({
    name: options.name ?? `rox-${input.run}-${id}`,
    run: input.run,
    script,
    mounts: [...options.mounts, { volume: v.out, at: "/out", readOnly: false }],
    network: options.network ?? "none",
    workdir: options.workdir,
    timeoutMs: options.timeoutMs,
    env: {
      CI: "1",
      NO_COLOR: "1",
      // The source volume is owned by root (copied in with docker cp) and read-only; tell git
      // that reading it as the sandbox user is expected.
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*",
      ...options.env,
    },
    signal: options.signal,
  });
  const cancelled = r.cancelled || Boolean(options.signal?.aborted);
  const copied =
    cancelled || options.copy === false
      ? { files: [], rejected: [] }
      : await copyReports(input.run, id, options.signal);
  return {
    code: r.code,
    output: r.stdout + r.stderr,
    ms: r.ms,
    timedOut: r.timedOut,
    cancelled,
    copied,
  };
}

const refused = (c: Copied) =>
  c.rejected.length
    ? ` (${c.rejected.length} report file(s) refused: ${c.rejected.map((r) => `${r.name}: ${r.why}`).join(", ")})`
    : "";

function statusOf(id: CheckId, e: Exec): CheckStatus {
  if (e.cancelled) return "cancelled";
  if (e.timedOut) return "error";
  if (e.code === 0) return "pass";
  if ((FOUND[id] ?? []).includes(e.code ?? -1)) return "fail";
  if (id === "osv" && e.code === 128) return "skipped";
  return "error";
}

const errorSummary = (e: Exec) =>
  e.timedOut
    ? `timed out after ${Math.round(e.ms / 1000)}s`
    : `exit ${e.code}: ${firstLines(e.output) || e.output.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`;

// --- checks that need more than one command, or the running app

async function replay(
  input: RunInput,
  item: PlanItem,
  prior: CheckResult[],
  signal?: AbortSignal,
): Promise<Omit<CheckResult, "id" | "title">> {
  const test = prior.find((r) => r.id === "test");
  const xml = (test?.reports ?? []).filter((f) => f.endsWith(".xml"));
  const failing: { ws: string; n: string; file: string; name: string }[] = [];
  for (const f of xml) {
    const n = path.basename(f, ".xml");
    const ws = (
      await readRun(input.run, `reports/test/${n}.ws.txt`).catch(() =>
        n.replaceAll("_", "/"),
      )
    ).trim();
    for (const c of junitCases(await readRun(input.run, f)))
      if (c.failed) failing.push({ ws, n, file: c.file, name: c.name });
  }
  if (!test || test.status === "error")
    return {
      status: "error",
      summary: "the test check did not produce results",
      ms: 0,
      reports: [],
    };
  if (failing.length === 0)
    return {
      status: "pass",
      summary: "nothing to replay: every test passes on head",
      ms: 0,
      reports: [],
    };

  const groups = new Map<string, { n: string; files: Set<string> }>();
  for (const f of failing) {
    const g = groups.get(f.ws) ?? { n: f.n, files: new Set<string>() };
    g.files.add(f.file);
    groups.set(f.ws, g);
  }
  const lines = [`mkdir -p /out/${item.id}`];
  for (const [ws, g] of groups) {
    const files = [...g.files]
      .map((f) => `'${f.replaceAll("'", "")}'`)
      .join(" ");
    lines.push(
      `for f in ${files}; do [ -f "/base/${ws}/$f" ] || echo "${ws}|$f" >> /out/${item.id}/missing-on-base.txt; done`,
      `(cd /base/${ws} && npx --no-install vitest run ${files} --reporter=junit --outputFile.junit=/out/${item.id}/base-${g.n}.xml) >> /out/${item.id}/output.txt 2>&1`,
      `(cd /work/${ws} && npx --no-install vitest run ${files} --reporter=junit --outputFile.junit=/out/${item.id}/head-${g.n}.xml) >> /out/${item.id}/output.txt 2>&1`,
    );
  }
  lines.push("exit 0");
  const v = volumes(input.run);
  const e = await execCheck(input, item.id, lines.join("\n"), {
    mounts: [
      { volume: v.work, at: "/work", readOnly: false },
      { volume: v.base, at: "/base", readOnly: false },
    ],
    workdir: "/work",
    timeoutMs: 10 * 60_000,
    signal,
  });
  if (e.cancelled || e.timedOut || e.code !== 0)
    return {
      status: statusOf(item.id, e),
      summary: errorSummary(e),
      ms: e.ms,
      reports: e.copied.files,
    };

  const missing = new Set(
    (
      await readRun(input.run, `reports/${item.id}/missing-on-base.txt`).catch(
        () => "",
      )
    )
      .split("\n")
      .filter(Boolean),
  );
  const casesOf = async (prefix: string, n: string) =>
    junitCases(
      await readRun(input.run, `reports/${item.id}/${prefix}-${n}.xml`).catch(
        () => "",
      ),
    );
  const rows: { test: string; verdict: string }[] = [];
  for (const f of failing) {
    const head = (await casesOf("head", f.n)).find(
      (c) => c.file === f.file && c.name === f.name,
    );
    const base = (await casesOf("base", f.n)).find(
      (c) => c.file === f.file && c.name === f.name,
    );
    const verdict = !head?.failed
      ? "did not fail again on head (possibly flaky)"
      : missing.has(`${f.ws}|${f.file}`)
        ? "new failing test file added by this change"
        : !base
          ? "new failing test case added by this change"
          : base.failed
            ? "already failing on the base (not caused by this change)"
            : "regression: passes on the base, fails on head";
    rows.push({ test: `${f.ws}/${f.file} > ${f.name}`, verdict });
  }
  const file = `reports/${item.id}/replay.json`;
  await writeFile(
    path.join(runDir(input.run), file),
    JSON.stringify(rows, null, 2),
  );
  const introduced = rows.filter((r) =>
    /added by this change|regression/.test(r.verdict),
  );
  return {
    status: introduced.length ? "fail" : "pass",
    summary: rows
      .map((r) => `${r.test}: ${r.verdict}`)
      .join("; ")
      .slice(0, 400),
    ms: e.ms,
    reports: [...e.copied.files, file],
    counts: { replayed: rows.length, introduced: introduced.length },
  };
}

async function flaky(
  input: RunInput,
  item: PlanItem,
  signal?: AbortSignal,
): Promise<Omit<CheckResult, "id" | "title">> {
  const script = `mkdir -p /out/${item.id}
for i in $(seq 1 ${FLAKY_RUNS}); do
  for d in $(${VITEST_DIRS}); do
    n=$(echo "$d" | tr / _)
    (cd "$d" && npx --no-install vitest run --reporter=junit --outputFile.junit=/out/${item.id}/$n-run$i.xml) >> /out/${item.id}/output.txt 2>&1
  done
done
exit 0`;
  const v = volumes(input.run);
  const e = await execCheck(input, item.id, script, {
    mounts: [{ volume: v.work, at: "/work", readOnly: false }],
    workdir: "/work",
    timeoutMs: 20 * 60_000,
    signal,
  });
  if (e.cancelled || e.timedOut || e.code !== 0)
    return {
      status: statusOf(item.id, e),
      summary: errorSummary(e),
      ms: e.ms,
      reports: e.copied.files,
    };
  const seen = new Map<string, { pass: number; fail: number }>();
  for (const f of e.copied.files.filter((x) => x.endsWith(".xml"))) {
    const ws = path.basename(f).replace(/-run\d+\.xml$/, "");
    for (const c of junitCases(await readRun(input.run, f))) {
      const key = `${ws}: ${c.file} > ${c.name}`;
      const s = seen.get(key) ?? { pass: 0, fail: 0 };
      if (c.failed) s.fail++;
      else s.pass++;
      seen.set(key, s);
    }
  }
  const flakyTests = [...seen].filter(([, s]) => s.pass > 0 && s.fail > 0);
  const always = [...seen].filter(([, s]) => s.pass === 0 && s.fail > 0);
  const file = `reports/${item.id}/flaky.json`;
  await writeFile(
    path.join(runDir(input.run), file),
    JSON.stringify(Object.fromEntries(seen), null, 2),
  );
  return {
    status: flakyTests.length ? "fail" : "pass",
    summary: `${seen.size} tests x ${FLAKY_RUNS} runs: ${flakyTests.length} flaky${
      flakyTests.length
        ? ` (${flakyTests
            .map(([k, s]) => `${k} failed ${s.fail}/${FLAKY_RUNS}`)
            .slice(0, 3)
            .join("; ")})`
        : ""
    }, ${always.length} failing every time`,
    ms: e.ms,
    reports: [file],
    counts: {
      tests: seen.size,
      flaky: flakyTests.length,
      alwaysFailing: always.length,
    },
  };
}

async function mutation(
  input: RunInput,
  item: PlanItem,
  facts: Facts,
  signal?: AbortSignal,
): Promise<Omit<CheckResult, "id" | "title">> {
  const targets = mutationTargets(facts);
  const lines = [`mkdir -p /out/${item.id}; code=0`];
  for (const [ws, files] of targets) {
    const n = ws.replaceAll("/", "_");
    lines.push(
      `echo "== ${ws}: ${files.join(", ")}" >> /out/${item.id}/output.txt`,
      `(cd /work/${ws} && npx --no-install stryker run --testRunner vitest --plugins @stryker-mutator/vitest-runner --mutate "${files.join(",")}" --reporters clear-text,json --jsonReporter.fileName /out/${item.id}/${n}.json --concurrency 2 --timeoutMS 20000 --ignoreStatic --cleanTempDir always) >> /out/${item.id}/output.txt 2>&1 || code=1`,
    );
  }
  lines.push(`tail -c 4000 /out/${item.id}/output.txt; exit $code`);
  const v = volumes(input.run);
  const e = await execCheck(input, item.id, lines.join("\n"), {
    mounts: [{ volume: v.work, at: "/work", readOnly: false }],
    workdir: "/work",
    timeoutMs: 25 * 60_000,
    signal,
  });
  if (e.cancelled || e.timedOut || e.code !== 0)
    return {
      status: statusOf(item.id, e),
      summary: errorSummary(e),
      ms: e.ms,
      reports: e.copied.files,
    };
  const tally: Record<string, number> = {};
  const survivors: string[] = [];
  for (const f of e.copied.files.filter((x) => x.endsWith(".json"))) {
    const report = JSON.parse(await readRun(input.run, f)) as {
      files?: Record<
        string,
        {
          mutants?: {
            status: string;
            mutatorName?: string;
            location?: { start?: { line?: number } };
          }[];
        }
      >;
    };
    for (const [file, data] of Object.entries(report.files ?? {}))
      for (const m of data.mutants ?? []) {
        tally[m.status] = (tally[m.status] ?? 0) + 1;
        if (m.status === "Survived" || m.status === "NoCoverage")
          survivors.push(
            `${file}:${m.location?.start?.line ?? "?"} ${m.mutatorName ?? ""}`,
          );
      }
  }
  const caught = (tally.Killed ?? 0) + (tally.Timeout ?? 0);
  const counted = caught + (tally.Survived ?? 0) + (tally.NoCoverage ?? 0);
  if (!counted)
    return {
      status: "skipped",
      summary: "Stryker found nothing to mutate in the changed files",
      ms: e.ms,
      reports: e.copied.files,
    };
  const score = Math.round((caught / counted) * 100);
  return {
    status: score >= MUTATION_THRESHOLD ? "pass" : "fail",
    summary: `mutation score ${score}% (threshold ${MUTATION_THRESHOLD}%): ${caught} of ${counted} mutants caught by the tests${survivors.length ? `; not caught: ${survivors.slice(0, 3).join("; ")}` : ""}`,
    ms: e.ms,
    reports: e.copied.files,
    counts: { score, mutants: counted, survived: counted - caught },
  };
}

/** The app under test is started for these checks; this says why if it could not be. */
async function stageReady(
  input: RunInput,
  facts: Facts,
  sides: ("head" | "base")[],
  signal?: AbortSignal,
) {
  for (const side of sides) {
    const s = await ensureStage(input.run, facts, side, signal);
    if (!s.ok) return s.detail;
  }
  return null;
}

type K6Summary = {
  metrics?: Record<
    string,
    Record<string, number> & { thresholds?: Record<string, { ok: boolean }> }
  >;
};

function k6Numbers(summary: K6Summary, phase?: string) {
  const m = summary.metrics ?? {};
  const d =
    m[phase ? `http_req_duration{phase:${phase}}` : "http_req_duration"] ?? {};
  const failed =
    m[phase ? `http_req_failed{phase:${phase}}` : "http_req_failed"] ?? {};
  return {
    p95: Math.round(d["p(95)"] ?? Number.NaN),
    p99: Math.round(d["p(99)"] ?? Number.NaN),
    errors: Number(failed.value ?? failed.rate ?? 0),
    requests: Math.round(m.http_reqs?.count ?? 0),
    thresholdsOk: Object.values({
      ...d.thresholds,
      ...failed.thresholds,
    }).every((t) => t.ok !== false),
  };
}

const k6Command = (url: string, script: string, phases: string, file: string) =>
  `k6 run --quiet --no-color -e BASE_URL=${url} -e PHASES=${phases} --summary-trend-stats "avg,med,p(95),p(99),max" --summary-export ${file} ${script}`;

function clientMounts(input: RunInput): Mount[] {
  const v = volumes(input.run);
  return [
    { volume: v.fixtures, at: "/fixtures", readOnly: true },
    { volume: v.src, at: "/src", readOnly: true },
  ];
}

async function k6(
  input: RunInput,
  item: PlanItem,
  facts: Facts,
  signal?: AbortSignal,
) {
  const problem = await stageReady(input, facts, ["head"], signal);
  if (problem)
    return { status: "error" as const, summary: problem, ms: 0, reports: [] };
  const target = facts.stage?.services.find(
    (s) => s.name === facts.stage?.target,
  );
  const url = `http://${hostOf(facts, "head")}:${target?.port}`;
  const e = await execCheck(
    input,
    item.id,
    `mkdir -p /out/${item.id}; ${k6Command(url, facts.k6Script ?? "", "smoke,load", `/out/${item.id}/summary.json`)} > /out/${item.id}/output.txt 2>&1; ${tailOf(item.id)}`,
    {
      mounts: clientMounts(input),
      network: { name: networks(input.run).stage },
      workdir: "/tmp",
      timeoutMs: 10 * 60_000,
      signal,
    },
  );
  const status = statusOf(item.id, e);
  if (status === "error" || status === "cancelled")
    return {
      status,
      summary: errorSummary(e),
      ms: e.ms,
      reports: e.copied.files,
    };
  const summary = JSON.parse(
    await readRun(input.run, `reports/${item.id}/summary.json`).catch(
      () => "{}",
    ),
  ) as K6Summary;
  const parts = ["smoke", "load"].map((p) => {
    const n = k6Numbers(summary, p);
    return `${p} p95 ${n.p95} ms p99 ${n.p99} ms errors ${(n.errors * 100).toFixed(1)}%${n.thresholdsOk ? "" : " (over limit)"}`;
  });
  return {
    status,
    summary: `${k6Numbers(summary).requests} requests. ${parts.join("; ")}`,
    ms: e.ms,
    reports: e.copied.files,
  };
}

async function perfCompare(
  input: RunInput,
  item: PlanItem,
  facts: Facts,
  signal?: AbortSignal,
) {
  const problem = await stageReady(input, facts, ["head", "base"], signal);
  if (problem)
    return { status: "error" as const, summary: problem, ms: 0, reports: [] };
  const target = facts.stage?.services.find(
    (s) => s.name === facts.stage?.target,
  );
  const run = (side: "head" | "base", round: number) =>
    k6Command(
      `http://${hostOf(facts, side)}:${target?.port}`,
      facts.k6Script ?? "",
      "load",
      `/out/${item.id}/${side}-${round}.json`,
    );
  // Alternating rounds, so a slow moment on the machine does not land on one side only.
  const script = `mkdir -p /out/${item.id}
for r in 1 2; do
  ${run("base", 1).replace("base-1", "base-$r")} >> /out/${item.id}/output.txt 2>&1
  ${run("head", 1).replace("head-1", "head-$r")} >> /out/${item.id}/output.txt 2>&1
done
exit 0`;
  const e = await execCheck(input, item.id, script, {
    mounts: clientMounts(input),
    network: { name: networks(input.run).stage },
    workdir: "/tmp",
    timeoutMs: 10 * 60_000,
    signal,
  });
  if (e.cancelled || e.timedOut || e.code !== 0)
    return {
      status: statusOf(item.id, e),
      summary: errorSummary(e),
      ms: e.ms,
      reports: e.copied.files,
    };
  const best = async (side: string) => {
    const rounds = await Promise.all(
      [1, 2].map(async (r) =>
        k6Numbers(
          JSON.parse(
            await readRun(
              input.run,
              `reports/${item.id}/${side}-${r}.json`,
            ).catch(() => "{}"),
          ) as K6Summary,
        ),
      ),
    );
    return {
      p95: Math.min(...rounds.map((x) => x.p95)),
      p99: Math.min(...rounds.map((x) => x.p99)),
      errors: Math.min(...rounds.map((x) => x.errors)),
    };
  };
  const base = await best("base");
  const head = await best("head");
  const slower = head.p95 > base.p95 * 1.25 + 10;
  const moreErrors = head.errors > base.errors + 0.005;
  const file = `reports/${item.id}/comparison.json`;
  await writeFile(
    path.join(runDir(input.run), file),
    JSON.stringify(
      {
        base,
        head,
        rule: "head p95 <= base p95 x 1.25 + 10 ms, error rate <= base + 0.5%",
      },
      null,
      2,
    ),
  );
  return {
    status: (slower || moreErrors ? "fail" : "pass") as CheckStatus,
    summary: `p95 ${head.p95} ms vs base ${base.p95} ms, p99 ${head.p99} vs ${base.p99} ms, errors ${(head.errors * 100).toFixed(1)}% vs ${(base.errors * 100).toFixed(1)}%${slower ? "; slower than allowed" : ""}${moreErrors ? "; more errors than allowed" : ""}`,
    ms: e.ms,
    reports: [...e.copied.files, file],
  };
}

async function toxiproxy(
  input: RunInput,
  item: PlanItem,
  facts: Facts,
  signal?: AbortSignal,
) {
  const problem = await stageReady(input, facts, ["head"], signal);
  if (problem)
    return { status: "error" as const, summary: problem, ms: 0, reports: [] };
  await ensureToxiproxy(input.run);
  const target = facts.stage?.services.find(
    (s) => s.name === facts.stage?.target,
  );
  const e = await execCheck(
    input,
    item.id,
    `mkdir -p /out/${item.id}; sleep 1; TOXI=http://toxi:8474 TARGET=${hostOf(facts, "head")}:${target?.port} HEALTH=${target?.health} OUT=/out/${item.id} node /opt/rox/chaos.mjs > /out/${item.id}/output.txt 2>&1; ${tailOf(item.id)}`,
    {
      mounts: [],
      network: { name: networks(input.run).stage },
      workdir: "/tmp",
      timeoutMs: 5 * 60_000,
      signal,
    },
  );
  const status = statusOf(item.id, e);
  if (status === "error" || status === "cancelled")
    return {
      status,
      summary: errorSummary(e),
      ms: e.ms,
      reports: e.copied.files,
    };
  const report = JSON.parse(
    await readRun(input.run, `reports/${item.id}/report.json`).catch(
      () => "{}",
    ),
  ) as {
    scenarios?: { name: string; pass: boolean; detail: string }[];
  };
  const scenarios = report.scenarios ?? [];
  const failed = scenarios.filter((s) => !s.pass);
  const note = facts.stage?.dependencies.length
    ? ""
    : ` Faults were put between clients and the app: ${facts.stage?.dependenciesNote ?? "the app has no outgoing service calls to disrupt."}`;
  return {
    status,
    summary: `${scenarios.length - failed.length} of ${scenarios.length} scenarios held${failed.length ? `; failed: ${failed.map((s) => `${s.name} (${s.detail})`).join("; ")}` : ""}.${note}`,
    ms: e.ms,
    reports: e.copied.files,
  };
}

async function schemathesis(
  input: RunInput,
  item: PlanItem,
  facts: Facts,
  signal?: AbortSignal,
) {
  const problem = await stageReady(input, facts, ["head"], signal);
  if (problem)
    return { status: "error" as const, summary: problem, ms: 0, reports: [] };
  // The same fuzzing on the code without the change, when it can run: only operations that fail
  // on head but not on base count. An app's own older API problems are not the change's fault
  // (the demo app has 6 to 7 of 11 operations with findings on main).
  const withBase =
    facts.stage !== null &&
    (await stageReady(input, facts, ["base"], signal)) === null;
  const target = facts.stage?.services.find(
    (s) => s.name === facts.stage?.target,
  );
  const fuzz = (side: "head" | "base", out: string) =>
    `schemathesis run ${facts.openapi} --url http://${hostOf(facts, side)}:${target?.port} --checks all --max-time 90 --request-timeout 10 --workers 2 --report junit --report-junit-path /out/${item.id}/${out}.xml > /out/${item.id}/${out}.txt 2>&1`;
  const e = await execCheck(
    input,
    item.id,
    withBase
      ? // Both at once; the exit code is head's.
        `mkdir -p /out/${item.id}; (${fuzz("base", "base")}) & ${fuzz("head", "junit")}; code=$?; wait; cp /out/${item.id}/junit.txt /out/${item.id}/output.txt; ${tailOf(item.id)}; exit $code`
      : `mkdir -p /out/${item.id}; ${fuzz("head", "junit")}; code=$?; cp /out/${item.id}/junit.txt /out/${item.id}/output.txt; ${tailOf(item.id)}; exit $code`,
    {
      mounts: clientMounts(input),
      network: { name: networks(input.run).stage },
      workdir: "/tmp",
      timeoutMs: 6 * 60_000,
      signal,
    },
  );
  const status = statusOf(item.id, e);
  if (status === "error" || status === "cancelled")
    return {
      status,
      summary: errorSummary(e),
      ms: e.ms,
      reports: e.copied.files,
    };
  const xml = e.copied.files.find((f) => f.endsWith("/junit.xml"));
  const headXml = xml ? await readRun(input.run, xml) : "";
  const c = xml ? junitCounts(headXml) : null;
  const baseFile = e.copied.files.find((f) => f.endsWith("/base.xml"));
  if (withBase && c && baseFile) {
    const before = new Set(failedCases(await readRun(input.run, baseFile)));
    const added = failedCases(headXml).filter((op) => !before.has(op));
    return {
      status: added.length ? ("fail" as const) : ("pass" as const),
      summary: added.length
        ? `${added.length} API operation(s) have problems the change added: ${added.join(", ").slice(0, 300)}`
        : `${c.tests} operations fuzzed; ${c.failed} with problems, all ${before.size ? "already on the code without the change" : "none"}`,
      ms: e.ms,
      reports: e.copied.files,
      counts: {
        operations: c.tests,
        failed: added.length,
        before: before.size,
      },
    };
  }
  const problems = [
    ...new Set(
      e.output
        .split("\n")
        .filter((l) =>
          /^\s*[-•]\s|Server error|Undocumented|not conform|accepted|rejected/i.test(
            l,
          ),
        )
        .map((l) => l.trim()),
    ),
  ].slice(0, 4);
  return {
    status,
    summary: c
      ? `${c.tests} operations fuzzed, ${c.failed} with problems${problems.length ? `: ${problems.join(" | ").slice(0, 300)}` : ""}`
      : firstLines(e.output) || "finished",
    ms: e.ms,
    reports: e.copied.files,
    ...(c ? { counts: { operations: c.tests, failed: c.failed } } : {}),
  };
}

/** Runs one check and returns its plain result. Never throws for a failing check. */
export async function runCheck(
  input: RunInput,
  item: PlanItem,
  facts: Facts,
  installed: Installed,
  prior: CheckResult[],
  signal?: AbortSignal,
): Promise<CheckResult> {
  const base = { id: item.id, title: item.title };
  if (!item.applies)
    return {
      ...base,
      status: "skipped",
      summary: item.why ?? "",
      ms: 0,
      reports: [],
    };
  if (item.on === "work" && !installed.head)
    return {
      ...base,
      status: "error",
      summary: "dependencies were not installed",
      ms: 0,
      reports: [],
    };
  if (["replay", "perf-compare"].includes(item.id) && !installed.base)
    return {
      ...base,
      status: "error",
      summary: "the base commit's dependencies were not installed",
      ms: 0,
      reports: [],
    };

  const special = {
    replay: () => replay(input, item, prior, signal),
    flaky: () => flaky(input, item, signal),
    mutation: () => mutation(input, item, facts, signal),
    k6: () => k6(input, item, facts, signal),
    "perf-compare": () => perfCompare(input, item, facts, signal),
    toxiproxy: () => toxiproxy(input, item, facts, signal),
    schemathesis: () => schemathesis(input, item, facts, signal),
  } as Partial<
    Record<CheckId, () => Promise<Omit<CheckResult, "id" | "title">>>
  >;
  const handler = special[item.id];
  if (handler) {
    const r = await handler();
    return { ...base, ...r, status: signal?.aborted ? "cancelled" : r.status };
  }

  const v = volumes(input.run);
  const e = await execCheck(
    input,
    item.id,
    staticScript(item.id, facts, input),
    {
      mounts:
        item.on === "work"
          ? [{ volume: v.work, at: "/work", readOnly: false }]
          : [{ volume: v.src, at: "/src", readOnly: true }],
      workdir: item.on === "work" ? "/work" : "/src",
      timeoutMs:
        item.id === "build" || item.id === "test" ? 15 * 60_000 : 10 * 60_000,
      env: { NODE_ENV: "test" },
      signal,
    },
  );
  const status = statusOf(item.id, e);
  if (status === "cancelled")
    return {
      ...base,
      status,
      summary: "stopped: the run was cancelled",
      ms: e.ms,
      reports: [],
    };
  const { summary, counts } =
    status === "error"
      ? { summary: errorSummary(e), counts: undefined }
      : await summarizeStatic(item.id, status, e.copied, e.output, input.run);
  return {
    ...base,
    status,
    summary: summary + refused(e.copied),
    ms: e.ms,
    reports: e.copied.files,
    ...(counts ? { counts } : {}),
  };
}

// --- dependencies

export type InstallResult = Installed & {
  ms: number;
  cancelled?: boolean;
  egress: { allowed: number; denied: number; deniedTargets: string[] };
};

/**
 * Installs dependencies for head (and the base commit, when there is one). The only step with a
 * network, and that network leads only to the egress proxy, which allows the npm registry and
 * nothing else. No secrets are passed in, and install scripts are off.
 */
export async function install(
  input: RunInput,
  facts: Facts,
  signal?: AbortSignal,
): Promise<InstallResult> {
  const started = Date.now();
  const none = { allowed: 0, denied: 0, deniedTargets: [] };
  if (facts.packageManager !== "npm")
    return {
      head: false,
      base: false,
      ms: 0,
      egress: none,
      summary: facts.packageManager
        ? `${facts.packageManager} is not supported in the lab yet (npm only)`
        : "no lockfile, so dependencies cannot be installed exactly",
    };
  const v = volumes(input.run);
  const net = networks(input.run).install;
  await createNetwork(net, input.run);
  const egress = await startEgress(input.run, net);
  const proxy = "http://egress:3128";
  const env = {
    NPM_CONFIG_CACHE: "/cache",
    npm_config_https_proxy: proxy,
    npm_config_proxy: proxy,
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
  };
  const ci = "npm ci --ignore-scripts --no-audit --no-fund --loglevel=error";
  // Stryker is no longer one of the checks, so it is not installed.
  const stryker = "";
  // The base copy is only needed to compare performance.
  const needBase =
    input.profile === "full" || touchesServer(facts.changed, facts.stage);
  const mounts = (target: Mount): Mount[] => [
    { volume: v.src, at: "/src", readOnly: true },
    target,
    { volume: v.npmCache, at: "/cache", readOnly: false },
  ];
  const head = await sandbox({
    name: `rox-${input.run}-install`,
    run: input.run,
    script: `cp -a /src/. /work/ && cd /work && ${ci}${stryker} && echo installed`,
    mounts: mounts({ volume: v.work, at: "/work", readOnly: false }),
    network: { name: net },
    workdir: "/work",
    timeoutMs: 15 * 60_000,
    env,
    signal,
  });
  const baseRun =
    needBase && input.base
      ? await sandbox({
          name: `rox-${input.run}-install-base`,
          run: input.run,
          script: `cp -a /src/. /base/ && cd /base && git -c advice.detachedHead=false checkout -q -f ${input.base} && ${ci} && echo installed`,
          mounts: mounts({ volume: v.base, at: "/base", readOnly: false }),
          network: { name: net },
          workdir: "/base",
          timeoutMs: 15 * 60_000,
          env,
          signal,
        })
      : null;

  const log = await serviceLogs(egress, 2000);
  await stopService(egress);
  const decisions = log
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l) as { verdict?: string; target?: string };
      } catch {
        return null;
      }
    })
    .filter((d) => d?.verdict);
  const denied = decisions.filter((d) => d?.verdict === "DENY");
  const why = (r: typeof head) =>
    r.timedOut
      ? "timed out"
      : r.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
  const headOk = head.code === 0;
  const baseOk = baseRun ? baseRun.code === 0 : false;
  return {
    head: headOk,
    base: baseOk,
    ms: Date.now() - started,
    cancelled: head.cancelled || Boolean(baseRun?.cancelled),
    egress: {
      allowed: decisions.length - denied.length,
      denied: denied.length,
      deniedTargets: [...new Set(denied.map((d) => d?.target ?? ""))].slice(
        0,
        10,
      ),
    },
    summary: [
      headOk ? "head installed" : `head install failed: ${why(head)}`,
      baseRun
        ? baseOk
          ? "base installed"
          : `base install failed: ${why(baseRun)}`
        : "base not needed",
      `registry calls through the proxy: ${decisions.length - denied.length} allowed, ${denied.length} denied`,
    ].join("; "),
  };
}

/** The reports folder of a run, listed (for the final summary). */
export async function listReports(run: string): Promise<string[]> {
  const dir = path.join(runDir(run), "reports");
  const out: string[] = [];
  for (const d of await readdir(dir).catch(() => []))
    for (const f of await readdir(path.join(dir, d)).catch(() => []))
      out.push(`${d}/${f}`);
  return out;
}

/** The names of the test cases that failed in a JUnit report (Schemathesis: one per operation). */
function failedCases(xml: string): string[] {
  const names: string[] = [];
  for (const m of xml.matchAll(
    /<testcase\b[^>]*\bname="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g,
  ))
    if (/<(failure|error)\b/.test(m[2] ?? "")) names.push(m[1] as string);
  return names;
}
