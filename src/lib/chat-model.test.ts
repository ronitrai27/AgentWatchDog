import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTurns,
  type ChatAction,
  type ChatState,
  chatReducer,
  connectionsFrom,
  formatDuration,
  initialChat,
  isRunning,
  type WireEvent,
} from "./chat-model";

let seq = 0;
const ev = (
  type: string,
  data: Record<string, unknown> = {},
  turnId = "t1",
  durationMs: number | null = null,
): ChatAction => ({
  type: "event",
  event: {
    seq: ++seq,
    id: `e${seq}`,
    occurredAt: "2026-11-24T10:00:00.000Z",
    turnId,
    type,
    data,
    durationMs,
  } satisfies WireEvent,
});
const run = (actions: ChatAction[], from: ChatState = initialChat) =>
  actions.reduce(chatReducer, from);

test("a user message and an answer become one turn", () => {
  const state = run([
    ev("user.message", { text: "hi" }),
    ev("assistant.message", { text: "hello" }),
  ]);
  const [turn] = buildTurns(state);
  assert.equal(turn?.user?.text, "hi");
  assert.deepEqual(
    turn?.blocks.map((b) => b.kind),
    ["text"],
  );
  assert.equal(turn?.status, "completed");
});

test("thinking, steps and plan appear in the order they happened", () => {
  const state = run([
    ev("user.message", { text: "look" }),
    ev("model.thinking", { text: "I should check." }, "t1", 4200),
    ev("plan.updated", { items: [{ text: "A", status: "doing" }] }),
    ev("tool.requested", {
      callId: "a",
      name: "setup_get",
      title: "Read the saved setup",
    }),
    ev("tool.requested", {
      callId: "b",
      name: "repo_overview",
      title: "Read the repository overview",
    }),
    ev(
      "tool.completed",
      {
        callId: "a",
        name: "setup_get",
        ok: true,
        summary: "acme/shop",
        output: "{}",
      },
      "t1",
      12,
    ),
    ev("tool.completed", {
      callId: "b",
      name: "repo_overview",
      ok: false,
      summary: "no",
      output: "Error (forbidden): no",
      error: { kind: "forbidden", message: "no", hint: "Reinstall" },
    }),
    ev("plan.updated", { items: [{ text: "A", status: "done" }] }),
    ev("assistant.message", { text: "Done." }),
  ]);
  const [turn] = buildTurns(state);
  assert.deepEqual(
    turn?.blocks.map((b) => b.kind),
    ["thinking", "plan", "steps", "text"],
  );
  const steps = turn?.blocks.find((b) => b.kind === "steps");
  assert.ok(steps && steps.kind === "steps");
  assert.deepEqual(
    steps.steps.map((s) => s.status),
    ["done", "error"],
  );
  assert.equal(steps.steps[1]?.error?.hint, "Reinstall");
  const plan = turn?.blocks.find((b) => b.kind === "plan");
  assert.deepEqual(plan && plan.kind === "plan" && plan.items, [
    { text: "A", status: "done" },
  ]); // updated in place
});

test("tool steps from separate model calls are separate groups", () => {
  const state = run([
    ev("user.message", { text: "x" }),
    ev("tool.requested", { callId: "a", name: "setup_get" }),
    ev("tool.completed", { callId: "a", ok: true }),
    ev("assistant.message", { text: "between" }),
    ev("tool.requested", { callId: "b", name: "sandbox_check" }),
  ]);
  const [turn] = buildTurns(state);
  assert.deepEqual(
    turn?.blocks.map((b) => b.kind),
    ["steps", "text", "steps"],
  );
  const last = turn?.blocks[2];
  assert.equal(last?.kind === "steps" && last.steps[0]?.status, "running");
});

test("live words show while streaming and vanish when the log has them", () => {
  let state = run([
    ev("user.message", { text: "x" }),
    { type: "delta", turnId: "t1", channel: "thinking", text: "Thin" },
    { type: "delta", turnId: "t1", channel: "thinking", text: "king" },
    { type: "delta", turnId: "t1", channel: "text", text: "Hel" },
  ]);
  let turn = buildTurns(state)[0];
  assert.deepEqual(
    turn?.blocks.map((b) => b.kind),
    ["thinking", "text"],
  );
  assert.equal(
    turn?.blocks[0]?.kind === "thinking" && turn.blocks[0].text,
    "Thinking",
  );
  assert.ok(
    turn?.blocks.every(
      (b) => (b.kind === "text" || b.kind === "thinking") && b.live,
    ),
  );
  assert.equal(turn?.status, "running");

  state = run(
    [
      ev("model.thinking", { text: "Thinking" }),
      ev("assistant.message", { text: "Hello" }),
    ],
    state,
  );
  turn = buildTurns(state)[0];
  assert.deepEqual(
    turn?.blocks.map((b) =>
      b.kind === "text" || b.kind === "thinking" ? b.live : null,
    ),
    [false, false],
  );
  assert.equal(turn?.blocks.filter((b) => b.kind === "text").length, 1);
});

test("errors fail the turn, stop marks it stopped, a finished turn is no longer running", () => {
  let state = run([
    ev("user.message", { text: "x" }),
    ev("agent.error", {
      message: "Key rejected",
      hint: "Check it",
      kind: "auth",
    }),
  ]);
  let turn = buildTurns(state)[0];
  assert.equal(turn?.status, "failed");
  const error = turn?.blocks.find((b) => b.kind === "error");
  assert.deepEqual(
    error &&
      error.kind === "error" && [error.message, error.hint, error.errorKind],
    ["Key rejected", "Check it", "auth"],
  );

  state = run(
    [ev("user.message", { text: "y" }, "t2"), ev("agent.stopped", {}, "t2")],
    state,
  );
  turn = buildTurns(state)[1];
  assert.equal(turn?.status, "stopped");

  state = run([{ type: "turn", turnId: "t2", status: "stopped" }], {
    ...state,
    runningTurnId: "t2",
  });
  assert.equal(isRunning(state), false);
});

test("a message just sent shows at once, and is replaced by the logged one", () => {
  let state = run([
    { type: "sent", text: "hello", at: "2026-11-24T10:00:00Z" },
  ]);
  let turns = buildTurns(state);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.user?.pending, true);
  assert.equal(isRunning(state), true);

  state = run([ev("user.message", { text: "hello" }, "t9")], state);
  turns = buildTurns(state);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.user?.pending, false);
});

test("the hidden greeting trigger has no person message", () => {
  const state = run([
    ev("system.trigger", { kind: "welcome", text: "secret prompt" }),
    ev("assistant.message", { text: "Welcome" }),
  ]);
  const [turn] = buildTurns(state);
  assert.equal(turn?.user, null);
  assert.ok(!JSON.stringify(turn).includes("secret prompt"));
});

test("an event already seen is ignored, so a reconnect does not double the chat", () => {
  const first = ev("user.message", { text: "x" });
  const state = run([first, first, ev("assistant.message", { text: "y" })]);
  assert.equal(state.events.length, 2);
});

test("ready marks the latest turn as running when the server says so", () => {
  const state = run([
    ev("user.message", { text: "x" }, "t5"),
    { type: "ready", running: true },
  ]);
  assert.equal(isRunning(state), true);
  assert.equal(buildTurns(state)[0]?.status, "running");
  assert.equal(
    isRunning(run([{ type: "ready", running: false }], state)),
    false,
  );
});

test("connections are read from the connections_list step", () => {
  const output = JSON.stringify({
    connections: [
      {
        id: "github",
        name: "GitHub",
        status: "connected",
        detail: "x",
        canBeConnectedNow: true,
      },
      {
        id: "sentry",
        name: "Sentry",
        status: "not_connected",
        detail: "y",
        gives: "g",
        canBeConnectedNow: false,
      },
    ],
  });
  const state = run([
    ev("tool.requested", { callId: "c", name: "connections_list" }),
    ev("tool.completed", {
      callId: "c",
      name: "connections_list",
      ok: true,
      output,
    }),
  ]);
  const list = connectionsFrom(buildTurns(state)[0] as never);
  assert.deepEqual(
    list?.map((c) => c.id),
    ["github", "sentry"],
  );
  assert.equal(
    connectionsFrom({
      key: "x",
      user: null,
      blocks: [],
      status: "completed",
      startedAt: null,
    }),
    null,
  );
});

test("durations are short and readable", () => {
  assert.equal(formatDuration(null), "");
  assert.equal(formatDuration(340), "340 ms");
  assert.equal(formatDuration(5200), "5s");
  assert.equal(formatDuration(65_000), "1m 05s");
});
