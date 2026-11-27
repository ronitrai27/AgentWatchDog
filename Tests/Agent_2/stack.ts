// U1 (part 1): stack detection. What each package of the repository is built with, read from its
// package.json files and config files at the head commit. Nothing is assumed about the layout:
// every package.json outside node_modules is a package.
import path from "node:path";
import { frameworkOfModule, UNMAPPED } from "./code-index/support.mts";
import { fileAt } from "./git";

export type PackageStack = {
  dir: string;
  name: string | null;
  frameworks: string[];
  /** Server frameworks without a route adapter (routes there count as unknown). */
  unmappedServer: string[];
  testRunner: "vitest" | "jest" | "mocha" | "ava" | "node:test" | null;
  ui: string[];
  typescript: boolean;
  linters: string[];
  scripts: string[];
  dependencies: string[];
};

export type Stack = {
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | null;
  lockfiles: string[];
  /** True for a repository with several packages (workspaces, pnpm-workspace.yaml, or more than one package.json). */
  monorepo: boolean;
  packages: PackageStack[];
  /** Everything detected, flattened, for the trace and the PR body. */
  summary: {
    frameworks: string[];
    unmappedServer: string[];
    testRunners: string[];
    linters: string[];
    ui: string[];
  };
};

const LOCKFILES: Record<string, Stack["packageManager"]> = {
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "bun.lockb": "bun",
  "bun.lock": "bun",
};
const UI_LIBS = [
  "react",
  "react-dom",
  "preact",
  "solid-js",
  "vue",
  "svelte",
  "@angular/core",
  "lit",
];
const skip = (f: string) =>
  f.split("/").some((s) => s === "node_modules" || s === ".git");

export async function detectStack(
  dir: string,
  head: string,
  files: string[],
): Promise<Stack> {
  const lockfiles = files.filter(
    (f) => LOCKFILES[path.posix.basename(f)] !== undefined && !skip(f),
  );
  const rootPkgText = await fileAt(dir, head, "package.json");
  const rootPkg = parse(rootPkgText);
  const pmField =
    typeof rootPkg.packageManager === "string"
      ? rootPkg.packageManager.split("@")[0]
      : null;
  const packageManager =
    (pmField && ["npm", "pnpm", "yarn", "bun"].includes(pmField)
      ? (pmField as Stack["packageManager"])
      : null) ??
    LOCKFILES[
      path.posix.basename(
        lockfiles.find((l) => !l.includes("/")) ?? lockfiles[0] ?? "",
      )
    ] ??
    null;

  const pkgFiles = files.filter(
    (f) => path.posix.basename(f) === "package.json" && !skip(f),
  );
  const packages: PackageStack[] = [];
  for (const pf of pkgFiles) {
    const pkg = parse(await fileAt(dir, head, pf));
    const pdir = path.posix.dirname(pf);
    const deps = Object.keys({
      ...(pkg.dependencies as object),
      ...(pkg.devDependencies as object),
      ...(pkg.peerDependencies as object),
      ...(pkg.optionalDependencies as object),
    });
    const scripts = (pkg.scripts as Record<string, string>) ?? {};
    const inPkg = (re: RegExp) =>
      files.some((f) => {
        const r =
          pdir === "."
            ? f
            : f.startsWith(`${pdir}/`)
              ? f.slice(pdir.length + 1)
              : null;
        return r !== null && !r.includes("/") && re.test(r);
      });
    const allScripts = Object.values(scripts).join(" ");
    const testRunner: PackageStack["testRunner"] =
      deps.includes("vitest") ||
      inPkg(/^vitest\.(config|workspace)\./) ||
      /\bvitest\b/.test(allScripts)
        ? "vitest"
        : deps.includes("jest") ||
            inPkg(/^jest\.config\./) ||
            /\bjest\b/.test(allScripts) ||
            pkg.jest
          ? "jest"
          : deps.includes("mocha") || /\bmocha\b/.test(allScripts)
            ? "mocha"
            : deps.includes("ava")
              ? "ava"
              : /node (--test|--experimental-test)/.test(allScripts)
                ? "node:test"
                : null;
    const linters = [
      (deps.includes("@biomejs/biome") || inPkg(/^biome\.jsonc?$/)) && "biome",
      (deps.includes("eslint") ||
        inPkg(/^(\.eslintrc(\.\w+)?|eslint\.config\.\w+)$/)) &&
        "eslint",
      (deps.includes("prettier") ||
        inPkg(/^(\.prettierrc(\.\w+)?|prettier\.config\.\w+)$/)) &&
        "prettier",
      (deps.includes("oxlint") || inPkg(/^\.?oxlintrc\.json$/)) && "oxlint",
    ].filter((x): x is string => Boolean(x));
    packages.push({
      dir: pdir,
      name: typeof pkg.name === "string" ? pkg.name : null,
      frameworks: [
        ...new Set(
          deps.map(frameworkOfModule).filter((x): x is string => Boolean(x)),
        ),
      ].sort(),
      unmappedServer: deps.filter((d) => UNMAPPED.includes(d)).sort(),
      testRunner,
      ui: UI_LIBS.filter((u) => deps.includes(u)),
      typescript:
        deps.includes("typescript") || inPkg(/^tsconfig(\.[\w-]+)?\.json$/),
      linters,
      scripts: Object.keys(scripts).sort(),
      dependencies: deps.sort(),
    });
  }
  const flat = (k: "frameworks" | "unmappedServer" | "linters" | "ui") =>
    [...new Set(packages.flatMap((p) => p[k]))].sort();
  return {
    packageManager,
    lockfiles,
    monorepo:
      Boolean(rootPkg.workspaces) ||
      files.includes("pnpm-workspace.yaml") ||
      pkgFiles.length > 1,
    packages,
    summary: {
      frameworks: flat("frameworks"),
      unmappedServer: flat("unmappedServer"),
      testRunners: [
        ...new Set(
          packages
            .map((p) => p.testRunner)
            .filter((x): x is NonNullable<typeof x> => Boolean(x)),
        ),
      ].sort(),
      linters: flat("linters"),
      ui: flat("ui"),
    },
  };
}

/** The package a file belongs to: the deepest package folder that contains it. */
export function packageOfFile(stack: Stack, file: string): PackageStack | null {
  return (
    stack.packages
      .filter((p) => p.dir === "." || file.startsWith(`${p.dir}/`))
      .sort((a, b) => b.dir.length - a.dir.length)[0] ?? null
  );
}

function parse(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}
