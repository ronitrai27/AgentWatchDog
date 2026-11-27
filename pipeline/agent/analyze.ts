// Agent_2's first steps on a run: U0 language gate → U1 stack → U2 code index → reach → U1 change
// profile. Code only, no model. Everything is written to the run's trace and to
// Tests/runs/<run>/agent2/ (analysis.json, index-head.json, index-base.json).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runDir } from "../src/env";
import { emit } from "../src/events";
import type { Index } from "./code-index/indexer.mts";
import { indexInSandbox } from "./code-index/run";
import { type FileChange, type GateResult, languageGate } from "./gate";
import {
  changedLines,
  changesBetween,
  fileAt,
  filesAt,
  type Hunks,
} from "./git";
import { type ChangeProfile, profileChange } from "./profile";
import { computeReach, type Reach } from "./reach";
import { detectStack, type Stack } from "./stack";

export type GateStep = {
  gate: GateResult;
  changes: FileChange[];
  files: string[];
  stack: Stack;
};

export type Analysis = GateStep & {
  index: { head: Index["stats"]; base: Index["stats"] | null; ms: number };
  routes: { head: number; base: number | null };
  reach: Reach;
  profile: ChangeProfile;
};

/** U0 + U1 stack: file names and package.json files only. Cheap; runs before the install. */
export async function gateStep(o: {
  run: string;
  dir: string;
  base: string | null;
  head: string;
}): Promise<GateStep> {
  const t0 = Date.now();
  const [files, changes] = await Promise.all([
    filesAt(o.dir, o.head),
    o.base ? changesBetween(o.dir, o.base, o.head) : Promise.resolve([]),
  ]);
  const gate = languageGate(changes, files);
  await emit(o.run, {
    step: "agent2",
    kind: "agent2.gate",
    title: gate.ok
      ? `Language gate: ${gate.sourceFiles} JavaScript/TypeScript files changed${o.base ? "" : " (no base commit, so the change is unknown)"}${gate.untouchedOtherLanguages.length ? `; the repository also has ${gate.untouchedOtherLanguages.join(", ")} files the change does not touch` : ""}`
      : `Stopped: ${gate.blocked.length ? `the change includes ${[...new Set(gate.blocked.map((b) => b.language))].join(", ")} files` : "no JavaScript or TypeScript to check"}`,
    status: gate.ok ? "pass" : "fail",
    ms: Date.now() - t0,
    data: { ...gate, changes: changes.length },
  });
  const stack = await detectStack(o.dir, o.head, files);
  await emit(o.run, {
    step: "agent2",
    kind: "agent2.stack",
    title: `Stack: ${[
      stack.summary.frameworks.length
        ? stack.summary.frameworks.join(", ")
        : "no mapped framework",
      stack.summary.unmappedServer.length
        ? `unmapped: ${stack.summary.unmappedServer.join(", ")}`
        : "",
      stack.summary.testRunners.join(", ") || "no test runner",
      stack.packageManager ?? "no package manager",
      stack.monorepo ? `${stack.packages.length} packages` : "",
    ]
      .filter(Boolean)
      .join(" · ")}`,
    status: "pass",
    data: stack as unknown as Record<string, unknown>,
  });
  return { gate, changes, files, stack };
}

/** U2 index + reach + U1 profile. Needs the installed copy (types come from node_modules). */
export async function analyzeStep(o: {
  run: string;
  dir: string;
  base: string | null;
  head: string;
  gate: GateStep;
  volume: string;
  baseVolume?: string | null;
  signal?: AbortSignal;
}): Promise<Analysis> {
  const indexes = await indexInSandbox({
    run: o.run,
    volume: o.volume,
    baseRef: o.base,
    baseVolume: o.baseVolume,
    signal: o.signal,
  });
  const { head, base } = indexes;
  await emit(o.run, {
    step: "agent2",
    kind: "agent2.index",
    title: `Code index: ${head.stats.files} files, ${head.stats.symbols} symbols, ${head.routes.length} routes${base ? ` (base: ${base.routes.length} routes)` : ""}, ${head.unresolved.length} places not followed`,
    status: "pass",
    ms: indexes.ms,
    data: {
      head: head.stats,
      base: base?.stats ?? null,
      packages: head.packages,
      routes: head.routes.map((r) => `${r.method} ${r.path}`),
    },
  });
  const hunks: Hunks = o.base
    ? await changedLines(o.dir, o.base, o.head)
    : new Map();
  const reach = computeReach(head, base, o.gate.changes, hunks);
  await emit(o.run, {
    step: "agent2",
    kind: "agent2.reach",
    title: `Reach: ${reach.changedSymbols.length} changed symbols, ${reach.callers.length} callers, ${reach.global ? "every route" : `${reach.routes.length} routes`}${reach.routesUnknown ? ", routes not fully known" : ""}`,
    status: "pass",
    data: reach as unknown as Record<string, unknown>,
  });
  const profile = await profileChange({
    changes: o.gate.changes,
    stack: o.gate.stack,
    head,
    base,
    reach,
    read: (f) => fileAt(o.dir, o.head, f),
    readBase: (f) =>
      o.base ? fileAt(o.dir, o.base, f) : Promise.resolve(null),
  });
  await emit(o.run, {
    step: "agent2",
    kind: "agent2.profile",
    title: `Change profile: ${profile.kinds.join(", ") || "nothing changed"}`,
    status: "pass",
    data: profile as unknown as Record<string, unknown>,
  });
  const analysis: Analysis = {
    ...o.gate,
    index: { head: head.stats, base: base?.stats ?? null, ms: indexes.ms },
    routes: {
      head: head.routes.length,
      base: base ? base.routes.length : null,
    },
    reach,
    profile,
  };
  const out = path.join(runDir(o.run), "agent2");
  await mkdir(out, { recursive: true });
  await writeFile(
    path.join(out, "analysis.json"),
    JSON.stringify(analysis, null, 2),
  );
  await writeFile(path.join(out, "index-head.json"), JSON.stringify(head));
  if (base)
    await writeFile(path.join(out, "index-base.json"), JSON.stringify(base));
  return analysis;
}
