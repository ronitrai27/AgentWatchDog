// GitHub webhooks, step one: check who sent it, work out what it is, and decide whether Rox
// should wake up. Nothing here starts a run. Pure functions, so the same code can later hand
// the verdict to a Temporal workflow.
import { createHmac, timingSafeEqual } from "node:crypto";

type Obj = { [key: string]: unknown };

const at = (value: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (v, key) => (v && typeof v === "object" ? (v as Obj)[key] : undefined),
      value,
    );

/** A value from the payload as text, or "-" when it is missing. */
export const pick = (payload: unknown, path: string): string => {
  const value = at(payload, path);
  return value === undefined || value === null ? "-" : String(value);
};

/** True only if the body was signed with our secret. GitHub sends `sha256=<hex>`. */
export function validSignature(
  body: string,
  header: string | null,
  secret: string,
): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(body).digest("hex"),
  );
  const given = Buffer.from(header.slice(7));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export type Verdict =
  | {
      trigger: true;
      kind: "pr_to_default" | "ci_failed";
      /** The same event twice gives the same key, so a run can be started only once. */
      key: string;
      why: string;
    }
  | { trigger: false; why: string };

const PR_ACTIONS = ["opened", "reopened", "synchronize", "ready_for_review"];
const BAD_CONCLUSIONS = ["failure", "timed_out"];
/** Branches Rox pushes to. It never reacts to its own work, or it would loop. */
const OWN_BRANCH = /^awd\//;

export function decide(event: string, payload: unknown): Verdict {
  const repo = pick(payload, "repository.full_name");
  const defaultBranch = pick(payload, "repository.default_branch");

  if (event === "pull_request") {
    const action = pick(payload, "action");
    if (!PR_ACTIONS.includes(action))
      return { trigger: false, why: `pull_request.${action} is not used` };
    const base = pick(payload, "pull_request.base.ref");
    const head = pick(payload, "pull_request.head.ref");
    if (base !== defaultBranch)
      return {
        trigger: false,
        why: `the pull request targets ${base}, not ${defaultBranch}`,
      };
    if (OWN_BRANCH.test(head))
      return { trigger: false, why: `${head} is a branch Rox made itself` };
    if (at(payload, "pull_request.draft") === true)
      return {
        trigger: false,
        why: "draft pull request (waits for ready_for_review)",
      };
    return {
      trigger: true,
      kind: "pr_to_default",
      key: `${repo}#${pick(payload, "pull_request.number")}@${pick(payload, "pull_request.head.sha")}`,
      why: `pull request into ${defaultBranch}`,
    };
  }

  if (event === "workflow_run")
    return {
      trigger: false,
      why: "covered by the check_run event, which every CI sends (Actions, Vercel, tests)",
    };

  if (event === "check_run") {
    // The one CI signal: GitHub Actions, Vercel and any test service all send check runs.
    const conclusion = pick(payload, "check_run.conclusion");
    const app = pick(payload, "check_run.app.slug");
    if (pick(payload, "action") !== "completed")
      return { trigger: false, why: "the check has not finished" };
    if (!BAD_CONCLUSIONS.includes(conclusion))
      return { trigger: false, why: `the check ${conclusion}, not failed` };
    const branch = pick(payload, "check_run.check_suite.head_branch");
    if (OWN_BRANCH.test(branch))
      return { trigger: false, why: `${branch} is a branch Rox made itself` };
    return {
      trigger: true,
      kind: "ci_failed",
      key: `${repo}@${pick(payload, "check_run.head_sha")}:${pick(payload, "check_run.name")}`,
      why: `check "${pick(payload, "check_run.name")}" from ${app} ${conclusion}`,
    };
  }

  if (event === "push") {
    const ref = pick(payload, "ref");
    if (!ref.startsWith("refs/heads/"))
      return { trigger: false, why: `${ref} is not a branch` };
    const branch = ref.slice("refs/heads/".length);
    if (OWN_BRANCH.test(branch))
      return { trigger: false, why: `${branch} is a branch Rox made itself` };
    return {
      trigger: false,
      why:
        branch === defaultBranch
          ? `a push to ${defaultBranch} is only recorded; the checks that follow it are what Rox hears`
          : `a push to ${branch} is only recorded; a pull request is what Rox hears`,
    };
  }

  return { trigger: false, why: `${event} is not used` };
}

export type Summary = {
  branch: string | null;
  sha: string | null;
  prNumber: number | null;
  title: string | null;
};

/** The few fields every event shares, for the trace. */
export function summarize(event: string, payload: unknown): Summary {
  const some = (path: string) => {
    const value = pick(payload, path);
    return value === "-" ? null : value;
  };
  if (event === "pull_request")
    return {
      branch: some("pull_request.head.ref"),
      sha: some("pull_request.head.sha"),
      prNumber: Number(some("pull_request.number")) || null,
      title: some("pull_request.title"),
    };
  if (event === "workflow_run")
    return {
      branch: some("workflow_run.head_branch"),
      sha: some("workflow_run.head_sha"),
      prNumber: Number(some("workflow_run.pull_requests.0.number")) || null,
      title: some("workflow_run.name"),
    };
  if (event === "check_run")
    return {
      branch: some("check_run.check_suite.head_branch"),
      sha: some("check_run.head_sha"),
      prNumber: Number(some("check_run.pull_requests.0.number")) || null,
      title: some("check_run.name"),
    };
  if (event === "push")
    return {
      branch: some("ref")?.replace("refs/heads/", "") ?? null,
      sha: some("after"),
      prNumber: null,
      title: some("head_commit.message")?.split("\n")[0] ?? null,
    };
  return { branch: null, sha: null, prNumber: null, title: null };
}

/** The facts of an event, one line each, for the console. */
export function details(event: string, payload: unknown): [string, string][] {
  const rows: [string, string][] = [
    [
      "repo",
      `${pick(payload, "repository.full_name")}  (default branch ${pick(payload, "repository.default_branch")}, installation ${pick(payload, "installation.id")})`,
    ],
    ["sender", pick(payload, "sender.login")],
  ];
  if (event === "pull_request") {
    const p = (path: string) => pick(payload, `pull_request.${path}`);
    rows.push(
      ["PR", `#${p("number")} "${p("title")}" by ${p("user.login")}`],
      ["branches", `${p("head.ref")} -> ${p("base.ref")}`],
      [
        "state",
        `draft ${p("draft")}, from a fork ${p("head.repo.full_name") !== pick(payload, "repository.full_name")}`,
      ],
      [
        "change",
        `${p("head.sha").slice(0, 7)}  +${p("additions")} -${p("deletions")} in ${p("changed_files")} files, ${p("commits")} commits`,
      ],
      ["link", p("html_url")],
    );
  } else if (event === "workflow_run") {
    const w = (path: string) => pick(payload, `workflow_run.${path}`);
    rows.push(
      [
        "workflow",
        `"${w("name")}" run #${w("run_number")}, attempt ${w("run_attempt")}`,
      ],
      [
        "result",
        `${w("status")} / ${w("conclusion")} (trigger: ${w("event")})`,
      ],
      ["branch", `${w("head_branch")} @ ${w("head_sha").slice(0, 7)}`],
      [
        "pull requests",
        (at(payload, "workflow_run.pull_requests") as Obj[] | undefined)
          ?.map((p) => `#${p.number}`)
          .join(", ") || "none (a push)",
      ],
      ["link", w("html_url")],
    );
  } else if (event === "check_run") {
    const c = (path: string) => pick(payload, `check_run.${path}`);
    rows.push(
      ["check", `"${c("name")}" from ${c("app.slug")}`],
      ["result", `${c("status")} / ${c("conclusion")}`],
      ["commit", c("head_sha").slice(0, 7)],
      ["link", c("html_url")],
    );
  } else if (event === "push") {
    const commits =
      (at(payload, "commits") as unknown[] | undefined)?.length ?? 0;
    rows.push(
      ["branch", pick(payload, "ref").replace("refs/heads/", "")],
      [
        "push",
        `${pick(payload, "before").slice(0, 7)} -> ${pick(payload, "after").slice(0, 7)}, ${commits} commit${commits === 1 ? "" : "s"}${at(payload, "forced") === true ? ", FORCED" : ""}`,
      ],
      [
        "latest",
        `"${pick(payload, "head_commit.message").split("\n")[0]}" by ${pick(payload, "head_commit.author.username")}`,
      ],
      ["link", pick(payload, "compare")],
    );
  } else if (event === "ping") {
    rows.push([
      "subscribed to",
      ((at(payload, "hook.events") as string[] | undefined) ?? []).join(", ") ||
        "(none)",
    ]);
  }
  return rows;
}
