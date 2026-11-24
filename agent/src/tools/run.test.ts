import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { defineTool } from "./define";
import { fakeContext } from "./fakes";
import { MAX_RESULT_CHARS, modelText, runTool } from "./run";
import { ToolError } from "./types";

const make = (
  run: Parameters<typeof defineTool>[0]["run"],
  overrides: Record<string, unknown> = {},
) =>
  defineTool({
    name: "demo_echo",
    group: "demo",
    description: "Echoes the text it was given, for tests of the tool runner.",
    input: z.object({ text: z.string() }),
    risk: "read",
    timeoutMs: 200,
    title: (input: { text: string }) => `Echo ${input.text}`,
    run,
    ...overrides,
  } as never);

test("runs a tool and returns its output, summary and duration", async () => {
  const tool = make(
    async (input) => ({ echoed: (input as { text: string }).text }),
    { summarize: (o: { echoed: string }) => `said ${o.echoed}` },
  );
  const outcome = await runTool(tool, { text: "hi" }, fakeContext());
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.deepEqual(outcome.output, { echoed: "hi" });
    assert.equal(outcome.summary, "said hi");
    assert.ok(outcome.durationMs >= 0);
  }
});

test("wrong arguments are explained so the model can fix them", async () => {
  const tool = make(async () => "never runs");
  for (const bad of [{}, { text: 5 }, "nope", null]) {
    const outcome = await runTool(tool, bad, fakeContext());
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.error.kind, "invalid_input");
      assert.match(outcome.error.message, /demo_echo/);
      assert.match(outcome.error.hint ?? "", /schema/);
    }
  }
  const outcome = await runTool(tool, {}, fakeContext());
  if (!outcome.ok) assert.match(outcome.error.message, /'text'/);
});

test("a tool that takes too long is cut off, and says so", async () => {
  const tool = make(() => new Promise(() => {}), { timeoutMs: 40 }); // never answers, ignores the signal
  const started = Date.now();
  const outcome = await runTool(tool, { text: "x" }, fakeContext());
  assert.ok(
    Date.now() - started < 1000,
    "must not wait for a tool that ignores the abort signal",
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.kind, "timeout");
    assert.match(outcome.error.message, /demo_echo took longer than/);
    assert.equal(outcome.error.retryable, true);
  }
});

test("a tool that respects the abort signal is told to stop", async () => {
  let sawAbort = false;
  const tool = make(
    (_input, ctx) =>
      new Promise((_, reject) => {
        ctx.signal.addEventListener("abort", () => {
          sawAbort = true;
          reject(new Error("aborted by signal"));
        });
      }),
    { timeoutMs: 30 },
  );
  const outcome = await runTool(tool, { text: "x" }, fakeContext());
  assert.ok(sawAbort);
  assert.equal(outcome.ok === false && outcome.error.kind, "timeout");
});

test("pressing stop ends the call as 'aborted'", async () => {
  const controller = new AbortController();
  const tool = make(() => new Promise(() => {}), { timeoutMs: 5000 });
  const pending = runTool(
    tool,
    { text: "x" },
    fakeContext({ signal: controller.signal }),
  );
  setTimeout(() => controller.abort(), 20);
  const outcome = await pending;
  assert.equal(outcome.ok === false && outcome.error.kind, "aborted");

  const before = await runTool(
    tool,
    { text: "x" },
    fakeContext({ signal: AbortSignal.abort() }),
  );
  assert.equal(before.ok === false && before.error.kind, "aborted");
});

test("a ToolError keeps its kind, cause and hint", async () => {
  const tool = make(async () => {
    throw new ToolError("forbidden", "No access to the repo", {
      hint: "Install the app",
      cause: new Error("HTTP 403: Resource not accessible"),
    });
  });
  const outcome = await runTool(tool, { text: "x" }, fakeContext());
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.kind, "forbidden");
    assert.equal(outcome.error.hint, "Install the app");
    assert.equal(outcome.error.cause, "HTTP 403: Resource not accessible");
    assert.equal(outcome.error.retryable, false);
  }
});

test("an unexpected crash becomes a plain 'failed' error", async () => {
  const tool = make(async () => {
    throw new TypeError("Cannot read properties of undefined (reading 'x')");
  });
  const outcome = await runTool(tool, { text: "x" }, fakeContext());
  assert.equal(outcome.ok === false && outcome.error.kind, "failed");
  if (!outcome.ok)
    assert.match(outcome.error.message, /crashed: Cannot read properties/);
});

test("secrets never leave a tool: not in output, not in errors", async () => {
  const key = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
  const ok = await runTool(
    make(async () => ({ leaked: `token ${key}` })),
    { text: "x" },
    fakeContext(),
  );
  assert.ok(!JSON.stringify(ok).includes("sk-proj-"));
  const bad = await runTool(
    make(async () => {
      throw new ToolError("failed", `failed with ${key}`, {
        cause: new Error(`inner ${key}`),
      });
    }),
    { text: "x" },
    fakeContext(),
  );
  assert.ok(!JSON.stringify(bad).includes("sk-proj-"));
});

test("a summary function that throws does not break the call", async () => {
  const tool = make(async () => ({ a: 1 }), {
    summarize: () => {
      throw new Error("bug in summarize");
    },
  });
  const outcome = await runTool(tool, { text: "x" }, fakeContext());
  assert.equal(outcome.ok && outcome.summary, "");
});

test("what the model reads: JSON for results, plain lines for errors, long results cut", async () => {
  const ok = await runTool(
    make(async () => ({ a: 1 })),
    { text: "x" },
    fakeContext(),
  );
  assert.equal(modelText(ok), '{"a":1}');

  const long = await runTool(
    make(async () => ({ big: "x".repeat(MAX_RESULT_CHARS * 2) })),
    { text: "x" },
    fakeContext(),
  );
  const text = modelText(long);
  assert.ok(text.length < MAX_RESULT_CHARS + 200);
  assert.match(text, /result cut: \d+ characters/);

  const err = await runTool(
    make(async () => {
      throw new ToolError("unavailable", "Docker is not running", {
        hint: "Start Docker Desktop",
        cause: "pipe not found",
      });
    }),
    { text: "x" },
    fakeContext(),
  );
  assert.equal(
    modelText(err),
    "Error (unavailable): Docker is not running\nCause: pipe not found\nHint: Start Docker Desktop",
  );
});

// --- definitions and the registry

test("a tool definition is checked when it is written", () => {
  const base = {
    group: "demo",
    description: "A description that is long enough.",
    input: z.object({}),
    risk: "read" as const,
    timeoutMs: 1000,
    title: () => "t",
    run: async () => null,
  };
  assert.throws(() => defineTool({ ...base, name: "Demo-Echo" }), /group_verb/);
  assert.throws(() => defineTool({ ...base, name: "echo" }), /group_verb/);
  assert.throws(
    () => defineTool({ ...base, name: "other_echo" }),
    /must start with its group/,
  );
  assert.throws(
    () => defineTool({ ...base, name: "demo_echo", description: "short" }),
    /real description/,
  );
  assert.throws(
    () => defineTool({ ...base, name: "demo_echo", timeoutMs: 0 }),
    /timeout/,
  );
  assert.throws(
    () => defineTool({ ...base, name: "demo_echo", timeoutMs: 11 * 60_000 }),
    /timeout/,
  );
  assert.doesNotThrow(() => defineTool({ ...base, name: "demo_echo" }));
});
