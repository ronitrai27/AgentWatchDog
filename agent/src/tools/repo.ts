// Tools that read the user's GitHub repository. All read-only.
import { z } from "zod";
import type { CheckSummary, PullSummary } from "../integrations/github";
import { defineTool } from "./define";
import { detectProject } from "./detect";
import { githubTarget, plural } from "./shared";
import { ToolError } from "./types";

const reason = (r: PromiseRejectedResult) =>
  r.reason instanceof Error ? r.reason.message : String(r.reason);

export const repoOverview = defineTool({
  name: "repo_overview",
  group: "repo",
  description:
    "Reads the connected GitHub repository's overview: default branch, main language, last push, recent commits, open pull requests with their check status, and the status of the default branch's checks. " +
    "Use it to see what state the project is in. It cannot list GitHub issues (the Rox app has no Issues permission). It does not read file contents; use repo_detect_project for that.",
  input: z.object({}),
  risk: "read",
  timeoutMs: 25_000,
  title: () => "Read the repository overview",
  async run(_input, ctx) {
    const { client, target } = await githubTarget(ctx);
    const warnings: string[] = [];

    const repo = await client.getRepo(target); // if this fails, the whole tool fails with the reason
    const [languages, commits, pulls, mainChecks] = await Promise.allSettled([
      client.getLanguages(target),
      client.listCommits(target, 5),
      client.listOpenPulls(target, 8),
      client.getChecks(target, repo.defaultBranch),
    ]);
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
      warnings,
      limits: [
        "GitHub issues are not visible: the Rox GitHub App has no Issues permission.",
      ],
    };
  },
  summarize(output) {
    const o = output as {
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
    return `${o.repository} · ${plural(o.openPullRequests.length, "open PR")}${checks}${warn}`;
  },
});

const PACKAGE_JSON_LIMIT = 40_000;

export const repoDetectProject = defineTool({
  name: "repo_detect_project",
  group: "repo",
  description:
    "Works out what kind of project the connected repository is: language, package manager, framework, and the install, build, test and start commands, plus Docker and CI files. " +
    "It reads the file list and package.json from the default branch. Use it to find out whether Rox can build and test the project. It does not run anything.",
  input: z.object({}),
  risk: "read",
  timeoutMs: 25_000,
  title: () => "Detect the project type",
  async run(_input, ctx) {
    const { client, target } = await githubTarget(ctx);
    const repo = await client.getRepo(target);
    const ref = repo.defaultBranch;

    const root = await client.listDir(target, "", ref);
    if (!root)
      throw new ToolError(
        "not_found",
        `The repository ${target.repo} looks empty: GitHub returned no files`,
      );
    const rootNames = root.map((e) => e.name);

    const [packageJson, workflowDir] = await Promise.allSettled([
      rootNames.includes("package.json")
        ? client.getFile(target, "package.json", PACKAGE_JSON_LIMIT, ref)
        : Promise.resolve(null),
      rootNames.includes(".github")
        ? client.listDir(target, ".github/workflows", ref)
        : Promise.resolve(null),
    ]);
    const warnings: string[] = [];
    if (packageJson.status === "rejected")
      warnings.push(`package.json: ${reason(packageJson)}`);
    if (workflowDir.status === "rejected")
      warnings.push(`workflows: ${reason(workflowDir)}`);

    const detection = detectProject({
      rootNames,
      packageJson:
        packageJson.status === "fulfilled" ? packageJson.value : null,
      workflows:
        workflowDir.status === "fulfilled" && workflowDir.value
          ? workflowDir.value
              .filter((f) => /\.ya?ml$/.test(f.name))
              .map((f) => f.name)
          : [],
    });
    return {
      repository: repo.fullName,
      branch: ref,
      ...detection,
      topLevelFiles: rootNames.slice(0, 40),
      warnings,
    };
  },
  summarize(output) {
    const o = output as {
      languages: string[];
      framework: string | null;
      packageManager: string | null;
      hasTests: boolean;
    };
    return [
      o.languages.join("/") || "unknown language",
      o.framework,
      o.packageManager,
      o.hasTests ? "has tests" : "no tests found",
    ]
      .filter(Boolean)
      .join(" · ");
  },
});
