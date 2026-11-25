// Gets the exact commits to check and loads them into the run's volumes. Git runs on the host,
// with the read-only token; the sandbox never sees a token.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { docker, ensureVolume, IMAGE } from "./docker";
import { cacheDir, labDir } from "./env";
import { gitAuthHeader, readToken } from "./github";

function git(
  args: string[],
  cwd?: string,
  timeoutMs = 180_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.autocrlf=false", "-c", "advice.detachedHead=false", ...args],
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        error
          ? reject(
              new Error(`git ${args[0]}: ${stderr.trim() || error.message}`),
            )
          : resolve(stdout),
    );
  });
}

export const volumes = (run: string) => ({
  /** The head commit, with history. Read-only for every check. */
  src: `rox-src-${run}`,
  /** A copy of head with dependencies installed. Checks that build or test write here. */
  work: `rox-work-${run}`,
  /** A copy of the base commit with dependencies, for replay and the performance comparison. */
  base: `rox-base-${run}`,
  /** Fixtures for this repository (how to run it, an OpenAPI spec, k6 scripts). Read-only. */
  fixtures: `rox-fix-${run}`,
  out: `rox-out-${run}`,
  npmCache: "rox-npm-cache",
});

export const networks = (run: string) => ({
  /** The dependency install and the egress proxy. */
  install: `rox-inst-${run}`,
  /** The app under test and the clients that test it. No route out. */
  stage: `rox-net-${run}`,
});

/**
 * Fetches the commits into a cache on the host, then makes a clean copy of `head` (with history,
 * so secrets can be searched commit by commit, and the base can be checked out). Returns the folder.
 */
export async function checkout(
  repo: string,
  head: string,
  base: string | null,
  run: string,
) {
  const token = await readToken(repo);
  const header = ["-c", `http.extraHeader=${gitAuthHeader(token)}`];
  const cache = path.join(cacheDir, "repos", `${repo.replace("/", "__")}.git`);
  if (!existsSync(cache)) {
    await mkdir(path.dirname(cache), { recursive: true });
    await git(["init", "--bare", cache]);
  }
  const url = `https://github.com/${repo}.git`;
  await git(
    [...header, "fetch", "--force", url, head, ...(base ? [base] : [])],
    cache,
    300_000,
  );
  // Named refs, so a clone of the cache is sure to carry both commits.
  await git(["update-ref", `refs/rox/${run}/head`, head], cache);
  if (base) await git(["update-ref", `refs/rox/${run}/base`, base], cache);

  const dir = path.join(cacheDir, "checkouts", run);
  await rm(dir, { recursive: true, force: true });
  await git(["clone", "--quiet", "--no-checkout", cache, dir]);
  await git(
    ["fetch", "--quiet", "origin", `refs/rox/${run}/*:refs/rox/*`],
    dir,
  );
  await git(["checkout", "--quiet", "--detach", head], dir);
  await git(
    ["for-each-ref", "--format=delete %(refname)", `refs/rox/${run}`],
    cache,
  )
    .then((lines) =>
      lines.trim()
        ? Promise.all(
            lines
              .trim()
              .split("\n")
              .map((l) =>
                git(["update-ref", "-d", l.replace("delete ", "")], cache),
              ),
          )
        : [],
    )
    .catch(() => {});
  return dir;
}

/** The files the change touched, from the base to the head. */
export async function changedFiles(
  dir: string,
  base: string | null,
  head: string,
): Promise<string[]> {
  if (!base) return [];
  const out = await git(
    ["diff", "--name-only", "--diff-filter=AMR", base, head],
    dir,
  );
  return out
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
}

/**
 * Copies a folder into a new volume. The volume is attached to a container that is created but
 * never started, and `docker cp` writes into it, so no code runs while the files are copied.
 */
export async function loadVolume(dir: string, volume: string, run: string) {
  await ensureVolume(volume, run);
  const name = `rox-load-${run}`;
  await docker(["rm", "-f", name]).catch(() => {});
  await docker([
    "create",
    "--name",
    name,
    "--label",
    "rox.lab=1",
    "--label",
    `rox.run=${run}`,
    "--network",
    "none",
    "-v",
    `${volume}:/src`,
    IMAGE,
    "true",
  ]);
  try {
    await docker(["cp", `${dir}${path.sep}.`, `${name}:/src`], 300_000);
  } catch (error) {
    throw new Error(
      `could not load ${path.basename(dir)} into the sandbox: ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    await docker(["rm", "-f", name]).catch(() => {});
  }
}

/** How to run the app under test, from the repo's own `.rox/stage.json` or the lab fixtures. */
export type Stage = {
  target: string;
  services: {
    name: string;
    dir: string;
    command: string;
    port: number;
    health: string;
    env: Record<string, string>;
  }[];
  dependencies: { name: string; upstream: string }[];
  dependenciesNote?: string;
};

export type Facts = {
  packageManager: "npm" | "pnpm" | "yarn" | null;
  lockfiles: string[];
  scripts: Record<string, string>;
  workspaces: string[];
  biome: boolean;
  eslint: boolean;
  prettier: boolean;
  typescript: boolean;
  vitest: boolean;
  dockerfiles: string[];
  nodeEngine: string | null;
  /** Files the change touched (empty without a base). */
  changed: string[];
  /** Paths as the sandbox sees them: /src/... from the repo, /fixtures/... from the lab. */
  openapi: string | null;
  k6Script: string | null;
  stage: Stage | null;
  /** Which of the above came from the lab's fixtures instead of the repository. */
  fromFixtures: string[];
};

const exists = (dir: string, ...names: string[]) =>
  names.some((n) => existsSync(path.join(dir, n)));

async function walk(dir: string, depth: number, base = dir): Promise<string[]> {
  if (depth < 0) return [];
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(
    () => [],
  )) {
    if (
      [".git", "node_modules", ".next", "dist", "build", "coverage"].includes(
        entry.name,
      )
    )
      continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, depth - 1, base)));
    else out.push(path.relative(base, full).replaceAll("\\", "/"));
  }
  return out;
}

/** The lab's fixtures for a repository, if there are any. */
export const fixturesDir = (repo: string) =>
  path.join(labDir, "fixtures", repo.replace("/", "__"));

/** What the repository contains, so each check knows whether it applies. Read on the host. */
export async function readFacts(
  dir: string,
  repo: string,
  changed: string[],
): Promise<Facts> {
  const files = await walk(dir, 4);
  const pkg = JSON.parse(
    await readFile(path.join(dir, "package.json"), "utf8").catch(() => "{}"),
  ) as {
    scripts?: Record<string, string>;
    workspaces?: string[];
    engines?: { node?: string };
  };
  const lockfiles = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"].filter(
    (f) => exists(dir, f),
  );
  const has = (re: RegExp) => files.some((f) => re.test(f));

  const fixtures = fixturesDir(repo);
  const fromFixtures: string[] = [];
  const repoOpenapi = files.find((f) =>
    /(^|\/)(openapi|swagger)\.(ya?ml|json)$/i.test(f),
  );
  const repoK6 = files.find((f) => /^perf\/k6\/.+\.(js|ts)$/.test(f));
  const repoStage = exists(dir, ".rox/stage.json") ? ".rox/stage.json" : null;
  const pick = (
    own: string | undefined | null,
    fixture: string,
    label: string,
  ) => {
    if (own) return `/src/${own}`;
    if (existsSync(path.join(fixtures, fixture))) {
      fromFixtures.push(label);
      return `/fixtures/${fixture}`;
    }
    return null;
  };
  const stagePath = repoStage
    ? path.join(dir, repoStage)
    : existsSync(path.join(fixtures, "stage.json"))
      ? path.join(fixtures, "stage.json")
      : null;
  if (!repoStage && stagePath) fromFixtures.push("how to run the app");

  return {
    packageManager: lockfiles.includes("package-lock.json")
      ? "npm"
      : lockfiles.includes("pnpm-lock.yaml")
        ? "pnpm"
        : lockfiles.includes("yarn.lock")
          ? "yarn"
          : null,
    lockfiles,
    scripts: pkg.scripts ?? {},
    workspaces: pkg.workspaces ?? [],
    biome: exists(dir, "biome.json", "biome.jsonc"),
    eslint: has(/(^|\/)(\.eslintrc(\.\w+)?|eslint\.config\.\w+)$/),
    prettier: has(/(^|\/)(\.prettierrc(\.\w+)?|prettier\.config\.\w+)$/),
    typescript: has(/(^|\/)tsconfig(\.\w+)?\.json$/),
    vitest: JSON.stringify(pkg).includes("vitest") || has(/vitest\.config\./),
    dockerfiles: files.filter((f) => /(^|\/)Dockerfile(\.\w+)?$/.test(f)),
    nodeEngine: pkg.engines?.node ?? null,
    changed,
    openapi: pick(repoOpenapi, "openapi.yaml", "OpenAPI spec"),
    k6Script: pick(repoK6, "k6/load.js", "k6 script"),
    stage: stagePath
      ? (JSON.parse(await readFile(stagePath, "utf8")) as Stage)
      : null,
    fromFixtures,
  };
}
