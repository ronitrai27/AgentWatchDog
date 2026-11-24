// Rox, in this process: one compiled graph, the turns that are running, and the live feed the
// browser follows. The Next.js routes call these functions directly; there is no second server.
import { EventEmitter, on } from "node:events";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";
import { priceOf } from "../../src/lib/models";
import { agentDatabaseUrl, need } from "./config";
import { createDb } from "./db";
import {
  DEFAULT_LIMITS,
  EVENT,
  type Limits,
  type LiveEvent,
} from "./graph/events";
import { buildRoxGraph, type Turn } from "./graph/graph";
import {
  type ModelFactory,
  ModelUnavailable,
  savedKeyModels,
} from "./graph/models";
import { runTurn } from "./graph/run";
import { createDockerClient, type DockerClient } from "./integrations/docker";
import { type GithubClient, githubFromEnv } from "./integrations/github";
import { createStore, NotFoundError, type Store } from "./store/sessions";

export { NotFoundError };

/** A turn is already running in this chat. */
export class BusyError extends Error {}

export type RoxDeps = {
  store: Store;
  github: GithubClient | null;
  docker: DockerClient;
  models: ModelFactory;
  checkpointer: BaseCheckpointSaver;
  limits?: Partial<Limits>;
};

export type ChatMessage =
  | LiveEvent
  | { kind: "ready"; running: boolean; lastSeq: number };

export function createRox(deps: RoxDeps) {
  const graph = buildRoxGraph(deps.checkpointer);
  const { store } = deps;
  const running = new Map<string, AbortController>();
  /** The running turns of each user: together they share the day's budget. */
  const spending = new Map<string, Set<Turn>>();
  const feed = new EventEmitter().setMaxListeners(0);

  async function execute(
    userId: string,
    sessionId: string,
    turnId: string,
    modelId: string | null,
    text: string,
    signal: AbortSignal,
  ) {
    const live = (event: LiveEvent) => void feed.emit(sessionId, event);
    let turn: Turn | undefined;
    try {
      if (!modelId)
        throw new ModelUnavailable(
          "No model was chosen in the setup guide.",
          "Choose a main model in the setup guide, then send your message again.",
        );
      const mine = spending.get(userId) ?? new Set<Turn>();
      spending.set(userId, mine);
      /** Read fresh each time, so a lowered budget counts at once. */
      const left = async () => {
        const now = await store.getConfig(userId);
        let live = 0;
        for (const t of mine) live += t.spentUsd + t.pendingUsd;
        return {
          config: now.config,
          usd: now.config.dayBudgetUsd - now.spentTodayUsd - live,
        };
      };
      const { config, usd } = await left();
      if (usd < 0.01)
        throw new ModelUnavailable(
          `The budget of $${config.dayBudgetUsd.toFixed(2)} for today is used up.`,
          "Raise it in Settings > Agent, or wait until midnight UTC.",
        );
      // One answer may use at most a quarter of what is left, so a small budget still allows steps.
      const outputCap = Math.min(
        8_000,
        Math.max(
          500,
          Math.floor((usd * 0.25 * 1_000_000) / priceOf(modelId).output),
        ),
      );
      const current: Turn = {
        userId,
        sessionId,
        turnId,
        store,
        github: deps.github,
        docker: deps.docker,
        model: await deps.models(userId, modelId, outputCap),
        modelId,
        outputCap,
        config,
        limits: {
          ...DEFAULT_LIMITS,
          maxWallMs: config.maxMinutes * 60_000,
          ...deps.limits,
        },
        spentUsd: 0,
        pendingUsd: 0,
        reserve: async (worst) => {
          const { usd: leftUsd } = await left();
          const ok = worst <= leftUsd;
          if (ok) current.pendingUsd = worst;
          return { ok, leftUsd };
        },
        modelCalls: 0,
        toolCalls: 0,
      };
      turn = current;
      mine.add(turn);
      await runTurn(graph, turn, { text, signal, live });
    } catch (error) {
      // The turn could not even start (no model, no key). Say so in the chat, in plain words.
      const known = error instanceof ModelUnavailable ? error : null;
      const message =
        known?.message ??
        `Rox could not start: ${error instanceof Error ? error.message.slice(0, 300) : "unknown problem"}`;
      const record = async (type: string, data: Record<string, unknown>) =>
        live({
          kind: "event",
          event: await store.appendEvent(userId, sessionId, {
            type,
            data,
            turnId,
          }),
        });
      try {
        await record(EVENT.userMessage, { text });
        await record(EVENT.agentError, {
          message,
          kind: known ? "setup" : "internal",
          ...(known ? { hint: known.hint } : {}),
        });
        await store.finishTurn(userId, turnId, {
          status: "failed",
          error: message,
        });
      } catch {
        // the log itself is down; nothing more can be said
      }
      live({ kind: "turn", turnId, status: "failed" });
    } finally {
      if (turn) spending.get(userId)?.delete(turn);
    }
  }

  return {
    graph,
    github: deps.github,
    store,

    /** Starts a turn and returns at once; the turn keeps running if the browser goes away. */
    async startTurn(userId: string, sessionId: string, text: string) {
      const chat = await store.getSession(userId, sessionId);
      if (!chat) throw new NotFoundError();
      if (running.has(sessionId)) throw new BusyError();
      const controller = new AbortController();
      running.set(sessionId, controller);
      try {
        // Anything still 'running' in the database is left over from a crash.
        await store.failStaleTurns(userId, sessionId);
        if (chat.name === "New chat")
          await store.renameSession(
            userId,
            sessionId,
            text.replace(/\s+/g, " ").slice(0, 60),
          );
        const modelId = (await store.getSetup(userId))?.orchestrator ?? null;
        const turn = await store.startTurn(userId, sessionId, modelId);
        void execute(
          userId,
          sessionId,
          turn.id,
          modelId,
          text,
          controller.signal,
        ).finally(() => running.delete(sessionId));
        return { turnId: turn.id };
      } catch (error) {
        running.delete(sessionId);
        throw error;
      }
    },

    /** Presses stop. False if nothing was running. */
    async stop(userId: string, sessionId: string) {
      if (!(await store.getSession(userId, sessionId)))
        throw new NotFoundError();
      const controller = running.get(sessionId);
      controller?.abort();
      return controller !== undefined;
    },

    /** Everything in the chat after `after`, then new events as they happen. */
    async *follow(
      userId: string,
      sessionId: string,
      after: number,
      signal: AbortSignal,
    ): AsyncGenerator<ChatMessage> {
      if (!(await store.getSession(userId, sessionId)))
        throw new NotFoundError();
      // Listen first, so nothing is missed while the log is being read.
      const live = on(feed, sessionId, { signal });
      let last = after;
      try {
        for (;;) {
          const page = await store.listEvents(userId, sessionId, {
            afterSeq: last,
            limit: 500,
          });
          for (const event of page) {
            last = event.seq;
            yield { kind: "event", event };
          }
          if (page.length < 500) break;
        }
        yield { kind: "ready", running: running.has(sessionId), lastSeq: last };
        for await (const [message] of live as AsyncIterable<[LiveEvent]>) {
          if (message.kind === "event") {
            if (message.event.seq <= last) continue; // already sent from the log
            last = message.event.seq;
          }
          yield message;
        }
      } catch (error) {
        if (!signal.aborted) throw error;
      } finally {
        await live.return?.();
      }
    },
  };
}

export type Rox = ReturnType<typeof createRox>;

/** Rox with the real database, GitHub App, Docker and the users' own model keys. */
export function createRoxFromEnv(): Rox {
  const url = agentDatabaseUrl();
  const store = createStore(createDb(url));
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    connectionTimeoutMillis: 3000,
  });
  // An idle connection dropped by the server must not crash the process.
  pool.on("error", () => {});
  return createRox({
    store,
    github: githubFromEnv(),
    docker: createDockerClient(),
    models: savedKeyModels(store, need("ENCRYPTION_KEY")),
    // What the model remembers of each chat. scripts/migrate.mjs creates the tables.
    checkpointer: new PostgresSaver(pool, undefined, { schema: "langgraph" }),
  });
}
