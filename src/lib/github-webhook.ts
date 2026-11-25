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

  if (event === "workflow_run") {
    const action = pick(payload, "action");
    const conclusion = pick(payload, "workflow_run.conclusion");
    if (action !== "completed")
      return { trigger: false, why: `workflow_run.${action} is not finished` };
    if (!BAD_CONCLUSIONS.includes(conclusion))
      return { trigger: false, why: `the workflow ${conclusion}, not failed` };
    const branch = pick(payload, "workflow_run.head_branch");
    if (OWN_BRANCH.test(branch))
      return { trigger: false, why: `${branch} is a branch Rox made itself` };
    return {
      trigger: true,
      kind: "ci_failed",
      key: `${repo}@${pick(payload, "workflow_run.head_sha")}:${pick(payload, "workflow_run.workflow_id")}`,
      why: `workflow "${pick(payload, "workflow_run.name")}" ${conclusion} on ${branch}`,
    };
  }

  if (event === "check_run") {
    // GitHub Actions is already covered by workflow_run; this catches other CI (Vercel, tests).
    const conclusion = pick(payload, "check_run.conclusion");
    const app = pick(payload, "check_run.app.slug");
    if (pick(payload, "action") !== "completed")
      return { trigger: false, why: "the check has not finished" };
    if (!BAD_CONCLUSIONS.includes(conclusion))
      return { trigger: false, why: `the check ${conclusion}, not failed` };
    if (app === "github-actions")
      return { trigger: false, why: "covered by the workflow_run event" };
    return {
      trigger: true,
      kind: "ci_failed",
      key: `${repo}@${pick(payload, "check_run.head_sha")}:${pick(payload, "check_run.name")}`,
      why: `check "${pick(payload, "check_run.name")}" from ${app} ${conclusion}`,
    };
  }

  return { trigger: false, why: `${event} is not used` };
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
  } else if (event === "ping") {
    rows.push([
      "subscribed to",
      ((at(payload, "hook.events") as string[] | undefined) ?? []).join(", ") ||
        "(none)",
    ]);
  }
  return rows;
}
