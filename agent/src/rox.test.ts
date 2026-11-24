import assert from "node:assert/strict";
import { test } from "node:test";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { ModelUnavailable } from "./graph/models";
import {
  type Responder,
  ScriptedChatModel,
  type ScriptStep,
} from "./graph/testing/scripted";
import {
  BusyError,
  type ChatMessage,
  createRox,
  NotFoundError,
  type Rox,
} from "./rox";
import { createStore } from "./store/sessions";
import { scratchForTests } from "./testdb";
import { fakeDocker, fakeGithub } from "./tools/fakes";

const scratch = scratchForTests("rox");

async function boot(t: Parameters<ReturnType<typeof scratchForTests>>[0]) {
  const s = scratch(t);
  if (!s) return null;
  const store = createStore(s.agentDb);
  const savers: PostgresSaver[] = [];
  t.after(async () => {
    for (const saver of savers) await saver.end();
  });
  const start = (script: ScriptStep[] | Responder | Error) => {
    const saver = PostgresSaver.fromConnString(s.agentUrl, {
      schema: "langgraph",
    });
    savers.push(saver);
    const model =
      script instanceof Error ? null : new ScriptedChatModel(script);
    const rox = createRox({
      store,
      github: fakeGithub() as never,
      docker: fakeDocker(),
      checkpointer: saver,
      models: async () => {
        if (!model) throw script;
        return model;
      },
    });
    return { rox, model };
  };
  const user = async () => {
    const id = await s.createUser(`u${Math.random().toString(36).slice(2, 8)}`);
    await s.owner.query(
      `INSERT INTO user_setup (user_id, repo, orchestrator_model, subagent_model, sandbox)
       VALUES ($1, 'acme/shop', 'gpt-6-luna', 'gemini-3.8-flash', 'docker')`,
      [id],
    );
    const chat = await store.createSession(id);
    return { id, chat: chat.id };
  };
  return { start, user, store };
}

/** Follows a chat until a turn ends. */
async function untilDone(rox: Rox, userId: string, chat: string, after = 0) {
  const stop = new AbortController();
  const seen: ChatMessage[] = [];
  for await (const m of rox.follow(userId, chat, after, stop.signal)) {
    seen.push(m);
    if (m.kind === "turn") break;
  }
  stop.abort();
  return seen;
}

const eventTypes = (seen: ChatMessage[]) =>
  seen.flatMap((m) => (m.kind === "event" ? [m.event.type] : []));

test("a chat is silent until the person writes: opening it runs nothing", async (t) => {
  const h = await boot(t);
  if (!h) return;
  const { rox, model } = h.start([{ text: "never" }]);
  const u = await h.user();
  const stop = new AbortController();
  for await (const m of rox.follow(u.id, u.chat, 0, stop.signal)) {
    assert.deepEqual(m, { kind: "ready", running: false, lastSeq: 0 });
    break;
  }
  stop.abort();
  assert.equal(model?.seen.length, 0);
  assert.equal((await h.store.listEvents(u.id, u.chat)).length, 0);
});

test("tool results arrive live, one by one, and the chat is named after the message", async (t) => {
  const h = await boot(t);
  if (!h) return;
  const { rox } = h.start([
    {
      toolCalls: [
        {
          name: "plan_update",
          args: { items: [{ text: "Look", status: "doing" }] },
        },
        { name: "setup_get" },
      ],
    },
    { text: "All set." },
  ]);
  const u = await h.user();
  const watching = untilDone(rox, u.id, u.chat);
  await rox.startTurn(u.id, u.chat, "how is my setup?");
  const seen = await watching;
  const types = eventTypes(seen);
  assert.equal(types.filter((x) => x === "tool.completed").length, 2);
  assert.ok(types.includes("plan.updated"));
  assert.ok(
    types.lastIndexOf("tool.completed") < types.indexOf("assistant.message"),
  );
  const seqs = seen.flatMap((m) => (m.kind === "event" ? [m.event.seq] : []));
  assert.deepEqual(
    seqs,
    [...new Set(seqs)].sort((a, b) => a - b),
  );
  assert.equal(
    (await h.store.getSession(u.id, u.chat))?.name,
    "how is my setup?",
  );
});

test("a second message while Rox works is refused; stop ends the turn", async (t) => {
  const h = await boot(t);
  if (!h) return;
  const { rox } = h.start([{ delayMs: 5000, text: "slow" }]);
  const u = await h.user();
  const watching = untilDone(rox, u.id, u.chat);
  await rox.startTurn(u.id, u.chat, "go");
  await assert.rejects(rox.startTurn(u.id, u.chat, "again"), BusyError);
  assert.equal(await rox.stop(u.id, u.chat), true);
  const last = (await watching).at(-1);
  assert.ok(last?.kind === "turn" && last.status === "stopped");
});

test("the model remembers the chat after a restart", async (t) => {
  const h = await boot(t);
  if (!h) return;
  const u = await h.user();
  const before = h.start([{ text: "First answer." }]);
  const first = untilDone(before.rox, u.id, u.chat);
  await before.rox.startTurn(u.id, u.chat, "first question");
  await first;

  const after = h.start([{ text: "Second answer." }]);
  const last = (await h.store.listEvents(u.id, u.chat)).at(-1)?.seq ?? 0;
  const second = untilDone(after.rox, u.id, u.chat, last);
  await after.rox.startTurn(u.id, u.chat, "second question");
  await second;
  assert.deepEqual(
    after.model?.seen[0]?.slice(1).map((m) => m.text),
    ["first question", "First answer.", "second question"],
  );
});

test("a missing key is explained in the chat, and the turn is closed as failed", async (t) => {
  const h = await boot(t);
  if (!h) return;
  const { rox } = h.start(
    new ModelUnavailable("No OpenAI key is saved.", "Add the key."),
  );
  const u = await h.user();
  const watching = untilDone(rox, u.id, u.chat);
  await rox.startTurn(u.id, u.chat, "hi");
  const seen = await watching;
  assert.deepEqual(eventTypes(seen), ["user.message", "agent.error"]);
  const last = seen.at(-1);
  assert.ok(last?.kind === "turn" && last.status === "failed");
});

test("a user cannot write to, stop or read another user's chat", async (t) => {
  const h = await boot(t);
  if (!h) return;
  const { rox } = h.start([{ text: "hi" }]);
  const mine = await h.user();
  const other = await h.user();
  await assert.rejects(
    rox.startTurn(other.id, mine.chat, "hello"),
    NotFoundError,
  );
  await assert.rejects(rox.stop(other.id, mine.chat), NotFoundError);
  await assert.rejects(async () => {
    const stop = new AbortController();
    for await (const _ of rox.follow(other.id, mine.chat, 0, stop.signal)) {
      stop.abort();
    }
  }, NotFoundError);
});
