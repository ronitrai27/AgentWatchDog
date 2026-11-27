// U3: which checks run, decided by code from the stack (U1), the change profile (U1) and the reach
// (U2). Every check that does not run says why. When the analysis is missing (it crashed, or
// there is no base commit), the plan falls back to the safe side: every check that can apply runs.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Area, CheckId, PlanItem } from "../src/checks";
import { runDir } from "../src/env";
import type { Facts } from "../src/source";
import type { Analysis } from "./analyze";
import type { Kind } from "./profile";
import type { Stack } from "./stack";

/** Libraries that make outgoing network calls. */
const HTTP_CLIENTS = [
  "axios",
  "node-fetch",
  "undici",
  "got",
  "ky",
  "superagent",
  "needle",
  "request",
  "cross-fetch",
  "isomorphic-fetch",
  "ofetch",
  "stripe",
  "@stripe/stripe-js",
  "twilio",
  "@sendgrid/mail",
  "nodemailer",
  "@slack/web-api",
  "@octokit/rest",
  "graphql-request",
  "@apollo/client",
  "node:http",
  "node:https",
  "http",
  "https",
];
const HTTP_CLIENT_PREFIXES = ["@aws-sdk/", "@google-cloud/", "@azure/"];

export type Plan2Item = PlanItem & {
  /** How Agent_2 runs it: its own script, or the shared check. */
  runner: "agent2" | "shared";
  /** Package folders it runs in (lint, typecheck, tests). */
  packages?: string[];
  /** Changed files it is limited to (lint, Semgrep). */
  files?: string[];
};

export type PlanInputs = {
  facts: Facts;
  stack: Stack | null;
  analysis: Analysis | null;
  hasBase: boolean;
  /** True when a changed or reached file makes an outgoing call. */
  outgoing: boolean | null;
};

export async function loadAnalysis(
  run: string,
): Promise<{ stack: Stack | null; analysis: Analysis | null }> {
  const read = async <T>(f: string) =>
    JSON.parse(
      await readFile(path.join(runDir(run), "agent2", f), "utf8"),
    ) as T;
  const analysis = await read<Analysis>("analysis.json").catch(() => null);
  const stack =
    analysis?.stack ??
    (await read<{ stack: Stack }>("gate.json").catch(() => null))?.stack ??
    null;
  return { stack, analysis };
}

export function planChecks2(p: PlanInputs): Plan2Item[] {
  const { facts, stack, analysis } = p;
  const kinds = new Set<Kind>(analysis?.profile.kinds ?? []);
  const known = Boolean(analysis && p.hasBase);
  const unknownWhy = !p.hasBase
    ? "no base commit, so what changed is unknown: it runs to be safe"
    : "the change analysis is missing: it runs to be safe";
  const has = (...k: Kind[]) => k.some((x) => kinds.has(x));
  const changed =
    analysis?.profile.files
      .filter((f) => f.status !== "D")
      .map((f) => f.path) ?? [];
  const onlyDocsOrTests =
    known &&
    changed.length > 0 &&
    [...kinds].every((k) => ["docs", "tests", "other"].includes(k));
  const reach = analysis?.reach;
  const reachesRoutes =
    !known ||
    Boolean(
      reach && (reach.routes.length || reach.global || reach.routesUnknown),
    );
  const serverKinds = has(
    "server-logic",
    "route",
    "middleware",
    "data",
    "auth",
  );
  const app = facts.stage !== null;

  const pkgs = stack?.packages ?? [];
  const lintPkgs = pkgs.filter((x) => x.linters.length).map((x) => x.dir);
  const linters = [...new Set(pkgs.flatMap((x) => x.linters))];
  const tsPkgs = pkgs.filter((x) => x.typescript).map((x) => x.dir);
  const testPkgs = pkgs
    .filter((x) => x.testRunner === "vitest" || x.testRunner === "jest")
    .map((x) => x.dir);
  const otherRunners = [
    ...new Set(
      pkgs
        .map((x) => x.testRunner)
        .filter((r) => r && r !== "vitest" && r !== "jest"),
    ),
  ];

  const item = (
    id: CheckId,
    title: string,
    area: Area,
    on: PlanItem["on"],
    applies: boolean,
    why: string,
    extra: Partial<Plan2Item> = {},
  ): Plan2Item => ({
    id,
    title,
    area,
    on,
    applies,
    runner: "shared",
    ...(applies ? {} : { why }),
    ...extra,
  });

  const lintFiles = known
    ? changed.filter((f) => /\.([mc]?[jt]sx?|json|jsonc|css)$/.test(f))
    : [];
  const items: Plan2Item[] = [
    item(
      "lint",
      `Lint (${linters.join(" + ") || "none"}${known ? ", changed files" : ""})`,
      "quality",
      "work",
      lintPkgs.length > 0 && (!known || lintFiles.length > 0),
      !lintPkgs.length
        ? "no Biome, ESLint or Prettier in any package"
        : "no lintable file changed",
      {
        runner: "agent2",
        packages: lintPkgs,
        ...(known ? { files: lintFiles } : {}),
      },
    ),
    item(
      "typecheck",
      `TypeScript (${tsPkgs.length} package${tsPkgs.length === 1 ? "" : "s"})`,
      "quality",
      "work",
      tsPkgs.length > 0 && !onlyDocsOrTests
        ? true
        : tsPkgs.length > 0 && has("tests"),
      tsPkgs.length
        ? "only documentation changed"
        : "no tsconfig.json in any package",
      { runner: "agent2", packages: tsPkgs },
    ),
    item(
      "test",
      `Tests (${[...new Set(pkgs.filter((x) => testPkgs.includes(x.dir)).map((x) => x.testRunner))].join(", ") || "none"})`,
      "quality",
      "work",
      testPkgs.length > 0 && !(known && [...kinds].every((k) => k === "docs")),
      testPkgs.length
        ? "only documentation changed"
        : otherRunners.length
          ? `the test runner (${otherRunners.join(", ")}) is not supported yet; supported: Vitest, Jest`
          : "no Vitest or Jest in any package",
      { runner: "agent2", packages: testPkgs },
    ),
    item(
      "build",
      "Production build",
      "quality",
      "work",
      Boolean(facts.scripts.build) && !onlyDocsOrTests,
      facts.scripts.build
        ? "only documentation or tests changed"
        : "no build script in the root package.json",
    ),
    item("gitleaks", "Gitleaks (secrets)", "security", "source", true, ""),
    item(
      "semgrep",
      `Semgrep (SAST${known ? ", new findings only" : ""})`,
      "security",
      "source",
      !onlyDocsOrTests || !known,
      "only documentation or tests changed",
      { runner: "agent2", ...(known ? { files: changed } : {}) },
    ),
    item(
      "osv",
      "OSV-Scanner (dependencies)",
      "security",
      "source",
      facts.lockfiles.length > 0 && (!known || has("deps")),
      !facts.lockfiles.length
        ? "no lockfile"
        : "no dependency or lockfile changed",
    ),
    item(
      "trivy",
      "Trivy (filesystem and IaC)",
      "security",
      "source",
      !known || has("deps", "infra"),
      "no dependency, container, CI or infrastructure file changed",
    ),
    item(
      "k6",
      "k6 (smoke and load)",
      "performance",
      "work",
      app &&
        Boolean(facts.k6Script) &&
        (!known || (reachesRoutes && serverKinds)),
      !app
        ? "no way to run the app is known"
        : !facts.k6Script
          ? "no k6 script in the repository or the lab fixtures"
          : "the change reaches no route",
    ),
    item(
      "perf-compare",
      "Performance against the base",
      "reliability",
      "work",
      app &&
        Boolean(facts.k6Script) &&
        p.hasBase &&
        (!known || (reachesRoutes && serverKinds)),
      !p.hasBase
        ? "no base commit to compare with"
        : !app || !facts.k6Script
          ? "needs the app and a k6 script"
          : "the change reaches no route",
    ),
    item(
      "schemathesis",
      "Schemathesis (API fuzzing)",
      "security",
      "work",
      app &&
        Boolean(facts.openapi) &&
        (!known ||
          has("route", "middleware", "auth") ||
          changed.some((f) =>
            /(^|\/)(openapi|swagger)\.(ya?ml|json)$/i.test(f),
          )),
      !app
        ? "no way to run the app is known"
        : !facts.openapi
          ? "no OpenAPI spec in the repository or the lab fixtures"
          : "no route, middleware, auth code or API spec changed",
    ),
    item(
      "toxiproxy",
      "Toxiproxy (network faults)",
      "performance",
      "work",
      app && (!known || p.outgoing === null || (p.outgoing && serverKinds)),
      !app
        ? "no way to run the app is known"
        : "the change reaches no outgoing network call",
    ),
  ];
  // Tell why a check runs when the plan could not be narrowed.
  if (!known)
    for (const i of items)
      if (
        i.applies &&
        [
          "osv",
          "trivy",
          "k6",
          "perf-compare",
          "schemathesis",
          "toxiproxy",
        ].includes(i.id)
      )
        i.title += " (not narrowed)";
  return items.map((i) => (i.applies || i.why ? i : { ...i, why: unknownWhy }));
}

/** Does any changed or reached file make an outgoing call? From the index's imports and the code. */
export function outgoingCalls(
  analysis: Analysis,
  externals: Record<string, string[]>,
  fileText: (f: string) => string | null,
): boolean {
  const files = new Set<string>([
    ...analysis.profile.files.map((f) => f.path),
    ...analysis.reach.changedSymbols.map((s) => s.id.split("#")[0] ?? ""),
    ...analysis.reach.callers.map((c) => c.id.split("#")[0] ?? ""),
  ]);
  for (const f of files) {
    const ex = externals[f] ?? [];
    if (
      ex.some(
        (m) =>
          HTTP_CLIENTS.includes(m) ||
          HTTP_CLIENT_PREFIXES.some((x) => m.startsWith(x)),
      )
    )
      return true;
    const t = fileText(f);
    if (t && /\bfetch\s*\(|\bnew\s+WebSocket\s*\(|\.request\s*\(\s*\{/.test(t))
      return true;
  }
  return false;
}
