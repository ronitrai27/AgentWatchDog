// Opens the agent's pull request through the Rox GitHub App, like a person pushing a branch.
// Written so that running it twice (after a crash) finds the branch and the pull request it made
// the first time instead of making new ones. It never pushes to the repository's default branch.
// It opens a pull request into it only for a Sentry fix (intoDefault), which has no other branch
// to go to; the fix is still pushed to its own new branch, and merging stays a separate step.
import { appApi, writeToken } from "../src/github";
import type { Workspace } from "./workspace";

export type Target = {
  repo: string;
  /** The branch the fix is proposed to: a pull request's own branch, or a lab branch. */
  base: string;
  /** A Sentry fix: the pull request may go into the default branch (never a push to it). */
  intoDefault?: boolean;
};

type Ref = { object: { sha: string } };
type Pull = { number: number; html_url: string; state: string };

async function refSha(repo: string, branch: string, token: string) {
  try {
    const r = await appApi<Ref>(
      "GET",
      `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      token,
    );
    return r.object.sha;
  } catch (error) {
    if (/ 404:/.test(String(error))) return null;
    throw error;
  }
}

/** Never the default branch, whatever the caller asked. */
async function guard(repo: string, branch: string, token: string) {
  const info = await appApi<{ default_branch: string }>(
    "GET",
    `/repos/${repo}`,
    token,
  );
  if (branch === info.default_branch || /^(main|master)$/.test(branch))
    throw new Error(`refused: ${branch} is the default branch`);
}

/** One commit on top of `parent` with these files, as branch `branch` (made once). */
export async function commitFiles(
  repo: string,
  token: string,
  branch: string,
  parent: string,
  files: { path: string; content: string }[],
  message: string,
): Promise<string> {
  await guard(repo, branch, token);
  const existing = await refSha(repo, branch, token);
  if (existing) return existing;
  const base = await appApi<{ tree: { sha: string } }>(
    "GET",
    `/repos/${repo}/git/commits/${parent}`,
    token,
  );
  const tree = await appApi<{ sha: string }>(
    "POST",
    `/repos/${repo}/git/trees`,
    token,
    {
      base_tree: base.tree.sha,
      tree: files.map((f) => ({
        path: f.path,
        mode: "100644",
        type: "blob",
        content: f.content,
      })),
    },
  );
  const commit = await appApi<{ sha: string }>(
    "POST",
    `/repos/${repo}/git/commits`,
    token,
    { message, tree: tree.sha, parents: [parent] },
  );
  await appApi("POST", `/repos/${repo}/git/refs`, token, {
    ref: `refs/heads/${branch}`,
    sha: commit.sha,
  });
  return commit.sha;
}

/** The current content of the files a patch changed, read from the agent's copy. */
export async function filesFrom(
  ws: Workspace,
  files: string[],
): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  for (const path of files) {
    const r = await ws.exec(
      ["cat", "--", `${ws.root}/${path}`],
      "",
      20_000,
      2_000_000,
    );
    if (r.code !== 0)
      throw new Error(`could not read ${path} from the sandbox`);
    out.push({ path, content: r.stdout });
  }
  return out;
}

export async function openPullRequest(
  target: Target,
  fix: {
    branch: string;
    files: { path: string; content: string }[];
    title: string;
    body: string;
    message: string;
  },
): Promise<{ url: string; number: number; branch: string; created: boolean }> {
  const { repo, base } = target;
  const token = await writeToken(repo);
  if (!target.intoDefault) await guard(repo, base, token);
  // The fix's own branch is never the default branch, whatever the target.
  await guard(repo, fix.branch, token);
  const parent = await refSha(repo, base, token);
  if (!parent) throw new Error(`the branch ${base} does not exist`);
  await commitFiles(repo, token, fix.branch, parent, fix.files, fix.message);
  const owner = repo.split("/")[0];
  const open = await appApi<Pull[]>(
    "GET",
    `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${fix.branch}`)}`,
    token,
  );
  if (open[0])
    return {
      url: open[0].html_url,
      number: open[0].number,
      branch: fix.branch,
      created: false,
    };
  const pr = await appApi<Pull>("POST", `/repos/${repo}/pulls`, token, {
    title: fix.title,
    head: fix.branch,
    base,
    body: fix.body,
    maintainer_can_modify: true,
  });
  return {
    url: pr.html_url,
    number: pr.number,
    branch: fix.branch,
    created: true,
  };
}
