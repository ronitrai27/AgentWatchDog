import assert from "node:assert/strict";
import { test } from "node:test";
import { detectProject } from "./detect";
import {
  defaultPackageJson,
  fakeContext,
  fakeDocker,
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
    "sandbox",
    "setup",
  ]);
});

// --- setup_get

test("setup_get reports choices and never a key", async () => {
  const out = await call("setup_get", {});
  assert.equal(out.ok, true);
  if (out.ok) {
    const o = out.output as Record<string, unknown>;
    assert.equal(o.repository, "acme/shop");
    assert.equal(o.mode, "github");
    assert.equal(o.setupComplete, true);
    assert.deepEqual(o.modelProvidersWithSavedKey, ["OpenAI", "Google Gemini"]);
    assert.ok(!JSON.stringify(o).match(/sk-|AIza/));
  }
});

test("setup_get explains when the setup guide is not finished", async () => {
  const out = await call(
    "setup_get",
    {},
    fakeContext({ store: fakeStore({ setup: null }) }),
  );
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.error.kind, "not_found");
    assert.match(out.error.hint ?? "", /setup guide/);
  }
});

// --- sandbox_check

test("sandbox_check reports Docker details", async () => {
  const out = await call("sandbox_check", {});
  assert.equal(out.ok, true);
  if (out.ok) {
    const o = out.output as Record<string, unknown>;
    assert.equal(o.ready, true);
    assert.equal(o.engineVersion, "28.0.4");
    assert.equal(o.memoryGiB, 8);
    assert.match(out.summary, /Docker 28\.0\.4/);
  }
});

test("sandbox_check says why Docker is not usable", async () => {
  const down = new ToolError("unavailable", "Docker is not running", {
    hint: "Start Docker Desktop",
    cause: "ENOENT docker_engine pipe",
  });
  const out = await call(
    "sandbox_check",
    {},
    fakeContext({ docker: fakeDocker(down) }),
  );
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.error.kind, "unavailable");
    assert.match(
      modelText(out),
      /Docker is not running[\s\S]*Cause: ENOENT[\s\S]*Hint: Start Docker Desktop/,
    );
  }
  const other = await call(
    "sandbox_check",
    {},
    fakeContext({
      store: fakeStore({ setup: { ...githubSetup, sandbox: "cloud" } }),
    }),
  );
  assert.equal(other.ok, true);
  if (other.ok) assert.equal((other.output as { ready: boolean }).ready, false);
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
  if (out.ok) assert.match(out.summary, /1 done · 1 doing · 1 to do/);
});

test("plan_update rejects an empty or oversized list", async () => {
  assert.equal((await call("plan_update", { items: [] })).ok, false);
  const many = Array.from({ length: 13 }, (_, i) => ({
    text: `s${i}`,
    status: "todo",
  }));
  assert.equal((await call("plan_update", { items: many })).ok, false);
  assert.equal(
    (await call("plan_update", { items: [{ text: "x", status: "paused" }] }))
      .ok,
    false,
  );
});

// --- repo tools

test("repo_overview gathers repo, PRs with checks, commits and language share", async () => {
  const github = fakeGithub({
    checks: { sha13: { state: "failing", total: 2, failing: ["lint"] } },
  });
  const out = await call("repo_overview", {}, fakeContext({ github }));
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
    assert.match(out.summary, /acme\/shop · 2 open PRs · checks passing/);
  }
});

test("repo_overview keeps going when one GitHub call fails, and says which", async () => {
  const github = fakeGithub({
    fail: {
      listOpenPulls: new ToolError("rate_limited", "GitHub rate limit reached"),
    },
  });
  const out = await call("repo_overview", {}, fakeContext({ github }));
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
  const out = await call("repo_overview", {}, fakeContext({ github }));
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
  const a = await call("repo_overview", {}, noInstall);
  assert.equal(a.ok === false && a.error.kind, "unavailable");

  const noClient = fakeContext({ github: null });
  const b = await call("repo_overview", {}, noClient);
  assert.equal(b.ok === false && b.error.kind, "unavailable");
  if (!b.ok) assert.match(b.error.hint ?? "", /GITHUB_APP_ID/);

  const demo = fakeContext({ store: fakeStore({ user: { isDemo: true } }) });
  const c = await call("repo_detect_project", {}, demo);
  assert.equal(c.ok === false && c.error.kind, "unavailable");
  if (!c.ok) assert.match(c.error.message, /Quick Judge/);

  const noRepo = fakeContext({
    store: fakeStore({ setup: { ...githubSetup, repo: null } }),
  });
  const d = await call("repo_overview", {}, noRepo);
  assert.equal(d.ok === false && d.error.kind, "not_found");
});

test("repo_detect_project reads package.json and the workflow folder", async () => {
  const github = fakeGithub({
    files: { "package.json": defaultPackageJson },
    dirs: {
      ".github/workflows": [
        { name: "ci.yml", type: "file", size: 10 },
        { name: "README.md", type: "file", size: 10 },
      ],
    },
  });
  const out = await call("repo_detect_project", {}, fakeContext({ github }));
  assert.equal(out.ok, true);
  if (out.ok) {
    const o = out.output as {
      framework: string;
      ci: { workflows: string[] };
      commands: { test: string };
    };
    assert.equal(o.framework, "Next.js");
    assert.deepEqual(o.ci.workflows, ["ci.yml"]);
    assert.equal(o.commands.test, "pnpm run test");
    assert.match(out.summary, /TypeScript · Next\.js · pnpm · has tests/);
  }
});

test("repo_detect_project: empty repo and a failed file read", async () => {
  const empty = await call(
    "repo_detect_project",
    {},
    fakeContext({ github: fakeGithub({ rootDir: null }) }),
  );
  assert.equal(empty.ok === false && empty.error.kind, "not_found");

  const github = fakeGithub({
    fail: { getFile: new ToolError("unavailable", "GitHub is down") },
  });
  const out = await call("repo_detect_project", {}, fakeContext({ github }));
  assert.equal(out.ok, true);
  if (out.ok)
    assert.match(
      (out.output as { warnings: string[] }).warnings.join(" "),
      /package\.json: GitHub is down/,
    );
});

test("every tool result is plain JSON the model can read", async () => {
  for (const name of [
    "setup_get",
    "sandbox_check",
    "connections_list",
    "repo_overview",
    "repo_detect_project",
  ]) {
    const out = await call(
      name,
      {},
      fakeContext({
        github: fakeGithub({ files: { "package.json": defaultPackageJson } }),
      }),
    );
    assert.equal(out.ok, true, name);
    assert.doesNotThrow(() => JSON.parse(modelText(out)), name);
  }
});
