// Test doubles for tools: a context with a fake store, GitHub and Docker.
import type { DockerClient } from "../integrations/docker";
import type {
  CheckSummary,
  CommitSummary,
  DirEntry,
  GithubClient,
  PullSummary,
  RepoInfo,
} from "../integrations/github";
import type {
  RunEventRow,
  RunFilter,
  RunResult,
  RunRow,
  SetupRow,
  Store,
  UserRow,
} from "../store/sessions";
import type { ToolContext, ToolError } from "./types";

export const USER_ID = "00000000-0000-4000-8000-000000000001";

export const githubSetup: SetupRow = {
  repo: "acme/shop",
  installationId: 4242,
  orchestrator: "gpt-6-luna",
  subagent: "gemini-3.8-flash",
  sandbox: "docker",
  sandboxCheckedAt: new Date("2026-11-24T10:00:00Z"),
  triggers: ["github:pr_main", "sentry:new_issue"],
};

export const fakeRuns: RunRow[] = [
  {
    runId: "run-live",
    source: "github",
    trigger: "github:pr_main",
    invokedBy: "webhook",
    repo: "acme/shop",
    pr: 12,
    headSha: "sha12",
    title: "Add coupons",
    status: "running",
    outcome: null,
    prUrl: null,
    reason: null,
    startedAt: new Date(Date.now() - 60_000),
    finishedAt: null,
    durationMs: null,
    costUsd: 0.0123,
    modelCalls: 3,
    lastSeq: 4,
    prMergedAt: null,
  },
  {
    runId: "run-fixed",
    source: "sentry",
    trigger: "sentry:new_issue",
    invokedBy: "webhook",
    repo: "acme/shop",
    pr: null,
    headSha: null,
    title: "TypeError in cart total",
    status: "succeeded",
    outcome: "fixed",
    prUrl: "https://github.com/acme/shop/pull/14",
    reason: null,
    startedAt: new Date(Date.now() - 3_600_000),
    finishedAt: new Date(Date.now() - 3_000_000),
    durationMs: 600_000,
    costUsd: 0.2,
    modelCalls: 12,
    lastSeq: 30,
    prMergedAt: new Date(Date.now() - 2_000_000),
  },
  {
    // Status succeeded, but it gave up: counts as failed, like on the Runs page.
    runId: "run-gave-up",
    source: "sentry",
    trigger: "sentry:new_issue",
    invokedBy: "webhook",
    repo: "acme/shop",
    pr: null,
    headSha: null,
    title: "Cannot destructure perUsd",
    status: "succeeded",
    outcome: "gave_up",
    prUrl: null,
    reason: "No safe fix found",
    startedAt: new Date(Date.now() - 7_200_000),
    finishedAt: new Date(Date.now() - 6_800_000),
    durationMs: 400_000,
    costUsd: 0,
    modelCalls: 0,
    lastSeq: 47,
    prMergedAt: null,
  },
];

/** The store's RESULT_SQL rule, for the fake. */
function fakeResult(r: RunRow): RunResult {
  if (
    ["running", "paused", "failed", "cancelled", "aborted"].includes(r.status)
  )
    return r.status as RunResult;
  if (r.outcome === "fixed") return r.prUrl ? "pr_opened" : "fixed_no_pr";
  if (r.outcome === "gave_up") return "gave_up";
  if (r.outcome === "nothing_to_fix") return "nothing_to_fix";
  if (r.outcome === "infra") return "stopped_infra";
  return "finished";
}

const fakeEvents: RunEventRow[] = [1, 2, 3, 4].map((seq) => ({
  seq,
  at: new Date(Date.now() - (5 - seq) * 10_000),
  step: ["checkout", "install", "test", "fix"][seq - 1] as string,
  kind: "step",
  title: `Step ${seq}`,
  status: seq < 4 ? "ok" : "running",
  ms: seq < 4 ? 1000 : null,
  attempt: 1,
}));

export function fakeStore(
  options: {
    setup?: SetupRow | null;
    user?: Partial<UserRow>;
    keys?: string[];
    runs?: RunRow[];
  } = {},
): Store {
  const runs = options.runs ?? fakeRuns;
  const setup = options.setup === undefined ? githubSetup : options.setup;
  const user: UserRow = {
    id: USER_ID,
    login: "alice",
    name: "Alice",
    isDemo: false,
    ...options.user,
  };
  return {
    getSetup: async () => setup,
    getUser: async () => user,
    getReportConnections: async () => ({ connections: [], reportTo: null }),
    listKeyProviders: async () => options.keys ?? ["openai", "google"],
    listRuns: async (_userId: string, f: RunFilter) => {
      const inWindow = runs.filter(
        (r) =>
          (!f.source || r.source === f.source) &&
          (!f.trigger || r.trigger === f.trigger) &&
          (!f.repo || r.repo === f.repo) &&
          (f.pr === undefined || r.pr === f.pr) &&
          (!f.since || r.startedAt >= f.since),
      );
      const windowByResult: Partial<Record<RunResult, number>> = {};
      for (const r of inWindow)
        windowByResult[fakeResult(r)] =
          (windowByResult[fakeResult(r)] ?? 0) + 1;
      const match = inWindow.filter(
        (r) => !f.results || f.results.includes(fakeResult(r)),
      );
      return {
        windowTotal: inWindow.length,
        windowByResult,
        windowMerged: inWindow.filter((r) => r.prMergedAt).length,
        matching: match.length,
        runs: match.slice(0, f.limit),
      };
    },
    getRun: async (_userId: string, id: string) =>
      runs.find((r) => r.runId === id) ?? null,
    listRunEvents: async (
      _userId: string,
      _runId: string,
      afterSeq: number,
      limit: number,
    ) => fakeEvents.filter((e) => e.seq > afterSeq).slice(-limit),
  } as unknown as Store;
}

export type FakeGithubData = {
  repo?: Partial<RepoInfo>;
  languages?: Record<string, number>;
  commits?: CommitSummary[];
  pulls?: PullSummary[];
  checks?: Record<string, CheckSummary>;
  rootDir?: DirEntry[] | null;
  files?: Record<string, string>;
  dirs?: Record<string, DirEntry[]>;
  /** Make a method throw. */
  fail?: Partial<Record<keyof GithubClient, ToolError>>;
};

export function fakeGithub(
  data: FakeGithubData = {},
): GithubClient & { calls: string[] } {
  const calls: string[] = [];
  const maybeFail = (name: keyof GithubClient) => {
    calls.push(name);
    const error = data.fail?.[name];
    if (error) throw error;
  };
  return {
    calls,
    async getRepo() {
      maybeFail("getRepo");
      return {
        fullName: "acme/shop",
        private: true,
        defaultBranch: "main",
        description: "The shop",
        language: "TypeScript",
        pushedAt: "2026-11-23T09:00:00Z",
        htmlUrl: "https://github.com/acme/shop",
        archived: false,
        openIssuesAndPulls: 3,
        ...data.repo,
      };
    },
    async getLanguages() {
      maybeFail("getLanguages");
      return data.languages ?? { TypeScript: 8000, CSS: 1500, HTML: 500 };
    },
    async listCommits() {
      maybeFail("listCommits");
      return (
        data.commits ?? [
          {
            sha: "abc1234",
            message: "Fix cart total",
            author: "Bob",
            date: "2026-11-23T08:00:00Z",
          },
        ]
      );
    },
    async listPulls() {
      maybeFail("listPulls");
      return [
        {
          number: 14,
          title: "fix: guard empty cart total",
          author: "rox-watchdog[bot]",
          authorIsBot: true,
          state: "merged" as const,
          createdAt: "2026-11-22T10:00:00Z",
          mergedAt: "2026-11-22T12:00:00Z",
          closedAt: "2026-11-22T12:00:00Z",
          url: "https://github.com/acme/shop/pull/14",
        },
      ];
    },
    async countPulls() {
      return { total: 2, open: 2, merged: 0, closed: 0, capped: false };
    },
    async listOpenPulls() {
      maybeFail("listOpenPulls");
      return (
        data.pulls ?? [
          {
            number: 12,
            title: "Add coupons",
            author: "bob",
            branch: "coupons",
            draft: false,
            updatedAt: "2026-11-22T00:00:00Z",
            headSha: "sha12",
          },
          {
            number: 13,
            title: "WIP refactor",
            author: "cy",
            branch: "refactor",
            draft: true,
            updatedAt: "2026-11-21T00:00:00Z",
            headSha: "sha13",
          },
        ]
      );
    },
    async getChecks(_t, sha) {
      maybeFail("getChecks");
      return data.checks?.[sha] ?? { state: "passing", total: 3, failing: [] };
    },
    async listDir(_t, dirPath) {
      maybeFail("listDir");
      if (dirPath === "")
        return data.rootDir === undefined ? defaultRoot : data.rootDir;
      return data.dirs?.[dirPath] ?? null;
    },
    async getFile(_t, filePath) {
      maybeFail("getFile");
      return data.files?.[filePath] ?? null;
    },
  };
}

const defaultRoot: DirEntry[] = [
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "Dockerfile",
  ".github",
  "src",
  "README.md",
].map((name) => ({
  name,
  type: name === "src" || name === ".github" ? "dir" : "file",
  size: 100,
}));

export const defaultPackageJson = JSON.stringify({
  name: "shop",
  scripts: {
    build: "next build",
    test: "vitest run",
    lint: "biome check",
    dev: "next dev",
  },
  dependencies: { next: "16.0.0", react: "19.0.0" },
  devDependencies: { typescript: "5.9.0", vitest: "3.0.0" },
});

export function fakeDocker(result: "ok" | ToolError = "ok"): DockerClient {
  return {
    async status() {
      if (result !== "ok") throw result;
      return {
        serverVersion: "28.0.4",
        os: "Docker Desktop",
        cpus: 18,
        memoryBytes: 8 * 1024 ** 3,
      };
    },
  };
}

export function fakeContext(
  overrides: Partial<ToolContext> & {
    emitted?: { type: string; data: Record<string, unknown> }[];
  } = {},
): ToolContext {
  const emitted = overrides.emitted ?? [];
  return {
    userId: USER_ID,
    sessionId: "00000000-0000-4000-8000-0000000000aa",
    turnId: "00000000-0000-4000-8000-0000000000bb",
    signal: new AbortController().signal,
    store: fakeStore(),
    github: fakeGithub(),
    docker: fakeDocker(),
    emit: async (event) => {
      emitted.push(event);
    },
    ...overrides,
  };
}
