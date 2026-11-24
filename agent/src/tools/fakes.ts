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
import type { SetupRow, Store, UserRow } from "../store/sessions";
import type { ToolContext, ToolError } from "./types";

export const USER_ID = "00000000-0000-4000-8000-000000000001";

export const githubSetup: SetupRow = {
  repo: "acme/shop",
  installationId: 4242,
  orchestrator: "gpt-6-luna",
  subagent: "gemini-3.8-flash",
  sandbox: "docker",
  sandboxCheckedAt: new Date("2026-11-24T10:00:00Z"),
};

export function fakeStore(
  options: {
    setup?: SetupRow | null;
    user?: Partial<UserRow>;
    keys?: string[];
  } = {},
): Store {
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
    listKeyProviders: async () => options.keys ?? ["openai", "google"],
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
