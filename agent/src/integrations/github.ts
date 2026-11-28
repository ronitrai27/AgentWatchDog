// Read-only GitHub access for the agent, through the Rox GitHub App. A short-lived token is
// minted per installation with read permissions only, and cached until shortly before it expires.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { rootDir } from "../config";
import { ToolError } from "../tools/types";

export type Target = {
  installationId: number;
  repo: string;
  signal?: AbortSignal;
};

export type RepoInfo = {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  language: string | null;
  pushedAt: string | null;
  htmlUrl: string;
  archived: boolean;
  /** GitHub counts issues and pull requests together here. */
  openIssuesAndPulls: number;
};
export type CommitSummary = {
  sha: string;
  message: string;
  author: string;
  date: string;
};
export type PullSummary = {
  number: number;
  title: string;
  author: string;
  branch: string;
  draft: boolean;
  updatedAt: string;
  headSha: string;
};
export type PullCounts = {
  total: number;
  open: number;
  merged: number;
  /** Closed without merging. */
  closed: number;
  capped: boolean;
};
/** One pull request of any state, for counting who opened what and what got merged. */
export type PullDetail = {
  number: number;
  title: string;
  author: string;
  /** True for GitHub Apps and other bot accounts ("name[bot]"). */
  authorIsBot: boolean;
  state: "open" | "merged" | "closed";
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  url: string;
};
export type CheckSummary = {
  state: "passing" | "failing" | "pending" | "none";
  total: number;
  failing: string[];
};
export type DirEntry = { name: string; type: "file" | "dir"; size: number };

export interface GithubClient {
  getRepo(target: Target): Promise<RepoInfo>;
  getLanguages(target: Target): Promise<Record<string, number>>;
  listCommits(
    target: Target,
    limit: number,
    since?: Date,
  ): Promise<CommitSummary[]>;
  listOpenPulls(target: Target, limit: number): Promise<PullSummary[]>;
  /** The newest 100 pull requests by state. */
  countPulls(target: Target): Promise<PullCounts>;
  /** The newest pull requests of every state, newest first (at most 100). */
  listPulls(target: Target, limit: number): Promise<PullDetail[]>;
  getChecks(target: Target, sha: string): Promise<CheckSummary>;
  /** Null when the folder does not exist. */
  listDir(
    target: Target,
    dirPath: string,
    ref?: string,
  ): Promise<DirEntry[] | null>;
  /** Null when the file does not exist. Text only, cut at maxBytes. */
  getFile(
    target: Target,
    filePath: string,
    maxBytes: number,
    ref?: string,
  ): Promise<string | null>;
}

type Options = {
  appId: string;
  privateKeyPem: string;
  fetch?: typeof fetch;
  apiBase?: string;
  now?: () => number;
};

const READ_PERMISSIONS = {
  metadata: "read",
  contents: "read",
  pull_requests: "read",
  checks: "read",
};

export function githubFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GithubClient | null {
  const appId = env.GITHUB_APP_ID;
  const keyPath = env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (!appId || !keyPath) return null;
  try {
    const pem = readFileSync(
      path.resolve(/*turbopackIgnore: true*/ rootDir, keyPath),
      "utf8",
    );
    return createGithubClient({ appId, privateKeyPem: pem });
  } catch {
    return null;
  }
}

export function createGithubClient(options: Options): GithubClient {
  const fetchImpl = options.fetch ?? fetch;
  const base = options.apiBase ?? "https://api.github.com";
  const now = options.now ?? Date.now;
  const tokens = new Map<number, { token: string; expiresAt: number }>();
  const inflightTokens = new Map<number, Promise<string>>();

  const b64 = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  function appJwt(): string {
    const iat = Math.floor(now() / 1000);
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: iat - 30, exp: iat + 540, iss: options.appId })}`;
    const signature = createSign("RSA-SHA256")
      .update(unsigned)
      .sign(options.privateKeyPem)
      .toString("base64url");
    return `${unsigned}.${signature}`;
  }

  async function request(
    route: string,
    init: {
      token: string;
      method?: string;
      body?: unknown;
      signal?: AbortSignal;
    },
  ): Promise<Response> {
    const method = init.method ?? "GET";
    const canRetry = method === "GET";
    const maxAttempts = canRetry ? 2 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetchImpl(`${base}${route}`, {
          method,
          headers: {
            authorization: `Bearer ${init.token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "rox-agent",
            ...(init.body ? { "content-type": "application/json" } : {}),
          },
          body: init.body ? JSON.stringify(init.body) : undefined,
          signal: init.signal,
        });
        if (
          canRetry &&
          attempt < maxAttempts &&
          (res.status === 502 || res.status === 503 || res.status === 504)
        ) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        return res;
      } catch (error) {
        if ((error as Error).name === "AbortError")
          throw new ToolError("aborted", "Stopped while talking to GitHub");
        if (canRetry && attempt < maxAttempts && !init.signal?.aborted) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        throw new ToolError("upstream", "Could not reach GitHub", {
          cause: error,
          hint: "Check the internet connection.",
        });
      }
    }
    throw new ToolError("upstream", "Could not reach GitHub");
  }

  function fail(response: Response, what: string, body: string): never {
    let detail = "";
    try {
      detail = String(
        (JSON.parse(body) as { message?: unknown }).message ?? "",
      );
    } catch {
      detail = body.slice(0, 160);
    }
    if (response.status === 401) {
      throw new ToolError(
        "unavailable",
        "GitHub rejected the Rox GitHub App's credentials (401)",
        {
          hint: "Check GITHUB_APP_ID and the private key file.",
          cause: detail,
        },
      );
    }
    if (
      response.status === 403 &&
      response.headers.get("x-ratelimit-remaining") === "0"
    ) {
      throw new ToolError("rate_limited", "GitHub's rate limit was reached", {
        hint: "Wait a few minutes and try again.",
        cause: detail,
      });
    }
    if (response.status === 403) {
      throw new ToolError(
        "forbidden",
        `The Rox GitHub App is not allowed to read ${what}`,
        {
          hint: "The app may be missing a permission (for example Contents or Checks) on this installation.",
          cause: detail,
        },
      );
    }
    if (response.status === 404) {
      throw new ToolError("not_found", `GitHub cannot find ${what}`, {
        hint: "The repository may have been renamed or removed, or the Rox app is no longer installed on it.",
        cause: detail,
      });
    }
    throw new ToolError(
      "upstream",
      `GitHub answered with an error (${response.status}) for ${what}`,
      { cause: detail },
    );
  }

  async function installationToken(
    installationId: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const cached = tokens.get(installationId);
    if (cached && cached.expiresAt - 60_000 > now()) return cached.token;
    const inflight = inflightTokens.get(installationId);
    if (inflight) return inflight;

    const mint = (async () => {
      const jwt = appJwt();
      const route = `/app/installations/${installationId}/access_tokens`;
      let response = await request(route, {
        token: jwt,
        method: "POST",
        body: { permissions: READ_PERMISSIONS },
        signal,
      });
      // The app may not hold every permission we ask for; fall back to the smallest set.
      if (response.status === 422) {
        response = await request(route, {
          token: jwt,
          method: "POST",
          body: { permissions: { metadata: "read" } },
          signal,
        });
      }
      const text = await response.text();
      if (!response.ok) fail(response, "this GitHub installation", text);
      const parsed = JSON.parse(text) as { token: string; expires_at: string };
      tokens.set(installationId, {
        token: parsed.token,
        expiresAt: Date.parse(parsed.expires_at),
      });
      return parsed.token;
    })();

    inflightTokens.set(installationId, mint);
    try {
      return await mint;
    } finally {
      inflightTokens.delete(installationId);
    }
  }

  async function get<T>(
    t: Target,
    route: string,
    what: string,
    allowMissing = false,
  ): Promise<T | null> {
    const hadCached = tokens.has(t.installationId);
    let token = await installationToken(t.installationId, t.signal);
    let response = await request(route, { token, signal: t.signal });
    // If a cached installation token was revoked or expired early, re-mint once.
    if (response.status === 401 && hadCached) {
      tokens.delete(t.installationId);
      token = await installationToken(t.installationId, t.signal);
      response = await request(route, { token, signal: t.signal });
    }
    const text = await response.text();
    if (response.status === 404 && allowMissing) return null;
    if (!response.ok) fail(response, what, text);
    return JSON.parse(text) as T;
  }

  const repoRoute = (t: Target) =>
    `/repos/${t.repo.split("/").map(encodeURIComponent).join("/")}`;

  return {
    async getRepo(t) {
      const r = await get<Record<string, unknown>>(
        t,
        repoRoute(t),
        `the repository ${t.repo}`,
      );
      if (!r) throw new ToolError("not_found", `${t.repo} was not found`);
      return {
        fullName: String(r.full_name),
        private: Boolean(r.private),
        defaultBranch: String(r.default_branch),
        description: (r.description as string | null) ?? null,
        language: (r.language as string | null) ?? null,
        pushedAt: (r.pushed_at as string | null) ?? null,
        htmlUrl: String(r.html_url),
        archived: Boolean(r.archived),
        openIssuesAndPulls: Number(r.open_issues_count ?? 0),
      };
    },

    async getLanguages(t) {
      return (
        (await get<Record<string, number>>(
          t,
          `${repoRoute(t)}/languages`,
          "the language breakdown",
        )) ?? {}
      );
    },

    async listCommits(t, limit, since) {
      const from = since ? `&since=${since.toISOString()}` : "";
      const rows =
        (await get<Array<Record<string, unknown>>>(
          t,
          `${repoRoute(t)}/commits?per_page=${limit}${from}`,
          "recent commits",
        )) ?? [];
      return rows.map((c) => {
        const commit = (c.commit ?? {}) as {
          message?: string;
          author?: { name?: string; date?: string };
        };
        return {
          sha: String(c.sha).slice(0, 7),
          message: String(commit.message ?? "")
            .split("\n")[0]
            .slice(0, 120),
          author: commit.author?.name ?? "unknown",
          date: commit.author?.date ?? "",
        };
      });
    },

    async listOpenPulls(t, limit) {
      const rows =
        (await get<Array<Record<string, unknown>>>(
          t,
          `${repoRoute(t)}/pulls?state=open&per_page=${limit}`,
          "open pull requests",
        )) ?? [];
      return rows.map((p) => ({
        number: Number(p.number),
        title: String(p.title).slice(0, 120),
        author: String(
          (p.user as { login?: string } | null)?.login ?? "unknown",
        ),
        branch: String((p.head as { ref?: string } | null)?.ref ?? ""),
        draft: Boolean(p.draft),
        updatedAt: String(p.updated_at),
        headSha: String((p.head as { sha?: string } | null)?.sha ?? ""),
      }));
    },

    async countPulls(t) {
      const rows =
        (await get<Array<{ state: string; merged_at: string | null }>>(
          t,
          `${repoRoute(t)}/pulls?state=all&per_page=100`,
          "pull requests",
        )) ?? [];
      const open = rows.filter((p) => p.state === "open").length;
      const merged = rows.filter((p) => p.merged_at).length;
      return {
        total: rows.length,
        open,
        merged,
        closed: rows.length - open - merged,
        capped: rows.length === 100,
      };
    },

    async listPulls(t, limit) {
      const rows =
        (await get<Array<Record<string, unknown>>>(
          t,
          `${repoRoute(t)}/pulls?state=all&sort=created&direction=desc&per_page=${Math.min(100, Math.max(1, limit))}`,
          "pull requests",
        )) ?? [];
      return rows.map((p) => {
        const user = (p.user ?? {}) as { login?: string; type?: string };
        const mergedAt = (p.merged_at as string | null) ?? null;
        return {
          number: Number(p.number),
          title: String(p.title).slice(0, 120),
          author: user.login ?? "unknown",
          authorIsBot:
            user.type === "Bot" || (user.login ?? "").endsWith("[bot]"),
          state: mergedAt ? "merged" : p.state === "open" ? "open" : "closed",
          createdAt: String(p.created_at),
          mergedAt,
          closedAt: (p.closed_at as string | null) ?? null,
          url: String(p.html_url),
        };
      });
    },

    async getChecks(t, sha) {
      const data = await get<{
        check_runs?: Array<{
          name: string;
          status: string;
          conclusion: string | null;
        }>;
      }>(
        t,
        `${repoRoute(t)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=50`,
        "the check runs",
      );
      const runs = data?.check_runs ?? [];
      if (runs.length === 0) return { state: "none", total: 0, failing: [] };
      const failing = runs
        .filter(
          (r) =>
            r.conclusion &&
            ["failure", "timed_out", "cancelled", "action_required"].includes(
              r.conclusion,
            ),
        )
        .map((r) => r.name);
      const pending = runs.some((r) => r.status !== "completed");
      return {
        state: failing.length ? "failing" : pending ? "pending" : "passing",
        total: runs.length,
        failing,
      };
    },

    async listDir(t, dirPath, ref) {
      const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : "";
      const route = `${repoRoute(t)}/contents/${dirPath.split("/").filter(Boolean).map(encodeURIComponent).join("/")}${suffix}`;
      const data = await get<
        Array<{ name: string; type: string; size: number }> | { type: string }
      >(t, route, `the folder "${dirPath || "/"}"`, true);
      if (!data || !Array.isArray(data)) return null;
      return data.map((e) => ({
        name: e.name,
        type: e.type === "dir" ? "dir" : "file",
        size: e.size,
      }));
    },

    async getFile(t, filePath, maxBytes, ref) {
      const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : "";
      const route = `${repoRoute(t)}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}${suffix}`;
      const data = await get<{
        type?: string;
        encoding?: string;
        content?: string;
        size?: number;
      }>(t, route, `the file "${filePath}"`, true);
      if (
        !data ||
        data.type !== "file" ||
        data.encoding !== "base64" ||
        typeof data.content !== "string"
      )
        return null;
      return Buffer.from(data.content, "base64")
        .subarray(0, maxBytes)
        .toString("utf8");
    },
  };
}
