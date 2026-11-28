import assert from "node:assert/strict";
import { test } from "node:test";
import { detectProject } from "./detect";
import {
  defaultPackageJson,
  fakeContext,
  fakeGithub,
  fakeStore,
  githubSetup,
} from "./fakes";
import { langchainTools, modelText, roxTools, runTool } from "./index";
import { ToolError } from "./types";

const call = (name: string, input: unknown, ctx = fakeContext()) => {
  const def = roxTools.find((t) => t.name === name);
  assert.ok(def, `tool ${name} exists`);
  return runTool(def, input, ctx);
};

// --- project detection (pure)

test("detects a pnpm Next.js TypeScript project", () => {
  const d = detectProject({
    rootNames: [
      "package.json",
      "pnpm-lock.yaml",
      "tsconfig.json",
      "Dockerfile",
      ".github",
    ],
    packageJson: defaultPackageJson,
    workflows: ["ci.yml"],
  });
  assert.deepEqual(d.languages, ["TypeScript"]);
  assert.equal(d.packageManager, "pnpm");
  assert.equal(d.framework, "Next.js");
  assert.equal(d.commands.install, "pnpm install --frozen-lockfile");
  assert.equal(d.commands.build, "pnpm run build");
  assert.equal(d.commands.test, "pnpm run test");
  assert.equal(d.commands.start, "pnpm run dev");
  assert.equal(d.hasTests, true);
  assert.equal(d.docker.dockerfile, true);
  assert.equal(d.ci.provider, "GitHub Actions");
});

test("the default npm test stub does not count as tests", () => {
  const d = detectProject({
    rootNames: ["package.json", "package-lock.json"],
    packageJson: JSON.stringify({
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
    }),
    workflows: [],
  });
  assert.equal(d.commands.test, null);
  assert.equal(d.hasTests, false);
  assert.equal(d.packageManager, "npm");
  assert.ok(d.notes.some((n) => /No tests/.test(n)));
});

test("no lockfile is reported, and the declared package manager is used", () => {
  const none = detectProject({
    rootNames: ["package.json"],
    packageJson: "{}",
    workflows: [],
  });
  assert.equal(none.packageManager, null);
  assert.ok(none.notes.some((n) => /lockfile/.test(n)));
  const declared = detectProject({
    rootNames: ["package.json"],
    packageJson: JSON.stringify({ packageManager: "yarn@4.1.0" }),
    workflows: [],
  });
  assert.equal(declared.packageManager, "yarn");
});

test("broken package.json is noted, not fatal", () => {
  const d = detectProject({
    rootNames: ["package.json"],
    packageJson: "{nope",
    workflows: [],
  });
  assert.ok(d.notes.some((n) => /could not be read/.test(n)));
  assert.deepEqual(d.languages, ["JavaScript"]);
});

test("detects Python and Go projects and an empty repo", () => {
  const py = detectProject({
    rootNames: ["requirements.txt", "tests"],
    packageJson: null,
    workflows: [],
  });
  assert.deepEqual(py.languages, ["Python"]);
  assert.equal(py.commands.test, "pytest");
  const go = detectProject({
    rootNames: ["go.mod"],
    packageJson: null,
    workflows: [],
  });
  assert.equal(go.commands.build, "go build ./...");
  const empty = detectProject({
    rootNames: ["README.md"],
    packageJson: null,
    workflows: [],
  });
  assert.deepEqual(empty.languages, []);
  assert.equal(empty.hasTests, false);
});

// --- all tools

test("every tool has a unique valid name, a timeout and a group", () => {
  assert.ok(roxTools.length >= 6);
  assert.equal(new Set(roxTools.map((t) => t.name)).size, roxTools.length);
  assert.deepEqual(
    langchainTools.map((t) => t.name),
    roxTools.map((t) => t.name),
  );
  for (const def of roxTools) {
    assert.match(def.name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.ok(def.timeoutMs <= 60_000, def.name);
  }
  assert.deepEqual([...new Set(roxTools.map((t) => t.group))].sort(), [
    "connections",
    "plan",
    "repo",
    "runs",
    "setup",
  ]);
});

// --- setup_overview

test("setup_overview reports choices and never a key", async () => {
  const out = await call("setup_overview", {});
  assert.equal(out.ok, true);
  if (out.ok) {
    const o = out.output as Record<string, unknown>;
    assert.equal(o.repository, "acme/shop");
    assert.equal(o.mode, "github");
    assert.equal(o.setupComplete, true);
    assert.equal(o.sandbox, "docker");
    assert.deepEqual(o.modelProvidersWithSavedKey, ["OpenAI", "Google Gemini"]);
    assert.ok(!JSON.stringify(o).match(/sk-|AIza/));
  }
});

test("setup_overview explains when the setup guide is not finished", async () => {
  const out = await call(
    "setup_overview",
    {},
    fakeContext({ store: fakeStore({ setup: null }) }),
  );
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.error.kind, "not_found");
    assert.match(out.error.hint ?? "", /setup guide/);
  }
});

test("connections_list: triggers on, what they do, and whether they can fire", async () => {
  const out = await call("connections_list", {});
  assert.equal(out.ok, true);
  if (out.ok) {
    const o = out.output as {
      triggers: {
        app: string;
        on: { id: string; does: string }[];
        canFire: boolean;
        note?: string;
      }[];
      triggersOn: number;
    };
    assert.equal(o.triggersOn, 2);
    const github = o.triggers.find((t) => t.app === "GitHub");
    assert.deepEqual(
      github?.on.map((t) => t.id),
      ["github:pr_main"],
    );
    assert.equal(github?.canFire, true);
    // Sentry's trigger is on, but Sentry is not connected in this setup.
    const sentry = o.triggers.find((t) => t.app === "Sentry");
    assert.equal(sentry?.canFire, false);
    assert.match(sentry?.note ?? "", /not connected/);
    assert.match(out.summary, /2 triggers on/);
  }
});

// --- runs

test("runs_query: failed finds a run that succeeded but gave up, and the window is always counted", async () => {
  const failed = await call("runs_query", { result: ["failed"] });
  assert.equal(failed.ok, true);
  if (failed.ok) {
    const o = failed.output as {
      matching: number;
      windowTotals: { runs: number; failed: number; ofWhichGaveUp: number };
      runs: { runId: string; result: string; status: string }[];
    };
    assert.equal(o.matching, 1);
    assert.equal(o.runs[0]?.runId, "run-gave-up");
    assert.equal(o.runs[0]?.status, "succeeded");
    assert.equal(o.runs[0]?.result, "gave_up");
    // The filter does not shrink the counts: all 3 runs of the window are there.
    assert.equal(o.windowTotals.runs, 3);
    assert.equal(o.windowTotals.failed, 1);
    assert.equal(o.windowTotals.ofWhichGaveUp, 1);
    assert.equal(
      (o.windowTotals as { pullRequestsMerged?: number }).pullRequestsMerged,
      1,
    );
    assert.match(failed.summary, /1 matching of 3 runs, 1 live, 1 failed/);
  }
});

test("runs_query lists live runs, and says what else ran when nothing matches", async () => {
  const live = await call("runs_query", { result: ["live"] });
  assert.equal(live.ok, true);
  if (live.ok) {
    const o = live.output as {
      matching: number;
      runs: { runId: string; live: boolean; startedBy: string }[];
    };
    assert.equal(o.matching, 1);
    assert.equal(o.runs[0]?.runId, "run-live");
    assert.equal(o.runs[0]?.live, true);
    assert.match(o.runs[0]?.startedBy ?? "", /GitHub · PR opened against main/);
  }
  const none = await call("runs_query", { result: ["nothing_to_fix"] });
  if (none.ok)
    assert.match(
      (none.output as { note: string }).note,
      /the window has 3 runs/,
    );
  const fixed = await call("runs_query", {
    result: ["pr_opened"],
    since: "all",
  });
  if (fixed.ok)
    assert.equal(
      (fixed.output as { runs: { pullRequestOpened: string }[] }).runs[0]
        ?.pullRequestOpened,
      "https://github.com/acme/shop/pull/14",
    );
  const bad = await call("runs_query", { since: "last tuesday" });
  assert.equal(bad.ok === false && bad.error.kind, "invalid_input");
});

test("runs_get reads the live run with its steps, and only new steps after a seq", async () => {
  const out = await call("runs_get", { run: "live" });
  assert.equal(out.ok, true);
  if (out.ok) {
    const o = out.output as {
      run: { runId: string };
      steps: { seq: number }[];
    };
    assert.equal(o.run.runId, "run-live");
    assert.deepEqual(
      o.steps.map((s) => s.seq),
      [1, 2, 3, 4],
    );
  }
  const later = await call("runs_get", { run: "run-live", afterSeq: 3 });
  if (later.ok)
    assert.deepEqual(
      (later.output as { steps: { seq: number }[] }).steps.map((s) => s.seq),
      [4],
    );
});

test("runs_get says plainly when nothing is running or the id is unknown", async () => {
  const idle = await call(
    "runs_get",
    { run: "live" },
    fakeContext({ store: fakeStore({ runs: [] }) }),
  );
  assert.equal(idle.ok === false && idle.error.kind, "not_found");
  if (!idle.ok) assert.match(idle.error.message, /No run is going on/);
  const unknown = await call("runs_get", { run: "nope" });
  assert.equal(unknown.ok === false && unknown.error.kind, "not_found");
});

// --- connections_list

test("connections_list: GitHub connected, Slack connectable, the rest not built", async () => {
  const out = await call("connections_list", {});
  assert.equal(out.ok, true);
  if (out.ok) {
    const list = (
      out.output as {
        connections: {
          id: string;
          status: string;
          canBeConnectedNow: boolean;
        }[];
      }
    ).connections;
    assert.equal(list.find((c) => c.id === "github")?.status, "connected");
    const slack = list.find((c) => c.id === "slack");
    assert.equal(slack?.status, "not_connected");
    assert.equal(slack?.canBeConnectedNow, true);
    assert.equal(list.find((c) => c.id === "sentry")?.status, "not_connected");
    // Only what the database knows: no app is listed from a hardcoded list.
    assert.deepEqual(
      list.map((c) => c.id),
      ["github", "slack", "sentry"],
    );
    assert.match(out.summary, /1 of 3 connected/);
  }
});

test("connections_list: a saved Slack connection without a bot token is an error, said plainly", async () => {
  const store = fakeStore();
  (store as unknown as Record<string, unknown>).getReportConnections =
    async () => ({
      connections: [
        {
          provider: "slack",
          workspace: "Acme",
          channelId: "C1",
          channelName: "alerts",
          connectedAt: new Date(),
        },
      ],
      reportTo: "slack",
    });
  const saved = process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
  try {
    const out = await call("connections_list", {}, fakeContext({ store }));
    assert.equal(out.ok, true);
    if (out.ok) {
      const slack = (
        out.output as {
          connections: { id: string; status: string; detail: string }[];
        }
      ).connections.find((c) => c.id === "slack");
      assert.equal(slack?.status, "error");
      assert.match(slack?.detail ?? "", /SLACK_BOT_TOKEN/);
    }
  } finally {
    if (saved !== undefined) process.env.SLACK_BOT_TOKEN = saved;
  }
});

test("connections_list: a Sentry project saved in the setup is connected", async () => {
  const ctx = fakeContext({
    store: fakeStore({
      setup: {
        ...githubSetup,
        sentry: { org: "acme", project: "web", connectedAt: new Date() },
        triggers: ["sentry:new_issue"],
      },
    }),
  });
  const out = await call("connections_list", {}, ctx);
  assert.equal(out.ok, true);
  if (out.ok) {
    const sentry = (
      out.output as {
        connections: { id: string; status: string; detail: string }[];
      }
    ).connections.find((c) => c.id === "sentry");
    assert.equal(sentry?.status, "connected");
    assert.match(sentry?.detail ?? "", /web in acme.*new_issue/);
  }
});

// --- plan_update

test("plan_update emits the list and counts statuses", async () => {
  const emitted: { type: string; data: Record<string, unknown> }[] = [];
  const out = await call(
    "plan_update",
    {
      kind: "plan",
      title: "Check PR 12",
      items: [
        { text: "Read repo", status: "done" },
        { text: "Check sandbox", status: "doing" },
        { text: "Report", status: "todo" },
      ],
    },
    fakeContext({ emitted }),
  );
  assert.equal(out.ok, true);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]?.type, "plan.updated");
  assert.equal(emitted[0]?.data.kind, "plan");
  assert.equal(emitted[0]?.data.title, "Check PR 12");
  if (out.ok) assert.match(out.summary, /1 done · 1 doing · 1 to do/);
});

test("plan_update rejects an empty or oversized list", async () => {
  const base = { kind: "queue", title: "Asks" };
  assert.equal((await call("plan_update", { ...base, items: [] })).ok, false);
  const many = Array.from({ length: 13 }, (_, i) => ({
    text: `s${i}`,
    status: "todo",
  }));
  assert.equal((await call("plan_update", { ...base, items: many })).ok, false);
  assert.equal(
    (
      await call("plan_update", {
        ...base,
        items: [{ text: "x", status: "paused" }],
      })
    ).ok,
    false,
  );
});

// --- repo tools

test("repo_info gathers repo, PRs with checks, commits, language share and Rox activity", async () => {
  const github = fakeGithub({
    checks: { sha13: { state: "failing", total: 2, failing: ["lint"] } },
  });
  const out = await call("repo_info", {}, fakeContext({ github }));
  assert.equal(out.ok, true);
  if (out.ok) {
    const o = out.output as {
      repository: string;
      languages: { name: string; percent: number }[];
      openPullRequests: { number: number; checks: { state: string } | null }[];
      warnings: string[];
    };
    assert.equal(o.repository, "acme/shop");
    assert.deepEqual(o.languages[0], { name: "TypeScript", percent: 80 });
    assert.equal(o.openPullRequests.length, 2);
    assert.equal(o.openPullRequests[1]?.checks?.state, "failing");
    assert.deepEqual(o.warnings, []);
    const activity = (
      out.output as {
        activity: { roxPullRequests: { opened: number; merged: number } };
      }
    ).activity;
    assert.equal(activity.roxPullRequests.merged, 1);
    assert.match(
      out.summary,
      /acme\/shop · 2 open PRs · checks passing · Rox \d+ PRs, 1 merged/,
    );
  }
});

test("repo_overview keeps going when one GitHub call fails, and says which", async () => {
  const github = fakeGithub({
    fail: {
      listOpenPulls: new ToolError("rate_limited", "GitHub rate limit reached"),
    },
  });
  const out = await call("repo_info", {}, fakeContext({ github }));
  assert.equal(out.ok, true);
  if (out.ok) {
    const o = out.output as { warnings: string[]; openPullRequests: unknown[] };
    assert.equal(o.openPullRequests.length, 0);
    assert.match(
      o.warnings.join(" "),
      /Pull requests: GitHub rate limit reached/,
    );
  }
});

test("repo_overview fails clearly when the repo itself cannot be read", async () => {
  const github = fakeGithub({
    fail: {
      getRepo: new ToolError("forbidden", "Rox cannot read acme/shop", {
        hint: "Reinstall the app",
      }),
    },
  });
  const out = await call("repo_info", {}, fakeContext({ github }));
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.error.kind, "forbidden");
    assert.equal(out.error.hint, "Reinstall the app");
  }
});

test("GitHub tools explain why they cannot run", async () => {
  const noInstall = fakeContext({
    store: fakeStore({ setup: { ...githubSetup, installationId: null } }),
  });
  const a = await call("repo_info", {}, noInstall);
  assert.equal(a.ok === false && a.error.kind, "unavailable");

  const noClient = fakeContext({ github: null });
  const b = await call("repo_info", {}, noClient);
  assert.equal(b.ok === false && b.error.kind, "unavailable");
  if (!b.ok) assert.match(b.error.hint ?? "", /GITHUB_APP_ID/);

  const demo = fakeContext({ store: fakeStore({ user: { isDemo: true } }) });
  const c = await call("repo_info", {}, demo);
  assert.equal(c.ok === false && c.error.kind, "unavailable");
  if (!c.ok) assert.match(c.error.message, /Quick Judge/);

  const noRepo = fakeContext({
    store: fakeStore({ setup: { ...githubSetup, repo: null } }),
  });
  const d = await call("repo_info", {}, noRepo);
  assert.equal(d.ok === false && d.error.kind, "not_found");
});

test("every tool result is plain JSON the model can read", async () => {
  for (const name of [
    "setup_overview",
    "connections_list",
    "repo_info",
    "runs_query",
    "runs_get",
  ]) {
    const out = await call(
      name,
      name === "runs_get" ? { run: "latest" } : {},
      fakeContext({
        github: fakeGithub({ files: { "package.json": defaultPackageJson } }),
      }),
    );
    assert.equal(out.ok, true, name);
    assert.doesNotThrow(() => JSON.parse(modelText(out)), name);
  }
});
