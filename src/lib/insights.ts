// What the empty Home page says about the project. Every value is read from GitHub when asked;
// a part that cannot be read is null, never guessed.
import type { CheckSummary, PullCounts } from "@agent/integrations/github";
import { ToolError } from "@agent/tools/types";
import { withUser } from "./db";
import { rox } from "./rox";

export const ACTIVITY_DAYS = 14;

export type Insights = {
  github: "connected" | "expired" | "unreachable" | "demo" | "none";
  activity: {
    perDay: number[];
    total: number;
    capped: boolean;
    last: string | null;
  } | null;
  health: {
    branch: string;
    checks: CheckSummary["state"];
    pulls: {
      number: number;
      title: string;
      checks: CheckSummary["state"] | null;
    }[];
  } | null;
  pulls: PullCounts | null;
  security: { label: string; ok: boolean }[] | null;
};

const DAY = 86_400_000;
const LOCKFILE =
  /^(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|poetry\.lock|uv\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/;

const settled = <T>(r: PromiseSettledResult<T>) =>
  r.status === "fulfilled" ? r.value : null;

export const INSIGHTS_TTL_MS = 30 * 60_000;

type CacheEntry = {
  at: number;
  value: Promise<Insights>;
  lastGood?: Insights;
};

// Shared on globalThis so /api/insights and /api/brief (separate Next.js route bundles)
// deduplicate in-flight requests and reuse the 30-minute cache.
const shared = globalThis as {
  roxInsightsCache?: Map<string, CacheEntry>;
};
const recent = (shared.roxInsightsCache ??= new Map<string, CacheEntry>());

export function invalidateInsights(userId: string): void {
  recent.delete(userId);
}

export function getInsights(
  userId: string,
  isJudge: boolean,
): Promise<Insights> {
  const known = recent.get(userId);
  if (known && Date.now() - known.at < INSIGHTS_TTL_MS) return known.value;
  const previousGood = known?.lastGood;
  const value = readInsights(userId, isJudge).then((result) => {
    if (result.github === "unreachable" && previousGood) {
      return previousGood;
    }
    return result;
  });
  const entry: CacheEntry = { at: Date.now(), value, lastGood: previousGood };
  recent.set(userId, entry);
  value.then(
    (i) => {
      if (i.github === "connected") {
        entry.lastGood = i;
      } else if (i.github === "unreachable" || i.github === "expired") {
        if (recent.get(userId) === entry) recent.delete(userId);
      }
    },
    () => {
      if (recent.get(userId) === entry) recent.delete(userId);
    },
  );
  return value;
}

async function readInsights(
  userId: string,
  isJudge: boolean,
): Promise<Insights> {
  const empty = (github: Insights["github"]): Insights => ({
    github,
    activity: null,
    health: null,
    pulls: null,
    security: null,
  });
  if (isJudge) return empty("demo");

  const row = await withUser(userId, async (c) => {
    const { rows } = await c.query<{
      repo: string | null;
      repo_installation_id: string | null;
    }>("SELECT repo, repo_installation_id FROM user_setup WHERE user_id = $1", [
      userId,
    ]);
    return rows[0];
  });
  const { github } = rox();
  if (!github || !row?.repo || row.repo_installation_id === null)
    return empty("none");

  const baseTarget = {
    repo: row.repo,
    installationId: Number(row.repo_installation_id),
  };
  const stageTarget = () => ({
    ...baseTarget,
    signal: AbortSignal.timeout(15_000),
  });
  let branch: string;
  try {
    branch = (await github.getRepo(stageTarget())).defaultBranch;
  } catch (error) {
    const kind = error instanceof ToolError ? error.kind : "failed";
    return empty(
      kind === "not_found" || kind === "forbidden" || kind === "unavailable"
        ? "expired"
        : "unreachable",
    );
  }

  const today = Math.floor(Date.now() / DAY);
  const since = new Date((today - ACTIVITY_DAYS + 1) * DAY);
  const dataTarget = stageTarget();
  const [commits, checks, pulls, counts, root, dotGithub, workflows] =
    await Promise.allSettled([
      github.listCommits(dataTarget, 100, since),
      github.getChecks(dataTarget, branch),
      github.listOpenPulls(dataTarget, 8),
      github.countPulls(dataTarget),
      github.listDir(dataTarget, "", branch),
      github.listDir(dataTarget, ".github", branch),
      github.listDir(dataTarget, ".github/workflows", branch),
    ]);

  const insights = empty("connected");
  insights.pulls = settled(counts);

  const log = settled(commits);
  if (log) {
    const perDay = new Array<number>(ACTIVITY_DAYS).fill(0);
    for (const c of log) {
      const slot =
        ACTIVITY_DAYS - 1 - (today - Math.floor(Date.parse(c.date) / DAY));
      if (slot >= 0 && slot < ACTIVITY_DAYS) perDay[slot]++;
    }
    insights.activity = {
      perDay,
      total: log.length,
      capped: log.length === 100,
      last: log[0]?.message ?? null,
    };
  }

  const main = settled(checks);
  const open = settled(pulls);
  if (main && open) {
    const first = open.slice(0, 5);
    const prTarget = stageTarget();
    const pullChecks = await Promise.allSettled(
      first.map((p) => github.getChecks(prTarget, p.headSha)),
    );
    insights.health = {
      branch,
      checks: main.state,
      pulls: first.map((p, i) => ({
        number: p.number,
        title: p.title,
        checks: settled(pullChecks[i])?.state ?? null,
      })),
    };
  }

  const files = settled(root);
  if (
    files &&
    dotGithub.status === "fulfilled" &&
    workflows.status === "fulfilled"
  ) {
    const names = files.map((f) => f.name);
    const more = (dotGithub.value ?? []).map((f) => f.name);
    const has = (pattern: RegExp) =>
      names.some((n) => pattern.test(n)) || more.some((n) => pattern.test(n));
    insights.security = [
      { label: "a lockfile", ok: names.some((n) => LOCKFILE.test(n)) },
      {
        label: "a CI workflow",
        ok: (workflows.value ?? []).some((f) => /\.ya?ml$/.test(f.name)),
      },
      {
        label: "dependency updates",
        ok: has(/^(dependabot\.ya?ml|\.?renovate(rc)?(\.json5?)?)$/),
      },
      { label: "a security policy", ok: has(/^SECURITY(\.md)?$/i) },
      {
        label: "a repo without .env files",
        ok: !names.some((n) => /^\.env(\.(local|production))?$/.test(n)),
      },
    ];
  }
  return insights;
}
