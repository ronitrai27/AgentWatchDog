// Tools that read the user's GitHub repository. All read-only.
import { z } from "zod";
import type {
  CheckSummary,
  PullDetail,
  PullSummary,
} from "../integrations/github";
import type { RunList } from "../store/sessions";
import { defineTool } from "./define";
import { githubTarget, plural } from "./shared";

const reason = (r: PromiseRejectedResult) =>
  r.reason instanceof Error ? r.reason.message : String(r.reason);

/** The Rox GitHub App's bot account, as it appears as a pull request author. */
const ROX_BOT = `${process.env.GITHUB_APP_SLUG?.trim() || "rox-watchdog"}[bot]`;

const WINDOWS = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 } as const;

export const repoInfo = defineTool({
  name: "repo_info",
  group: "repo",
  description:
    "Reads everything about the connected GitHub repository in one call: name, default branch, languages, last push, the default branch's checks, open pull requests with their checks, recent commits, " +
    "AND activity in a time window: pull requests opened, merged and closed, how many of them Rox (its GitHub App bot) opened and how many of those were merged, commits pushed, and the pull requests Rox's runs opened. " +
    'Use it for any question about the repo, its pull requests, commits, CI state, or what Rox has contributed ("how many PRs has Rox made", "how many got merged"). ' +
    "It cannot see GitHub issues (no Issues permission) and does not read file contents. It does not work in Quick Judge Mode (demo app).",
  input: z.object({
    window: z
      .enum(["24h", "7d", "30d", "90d"])
      .optional()
      .describe("The activity window. Default 30d."),
  }),
  risk: "read",
  timeoutMs: 30_000,
  title: () => "Read the repository and its activity",
  async run(input, ctx) {
    const { client, target } = await githubTarget(ctx);
    const warnings: string[] = [];
    const window = input.window ?? "30d";
    const since = new Date(Date.now() - WINDOWS[window] * 86_400_000);

    const repo = await client.getRepo(target); // if this fails, the whole tool fails with the reason
    const [
      languages,
      commits,
      pulls,
      mainChecks,
      allPulls,
      windowCommits,
      roxRuns,
    ] = await Promise.allSettled([
      client.getLanguages(target),
      client.listCommits(target, 5),
      client.listOpenPulls(target, 8),
      client.getChecks(target, repo.defaultBranch),
      client.listPulls(target, 100),
      client.listCommits(target, 100, since),
      ctx.store.listRuns(ctx.userId, {
        repo: target.repo,
        since,
        limit: 50,
      }),
    ]);
    if (allPulls.status === "rejected")
      warnings.push(`Pull request history: ${reason(allPulls)}`);
    if (windowCommits.status === "rejected")
      warnings.push(`Commits in the window: ${reason(windowCommits)}`);
    if (roxRuns.status === "rejected")
      warnings.push(`Rox runs: ${reason(roxRuns)}`);
    if (languages.status === "rejected")
      warnings.push(`Languages: ${reason(languages)}`);
    if (commits.status === "rejected")
      warnings.push(`Commits: ${reason(commits)}`);
    if (pulls.status === "rejected")
      warnings.push(`Pull requests: ${reason(pulls)}`);
    if (mainChecks.status === "rejected")
      warnings.push(`Checks on ${repo.defaultBranch}: ${reason(mainChecks)}`);

    const pullList: PullSummary[] =
      pulls.status === "fulfilled" ? pulls.value : [];
    const pullChecks = await Promise.allSettled(
      pullList.slice(0, 5).map((p) => client.getChecks(target, p.headSha)),
    );

    const total =
      languages.status === "fulfilled"
        ? Object.values(languages.value).reduce((a, b) => a + b, 0)
        : 0;
    const languageShare =
      languages.status === "fulfilled" && total > 0
        ? Object.entries(languages.value)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([name, bytes]) => ({
              name,
              percent: Math.round((bytes / total) * 100),
            }))
        : [];

    return {
      repository: repo.fullName,
      url: repo.htmlUrl,
      private: repo.private,
      archived: repo.archived,
      description: repo.description,
      defaultBranch: repo.defaultBranch,
      mainLanguage: repo.language,
      languages: languageShare,
      lastPush: repo.pushedAt,
      defaultBranchChecks:
        mainChecks.status === "fulfilled" ? mainChecks.value : null,
      openPullRequests: pullList.map((p, i) => ({
        number: p.number,
        title: p.title,
        author: p.author,
        branch: p.branch,
        draft: p.draft,
        updatedAt: p.updatedAt,
        checks:
          pullChecks[i]?.status === "fulfilled"
            ? (pullChecks[i] as PromiseFulfilledResult<CheckSummary>).value
            : null,
      })),
      recentCommits: commits.status === "fulfilled" ? commits.value : [],
      activity: activity(window, since, allPulls, windowCommits, roxRuns),
      warnings,
      limits: [
        "GitHub issues are not visible: the Rox GitHub App has no Issues permission.",
      ],
    };
  },
  summarize(output) {
    const o = output as {
      activity?: { roxPullRequests?: { opened: number; merged: number } };
      repository: string;
      openPullRequests: unknown[];
      defaultBranchChecks: CheckSummary | null;
      warnings: string[];
    };
    const checks = o.defaultBranchChecks
      ? ` · checks ${o.defaultBranchChecks.state}`
      : "";
    const warn = o.warnings.length
      ? ` · ${plural(o.warnings.length, "warning")}`
      : "";
    const rox = o.activity?.roxPullRequests;
    const roxLine = rox ? ` · Rox ${rox.opened} PRs, ${rox.merged} merged` : "";
    return `${o.repository} · ${plural(o.openPullRequests.length, "open PR")}${checks}${roxLine}${warn}`;
  },
});

type Settled<T> = PromiseSettledResult<T>;

/** Counts in code, so the model never has to add up a list. */
function activity(
  window: string,
  since: Date,
  pulls: Settled<PullDetail[]>,
  commits: Settled<{ sha: string }[]>,
  runs: Settled<RunList>,
) {
  const inWindow = (at: string | null) =>
    Boolean(at) && Date.parse(at as string) >= since.getTime();
  const all = pulls.status === "fulfilled" ? pulls.value : null;
  const rox = all?.filter((p) => p.author === ROX_BOT) ?? null;
  const count = (list: PullDetail[]) => ({
    opened: list.filter((p) => inWindow(p.createdAt)).length,
    merged: list.filter((p) => inWindow(p.mergedAt)).length,
    closedUnmerged: list.filter(
      (p) => p.state === "closed" && inWindow(p.closedAt),
    ).length,
    openNow: list.filter((p) => p.state === "open").length,
  });
  const runList = runs.status === "fulfilled" ? runs.value : null;
  return {
    window,
    since: since.toISOString(),
    pullRequests: all ? count(all) : null,
    roxBot: ROX_BOT,
    roxPullRequests: rox
      ? {
          ...count(rox),
          list: rox.slice(0, 10).map((p) => ({
            number: p.number,
            title: p.title,
            state: p.state,
            createdAt: p.createdAt,
            url: p.url,
          })),
        }
      : null,
    otherBots: all
      ? [
          ...new Set(
            all
              .filter((p) => p.authorIsBot && p.author !== ROX_BOT)
              .map((p) => p.author),
          ),
        ]
      : [],
    commitsPushed:
      commits.status === "fulfilled"
        ? { count: commits.value.length, capped: commits.value.length === 100 }
        : null,
    roxRuns: runList
      ? {
          total: runList.windowTotal,
          byResult: runList.windowByResult,
          openedPullRequests: runList.windowByResult.pr_opened ?? 0,
        }
      : null,
    ...(all && all.length === 100
      ? {
          note: "Only the newest 100 pull requests were read; older ones are not counted.",
        }
      : {}),
  };
}
