import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { encryptSecret } from "../../../src/lib/vault";
import { scratchForTests } from "../testdb";
import { decryptSecret } from "../vault";
import { createStore, NotFoundError } from "./sessions";

const scratch = scratchForTests("store");

const keyHex = randomBytes(32).toString("hex");
process.env.ENCRYPTION_KEY = keyHex;

test("creates, finds and renames a chat", async (t) => {
  const s = scratch(t);
  if (!s) return;
  const store = createStore(s.agentDb);
  const alice = await s.createUser("alice");
  const chat = await store.createSession(alice, "Welcome");
  assert.equal(chat.name, "Welcome");
  assert.equal(chat.eventCount, 0);
  await store.renameSession(alice, chat.id, "Setup check");
  assert.equal((await store.getSession(alice, chat.id))?.name, "Setup check");
});

test("events get numbers, secrets are removed, and reading can resume", async (t) => {
  const s = scratch(t);
  if (!s) return;
  const store = createStore(s.agentDb);
  const alice = await s.createUser("alice2");
  const chat = await store.createSession(alice);
  const first = await store.appendEvent(alice, chat.id, {
    type: "user.message",
    data: { text: "my key is sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" },
  });
  const second = await store.appendEvent(alice, chat.id, {
    type: "tool.completed",
    data: { ok: true },
    durationMs: 41.6,
  });
  await store.appendEvent(alice, chat.id, {
    type: "assistant.message",
    data: { text: "done" },
  });
  assert.deepEqual([first.seq, second.seq], [1, 2]);
  assert.equal(first.data.text, "my key is [redacted]");
  assert.equal(second.durationMs, 42);

  const rest = await store.listEvents(alice, chat.id, { afterSeq: 1 });
  assert.deepEqual(
    rest.map((e) => e.seq),
    [2, 3],
  );
  assert.equal(
    (await store.listEvents(alice, chat.id, { limit: 1 })).length,
    1,
  );
  const raw = await s.owner.query(
    "SELECT data FROM session_events WHERE session_id = $1",
    [chat.id],
  );
  assert.ok(
    !JSON.stringify(raw.rows).includes("sk-proj-"),
    "the secret must not be in the database",
  );
  assert.equal((await store.getSession(alice, chat.id))?.eventCount, 3);
});

test("a turn is timed and added to the chat total; one runs at a time", async (t) => {
  const s = scratch(t);
  if (!s) return;
  const store = createStore(s.agentDb);
  const alice = await s.createUser("alice3");
  const chat = await store.createSession(alice);
  const turn = await store.startTurn(alice, chat.id, "model-x");
  assert.equal(turn.status, "running");
  await assert.rejects(
    store.startTurn(alice, chat.id, "model-x"),
    /session_turns_one_running/,
  );
  await new Promise((r) => setTimeout(r, 30));
  const done = await store.finishTurn(alice, turn.id, {
    status: "completed",
    inputTokens: 10,
    outputTokens: 4,
  });
  assert.equal(done.status, "completed");
  assert.ok((done.durationMs ?? 0) >= 25);
  assert.equal(
    (await store.getSession(alice, chat.id))?.execMs,
    done.durationMs,
  );

  const second = await store.startTurn(alice, chat.id, "model-x");
  assert.equal(second.n, 2);
  assert.equal(await store.failStaleTurns(alice, chat.id), 1);
  assert.equal((await store.getSession(alice, chat.id))?.turnCount, 2);
  const third = await store.startTurn(alice, chat.id, "model-x"); // no longer blocked
  const closed = await store.finishTurn(alice, third.id, {
    status: "failed",
    error: "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz broke",
  });
  assert.equal(closed.error, "token [redacted] broke");
});

test("another user cannot read or write this user's chat", async (t) => {
  const s = scratch(t);
  if (!s) return;
  const store = createStore(s.agentDb);
  const alice = await s.createUser("alice4");
  const bob = await s.createUser("bob4");
  const chat = await store.createSession(alice);
  await store.appendEvent(alice, chat.id, {
    type: "user.message",
    data: { text: "private" },
  });
  assert.equal(await store.getSession(bob, chat.id), null);
  assert.deepEqual(await store.listEvents(bob, chat.id), []);
  await assert.rejects(
    store.appendEvent(bob, chat.id, { type: "user.message" }),
    NotFoundError,
  );
  await assert.rejects(store.startTurn(bob, chat.id, "m"), NotFoundError);
  await assert.rejects(
    store.renameSession(bob, chat.id, "mine"),
    NotFoundError,
  );
});

test("reads setup, user and the stored key only for the user it serves", async (t) => {
  const s = scratch(t);
  if (!s) return;
  const store = createStore(s.agentDb);
  const alice = await s.createUser("alice5");
  const bob = await s.createUser("bob5");
  await s.owner.query(
    `INSERT INTO user_setup (user_id, repo, repo_installation_id, orchestrator_model, subagent_model, sandbox, sandbox_checked_at)
     VALUES ($1, 'acme/shop', 4242, 'gpt-6-luna', 'gemini-3.8-flash', 'docker', now())`,
    [alice],
  );
  const secret = encryptSecret(
    "sk-the-real-key-value-1234567890",
    `${alice}:openai`,
  );
  await s.owner.query(
    "INSERT INTO provider_keys (user_id, provider, iv, ciphertext, tag, last4, models) VALUES ($1, 'openai', $2, $3, $4, '7890', ARRAY['gpt-6-luna'])",
    [alice, secret.iv, secret.ciphertext, secret.tag],
  );

  const setup = await store.getSetup(alice);
  assert.equal(setup?.repo, "acme/shop");
  assert.equal(setup?.installationId, 4242);
  assert.equal(setup?.orchestrator, "gpt-6-luna");
  assert.equal(setup?.sandbox, "docker");
  assert.equal((await store.getUser(alice))?.login, "alice5");
  assert.deepEqual(await store.listKeyProviders(alice), ["openai"]);

  const stored = await store.getProviderKey(alice, "openai");
  assert.ok(stored);
  assert.equal(
    decryptSecret(stored, `${alice}:openai`, keyHex),
    "sk-the-real-key-value-1234567890",
  );
  assert.deepEqual(stored.models, ["gpt-6-luna"]);
  assert.equal(await store.getProviderKey(alice, "google"), null);

  assert.equal(await store.getSetup(bob), null);
  assert.equal(await store.getProviderKey(bob, "openai"), null);
  assert.deepEqual(await store.listKeyProviders(bob), []);
});
