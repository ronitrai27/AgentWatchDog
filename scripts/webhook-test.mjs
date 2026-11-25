// Sends signed sample events to the local webhook route, so it can be tried without GitHub.
//   node scripts/webhook-test.mjs all
//   node scripts/webhook-test.mjs pr-to-main | pr-to-feature | pr-draft | pr-own-branch |
//                                 ci-failed | ci-passed | ci-own-branch | ping | bad-signature
import { createHmac, randomUUID } from "node:crypto";
import { need } from "./lib.mjs";

const url = `${process.env.APP_URL ?? "http://localhost:3000"}/api/webhooks/github`;
const repository = {
  full_name: "ronitrai27/Testing_SRE_Demo_App",
  default_branch: "main",
};
const base = {
  repository,
  installation: { id: 1 },
  sender: { login: "alice" },
};

const pr = (action, head, to, extra = {}) => ({
  ...base,
  action,
  pull_request: {
    number: 7,
    title: "Add coupon codes",
    html_url: "https://github.com/ronitrai27/Testing_SRE_Demo_App/pull/7",
    user: { login: "alice" },
    draft: false,
    additions: 120,
    deletions: 3,
    changed_files: 5,
    commits: 2,
    base: { ref: to },
    head: {
      ref: head,
      sha: "1a2b3c4d5e6f",
      repo: { full_name: repository.full_name },
    },
    ...extra,
  },
});

const run = (conclusion, branch) => ({
  ...base,
  action: "completed",
  workflow_run: {
    name: "CI",
    workflow_id: 99,
    run_number: 12,
    run_attempt: 1,
    status: "completed",
    conclusion,
    event: "pull_request",
    head_branch: branch,
    head_sha: "9f8e7d6c5b4a",
    html_url:
      "https://github.com/ronitrai27/Testing_SRE_Demo_App/actions/runs/1",
    pull_requests: branch === "main" ? [] : [{ number: 7 }],
  },
});

const push = (branch) => ({
  ...base,
  ref: `refs/heads/${branch}`,
  before: "0000000aaaaaaa",
  after: "1a2b3c4d5e6f",
  forced: false,
  commits: [{}],
  head_commit: { message: "Fix cart total", author: { username: "alice" } },
  compare:
    "https://github.com/ronitrai27/Testing_SRE_Demo_App/compare/0000000...1a2b3c4",
});

const SCENARIOS = {
  "push-main": ["push", push("main")],
  ping: [
    "ping",
    {
      ...base,
      zen: "Keep it logically awesome.",
      hook: { events: ["pull_request", "workflow_run"] },
    },
  ],
  "pr-to-main": ["pull_request", pr("opened", "feature/coupons", "main")],
  "pr-to-feature": [
    "pull_request",
    pr("opened", "fix/typo", "feature/coupons"),
  ],
  "pr-draft": [
    "pull_request",
    pr("opened", "feature/coupons", "main", { draft: true }),
  ],
  "pr-own-branch": ["pull_request", pr("opened", "awd/run-1-1", "main")],
  "ci-failed": ["workflow_run", run("failure", "feature/coupons")],
  "ci-passed": ["workflow_run", run("success", "feature/coupons")],
  "ci-own-branch": ["workflow_run", run("failure", "awd/run-1-1")],
};

async function send(name, secretOverride) {
  const [event, payload] = SCENARIOS[name];
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac(
    "sha256",
    secretOverride ?? need("GITHUB_APP_WEBHOOK_SECRET"),
  )
    .update(body)
    .digest("hex")}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": signature,
    },
    body,
  });
  console.log(`${name.padEnd(14)} -> ${res.status} ${await res.text()}`);
}

const which = process.argv[2];
if (which === "bad-signature") await send("ping", "not-the-secret");
else if (which === "all") {
  for (const name of Object.keys(SCENARIOS)) await send(name);
  await send("ping", "not-the-secret");
} else if (SCENARIOS[which]) await send(which);
else {
  console.error(
    `Pick one of: all, bad-signature, ${Object.keys(SCENARIOS).join(", ")}`,
  );
  process.exit(1);
}
