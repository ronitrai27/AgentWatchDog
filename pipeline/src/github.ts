// GitHub access for the lab, through the Rox GitHub App: short-lived tokens for one repository.
// Reading uses a read-only token; only publishing a fix asks for write access.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { need, rootDir } from "./env";

const API = "https://api.github.com";

function appJwt(): string {
  const pem = readFileSync(
    path.resolve(rootDir, need("GITHUB_APP_PRIVATE_KEY_PATH")),
    "utf8",
  );
  const b64 = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 30, exp: now + 540, iss: need("GITHUB_APP_ID") })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(pem).toString("base64url")}`;
}

async function api<T>(
  route: string,
  token: string,
  body?: unknown,
  method = body ? "POST" : "GET",
): Promise<T> {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "rox-lab",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok)
    throw new Error(
      `GitHub ${route} answered ${res.status}: ${json.message ?? ""}`,
    );
  return json;
}

export const appApi = <T = unknown>(
  method: "GET" | "POST" | "PATCH" | "PUT",
  route: string,
  token: string,
  body?: unknown,
) => api<T>(route, token, body, method);

/**
 * Merges a pull request Rox opened (only when the user chose Merge PR in Settings > Agent; the
 * model never decides this). GitHub may still be computing whether it can merge, so it asks again
 * a few times. Returns the merge commit.
 */
export async function mergePullRequest(
  repo: string,
  number: number,
  title: string,
): Promise<string> {
  const token = await writeToken(repo);
  let last: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await appApi<{ sha: string; merged: boolean }>(
        "PUT",
        `/repos/${repo}/pulls/${number}/merge`,
        token,
        { merge_method: "squash", commit_title: `${title} (#${number})` },
      );
      if (r.merged) return r.sha;
    } catch (error) {
      last = error;
      // 405: not mergeable yet (checks or mergeability still being computed); 409: head moved.
      if (!/answered (405|409)/.test(String(error))) throw error;
    }
    await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
  }
  throw last instanceof Error
    ? last
    : new Error("GitHub did not merge the pull request");
}

/** A token that can push branches and open pull requests in this one repository. */
export const writeToken = (repo: string) =>
  token(repo, { contents: "write", pull_requests: "write" });

/** A token that can read this one repository, valid for an hour. */
export const readToken = (repo: string) =>
  token(repo, { contents: "read", pull_requests: "read" });

async function token(
  repo: string,
  permissions: Record<string, "read" | "write">,
): Promise<string> {
  const jwt = appJwt();
  const { id } = await api<{ id: number }>(`/repos/${repo}/installation`, jwt);
  const { token } = await api<{ token: string }>(
    `/app/installations/${id}/access_tokens`,
    jwt,
    {
      repositories: [repo.split("/")[1]],
      permissions,
    },
  );
  return token;
}

export type PullInfo = {
  number: number;
  title: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
};

export async function pullInfo(
  repo: string,
  number: number,
): Promise<PullInfo> {
  const p = await api<{
    number: number;
    title: string;
    head: { ref: string; sha: string };
    base: { ref: string; sha: string };
  }>(`/repos/${repo}/pulls/${number}`, await readToken(repo));
  return {
    number: p.number,
    title: p.title,
    headRef: p.head.ref,
    headSha: p.head.sha,
    baseRef: p.base.ref,
    baseSha: p.base.sha,
  };
}

/** Git's way of sending the token: a basic-auth header, never stored in the clone's config. */
export const gitAuthHeader = (token: string) =>
  `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

/** The full commit id of a branch, tag or short commit id. */
export async function commitSha(repo: string, ref: string): Promise<string> {
  const c = await api<{ sha: string }>(
    `/repos/${repo}/commits/${encodeURIComponent(ref)}`,
    await readToken(repo),
  );
  return c.sha;
}
