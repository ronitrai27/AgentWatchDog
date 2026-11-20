import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const API = "https://api.github.com";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; see .env.example`);
  return value;
}

export const appSlug = () => process.env.GITHUB_APP_SLUG ?? "rox-watchdog";

export const installUrl = (state?: string) => {
  const url = new URL(`https://github.com/apps/${appSlug()}/installations/new`);
  if (state) url.searchParams.set("state", state);
  return url.toString();
};

/** Short-lived JWT that identifies the App itself (not a user). */
function appJwt(): string {
  const pem = readFileSync(
    path.resolve(process.cwd(), required("GITHUB_APP_PRIVATE_KEY_PATH")),
    "utf8",
  );
  const b64 = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iat: now - 30,
    exp: now + 540,
    iss: required("GITHUB_APP_ID"),
  })}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(pem)
    .toString("base64url");
  return `${unsigned}.${signature}`;
}

export async function gh<T>(
  route: string,
  options: { token: string; method?: string; body?: unknown },
): Promise<T> {
  const response = await fetch(`${API}${route}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${options.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "rox-watchdog",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`GitHub ${route} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

export type Installation = {
  id: number;
  account: { login: string; avatar_url: string; type: string };
  repository_selection: "all" | "selected";
  permissions: Record<string, string>;
  events: string[];
  suspended_at: string | null;
};

export type Repo = {
  full_name: string;
  private: boolean;
  default_branch: string;
};

export function getInstallation(id: number): Promise<Installation> {
  return gh<Installation>(`/app/installations/${id}`, { token: appJwt() });
}

/**
 * Lists the repos this installation can see. The token is minted with the
 * narrowest permission that works (metadata: read), not the App's full set.
 */
export async function getInstallationRepos(id: number): Promise<Repo[]> {
  const { token } = await gh<{ token: string }>(
    `/app/installations/${id}/access_tokens`,
    {
      token: appJwt(),
      method: "POST",
      body: { permissions: { metadata: "read" } },
    },
  );
  const { repositories } = await gh<{ repositories: Repo[] }>(
    "/installation/repositories?per_page=100",
    { token },
  );
  return repositories;
}

/** What Rox actually needs. Anything beyond this is flagged by the permissions audit. */
export const EXPECTED_PERMISSIONS: Record<string, "read" | "write"> = {
  metadata: "read",
  contents: "write",
  pull_requests: "write",
  checks: "read",
  actions: "read",
};

const RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

export type PermissionAudit = {
  /** Granted but not needed, or granted at a higher level than needed. */
  broader: { name: string; granted: string; needed: string }[];
  /** Needed but not granted. */
  missing: { name: string; needed: string }[];
};

export function auditPermissions(
  granted: Record<string, string>,
): PermissionAudit {
  const broader: PermissionAudit["broader"] = [];
  const missing: PermissionAudit["missing"] = [];

  for (const [name, level] of Object.entries(granted)) {
    // GitHub lists this housekeeping entry on some Apps; it is not a repo permission.
    if (name === "installation_repositories") continue;
    const needed = EXPECTED_PERMISSIONS[name];
    if (!needed) {
      broader.push({ name, granted: level, needed: "none" });
    } else if ((RANK[level] ?? 0) > RANK[needed]) {
      broader.push({ name, granted: level, needed });
    }
  }
  for (const [name, needed] of Object.entries(EXPECTED_PERMISSIONS)) {
    if ((RANK[granted[name] ?? ""] ?? 0) < RANK[needed]) {
      missing.push({ name, needed });
    }
  }
  return { broader, missing };
}
