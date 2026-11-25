// The only way files leave a sandbox. Each check writes to /out/<check>. A small sandbox lists
// those files, and each one is copied only if its name is plain, it is not a link, it is small
// enough, and it parses as the format its name claims.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sandbox } from "./docker";
import { runDir } from "./env";
import { volumes } from "./source";

const MAX_FILE = 10 * 1024 * 1024;
const MAX_FILES = 40;
const NAME = /^[\w.-]{1,80}\.(sarif|json|xml|txt|log)$/;

function validate(name: string, text: string): string | null {
  const ext = name.split(".").pop();
  if (ext === "sarif" || ext === "json") {
    try {
      const json = JSON.parse(text) as { runs?: unknown };
      if (ext === "sarif" && !Array.isArray(json.runs))
        return "not SARIF: no runs";
    } catch {
      return "not valid JSON";
    }
  }
  if (ext === "xml" && !/<testsuites?[\s>]/.test(text))
    return "not a JUnit report";
  return null;
}

export type Copied = {
  files: string[];
  rejected: { name: string; why: string }[];
};

export async function copyReports(
  run: string,
  check: string,
  signal?: AbortSignal,
): Promise<Copied> {
  const out = volumes(run).out;
  const mount = [{ volume: out, at: "/out", readOnly: true }];
  const listing = await sandbox({
    name: `rox-list-${run}-${check}`,
    run,
    script: `cd /out/${check} 2>/dev/null || exit 0; for f in * .*; do [ -f "$f" ] && [ ! -L "$f" ] && printf '%s\\t%s\\n' "$f" "$(stat -c %s "$f")"; done; exit 0`,
    mounts: mount,
    network: "none",
    workdir: "/out",
    timeoutMs: 30_000,
    signal,
  });
  const dest = path.join(runDir(run), "reports", check);
  await mkdir(dest, { recursive: true });
  const copied: Copied = { files: [], rejected: [] };
  const entries = listing.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .slice(0, MAX_FILES);
  for (const [name = "", size = "0"] of entries) {
    if (!NAME.test(name)) {
      copied.rejected.push({ name, why: "file name or type not allowed" });
      continue;
    }
    if (Number(size) > MAX_FILE) {
      copied.rejected.push({
        name,
        why: `larger than ${MAX_FILE / 1024 / 1024} MB`,
      });
      continue;
    }
    const file = await sandbox({
      name: `rox-copy-${run}-${check}`,
      run,
      script: `cat "/out/${check}/${name}"`,
      mounts: mount,
      network: "none",
      workdir: "/out",
      timeoutMs: 60_000,
      stdoutLimit: MAX_FILE,
      signal,
    });
    const why =
      file.code === 0 ? validate(name, file.stdout) : "could not be read";
    if (why) {
      copied.rejected.push({ name, why });
      continue;
    }
    await writeFile(path.join(dest, name), file.stdout);
    copied.files.push(`reports/${check}/${name}`);
  }
  return copied;
}

/** Counts in a JUnit report: tests, failures, and the names of the first failing tests. */
export function junitCounts(xml: string) {
  let tests = 0;
  let failed = 0;
  for (const m of xml.matchAll(/<testsuite\b[^>]*>/g)) {
    tests += Number(/\btests="(\d+)"/.exec(m[0])?.[1] ?? 0);
    failed +=
      Number(/\bfailures="(\d+)"/.exec(m[0])?.[1] ?? 0) +
      Number(/\berrors="(\d+)"/.exec(m[0])?.[1] ?? 0);
  }
  const names = [
    ...xml.matchAll(
      /<testcase\b[^>]*\bname="([^"]*)"[^>]*>(?:(?!<\/testcase>)[\s\S])*?<(failure|error)\b/g,
    ),
  ]
    .map((m) => m[1] ?? "")
    .slice(0, 5);
  return { tests, failed, names };
}

/** Findings in a SARIF report, and the rules that found the most. */
export function sarifCounts(text: string) {
  const sarif = JSON.parse(text) as {
    runs?: { results?: { ruleId?: string }[] }[];
  };
  const results = (sarif.runs ?? []).flatMap((r) => r.results ?? []);
  const byRule = new Map<string, number>();
  for (const r of results)
    byRule.set(r.ruleId ?? "?", (byRule.get(r.ruleId ?? "?") ?? 0) + 1);
  return {
    findings: results.length,
    top: [...byRule.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
  };
}

export type JunitCase = { file: string; name: string; failed: boolean };

/** Every test case in a JUnit report: its file, its name, and whether it failed. */
export function junitCases(xml: string): JunitCase[] {
  const decodeXml = (s: string) =>
    s
      .replaceAll("&gt;", ">")
      .replaceAll("&lt;", "<")
      .replaceAll("&quot;", '"')
      .replaceAll("&amp;", "&");
  const cases: JunitCase[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of xml.matchAll(re)) {
    const attrs = m[1] ?? "";
    const body = m[3] ?? "";
    cases.push({
      file: decodeXml(/\bclassname="([^"]*)"/.exec(attrs)?.[1] ?? ""),
      name: decodeXml(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? ""),
      failed: /<(failure|error)\b/.test(body),
    });
  }
  return cases;
}
