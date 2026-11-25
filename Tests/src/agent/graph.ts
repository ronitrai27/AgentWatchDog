// The fix agent as a LangGraph graph.
//
//   triage -> investigate -> fix -> verify -> judge -> report
//               ^   ^         |       |         |
//               |   +---------+-------+---------+   refused: back with the reason (3 attempts)
//               +-- a cause without proof (2 times)
//
// triage, verify and report are code. Only three nodes call a model, and none of them decides
// whether the run succeeded: verify does. Any node may end the run honestly through report.
import {
  type BaseCheckpointSaver,
  Command,
  END,
  type GraphNode,
  type NodeError,
  ReducedValue,
  START,
  StateGraph,
  StateSchema,
} from "@langchain/langgraph";
import * as z from "zod";
import { emit } from "../events";
import {
  answerOf,
  engineer,
  Findings,
  FixAnswer,
  investigator,
  judge,
  Review,
} from "./agents";
import {
  type Baseline,
  type Contract,
  InfraError,
  runTests,
  typecheck,
  type Verdict,
  verify,
} from "./gates";
import { inspectPatch } from "./policy";
import type { Spend } from "./spend";
import type { Workspace } from "./workspace";

export const MAX_ATTEMPTS = 3;
const MAX_INVESTIGATIONS = 2;
const RERUNS = 3;

const Attempt = z.object({
  n: z.number(),
  /** The cause it was based on. */
  cause: z.string(),
  patch: z.string(),
  summary: z.string(),
  /** Why it was not accepted; null when it was. */
  failed: z.string().nullable(),
  /** The step that refused it. */
  by: z.string().nullable(),
});
export type Attempt = z.infer<typeof Attempt>;

/** Everything a resumed run needs, and nothing that cannot be saved. */
export const FixState = new StateSchema({
  workspaces: z.array(z.string()),
  /** The diff that is being checked, when there is one. */
  change: z.string().default(""),
  contract: z.custom<Contract>().nullable().default(null),
  baseline: z.custom<Baseline>().nullable().default(null),
  findings: Findings.nullable().default(null),
  /** Why earlier investigations were not accepted. */
  doubts: new ReducedValue(
    z.array(z.string()).default(() => []),
    { reducer: (a: string[], b: string[]) => a.concat(b) },
  ),
  attempts: new ReducedValue(
    z.array(Attempt).default(() => []),
    // A node that is run again after a crash replaces its own attempt instead of adding one.
    {
      reducer: (a: Attempt[], b: Attempt[]) => [
        ...a.filter((x) => !b.some((y) => y.n === x.n)),
        ...b,
      ],
    },
  ),
  verdict: z.custom<Verdict>().nullable().default(null),
  outcome: z
    .enum(["fixed", "nothing_to_fix", "gave_up", "infra"])
    .nullable()
    .default(null),
  reason: z.string().default(""),
});
type State = typeof FixState.State;

/** What the nodes work with. Handed in on every invoke, never saved. */
export const FixContext = z.object({
  run: z.string(),
  spend: z.custom<Spend>(),
  /** Opens (or re-opens after a crash) the agent's working copy. */
  workspace: z.custom<() => Promise<Workspace>>(),
  /** A fresh copy for Verify, never touched by an agent. */
  fresh: z.custom<() => Promise<Workspace>>(),
});
export type FixContext = z.infer<typeof FixContext>;

type Nodes = "triage" | "investigate" | "fix" | "verify" | "judge" | "report";
type Node = GraphNode<{
  InputSchema: typeof FixState;
  OutputSchema: typeof FixState;
  ContextSchema: typeof FixContext;
  Nodes: Nodes;
}>;

/** The agents' real bound is their model call limit; every middleware hook counts as a step. */
const AGENT_STEPS = 150;

const ctxOf = (rt: { context?: FixContext }) => {
  if (!rt.context) throw new Error("the graph was started without its context");
  return rt.context;
};
const stop = (
  outcome: NonNullable<State["outcome"]>,
  reason: string,
): Command<unknown, Partial<State>, Nodes> =>
  new Command({ update: { outcome, reason }, goto: "report" });

const failureText = (c: Contract) =>
  [
    ...c.tests
      .slice(0, 5)
      .map(
        (t) =>
          `Test "${t.name}" in ${t.ws}/${t.file} fails:\n${t.message.slice(0, 900)}`,
      ),
    ...(c.typecheck ? [`The type checker fails:\n${c.typecheck}`] : []),
  ].join("\n\n");

/** Code only: what fails every time is a problem, what fails sometimes is noise. */
const triage: Node = async (state, rt) => {
  const { workspace, run } = ctxOf(rt);
  const ws = await workspace();
  await ws.file("reset");
  const first = (
    await Promise.all(state.workspaces.map((dir) => runTests(ws, dir)))
  ).flat();
  let failing = first.filter((c) => c.failed);
  for (let i = 1; i < RERUNS && failing.length; i++)
    for (const dir of new Set(failing.map((f) => f.ws))) {
      const again = await runTests(ws, dir, [
        ...new Set(failing.filter((f) => f.ws === dir).map((f) => f.file)),
      ]);
      failing = failing.filter(
        (f) =>
          f.ws !== dir ||
          again.some((c) => c.failed && c.file === f.file && c.name === f.name),
      );
    }
  const flaky = first.filter((c) => c.failed && !failing.includes(c));
  const types = await typecheck(ws);
  await emit(run, {
    step: "triage",
    kind: "triage.done",
    title: `${failing.length} tests fail ${RERUNS} of ${RERUNS} times, ${flaky.length} only sometimes${types ? ", types fail" : ""}`,
    data: {
      failing: failing.map((f) => f.name),
      flaky: flaky.map((f) => f.name),
    },
  });
  if (!failing.length && !types)
    return stop(
      "nothing_to_fix",
      flaky.length
        ? `only flaky tests: ${flaky.map((f) => f.name).join(", ")}`
        : "no failing test and no type error",
    );
  return new Command({
    update: {
      contract: {
        tests: failing.map(({ failed: _, ...t }) => t),
        typecheck: types,
      },
      baseline: {
        workspaces: state.workspaces,
        passing: first
          .filter((c) => !c.failed)
          .map(({ ws: dir, file, name }) => ({ ws: dir, file, name })),
      },
    },
    goto: "investigate",
  });
};

/** The test's own code, so the Investigator does not spend a call on finding it. */
async function testSource(ws: Workspace, c: Contract): Promise<string> {
  const t = c.tests[0];
  if (!t) return "";
  const path = `${t.ws}/${t.file}`;
  const title = t.name.split(" > ").at(-1) ?? "";
  const found = await ws.file("search", { text: title, dir: path });
  const line = Number(
    /(?:^|:)(\d+):/.exec(String((found.matches as string[])?.[0] ?? ""))?.[1] ??
      1,
  );
  const r = await ws.file("read", {
    path,
    from: Math.max(1, line - 12),
    to: line + 45,
  });
  return r.ok ? `\n\nFrom ${path}:\n${r.text}` : "";
}

const changedLines = (patch: string) =>
  patch
    .split("\n")
    .filter((l) => /^([+-][^+-]|diff )/.test(l))
    .join("\n")
    .slice(0, 800) || "(nothing)";

const squash = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\d+\t/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

/** Splits the quotes into those that really are in the file they name and those that are not. */
async function checkQuotes(ws: Workspace, f: Findings) {
  const proven: Findings["evidence"] = [];
  const made: Findings["evidence"] = [];
  for (const e of f.evidence) {
    let text = "";
    for (let from = 1; from < 1500; from += 150) {
      const r = await ws.file("read", { path: e.path, from });
      if (!r.ok) break;
      text += `\n${r.text}`;
      if (from + 150 > Number(r.lines)) break;
    }
    const quote = squash(e.quote);
    const ok = quote.length >= 8 && squash(text).includes(quote);
    (ok ? proven : made).push(e);
  }
  return { proven, made };
}

const investigate: Node = async (state, rt) => {
  const { workspace, run, spend } = ctxOf(rt);
  const ws = await workspace();
  const contract = state.contract as Contract;
  // A failed attempt usually means a wrong cause, so the Investigator hears about it first.
  const tried = state.attempts.map(
    (a) =>
      `Attempt ${a.n} assumed "${a.cause}" and changed:\n${changedLines(a.patch)}\nIt failed: ${a.by}: ${a.failed?.slice(0, 500)}`,
  );
  const history = [...state.doubts.slice(-1), ...tried].join("\n\n");
  const doubts = history
    ? `\n\nEarlier answers that were wrong. Do not repeat them, look elsewhere:\n${history}`
    : "";
  const change = state.change
    ? `\n\nWhat this change touched (the cause is often here):\n${state.change.slice(0, 6000)}`
    : "";
  const result = await investigator.invoke(
    {
      messages: [
        {
          role: "user",
          content: `${failureText(contract)}${await testSource(ws, contract)}${change}${doubts}`,
        },
      ],
    },
    {
      context: {
        run,
        step: "investigate",
        ws,
        spend,
        workspaces: state.workspaces,
      },
      signal: rt.signal,
      recursionLimit: AGENT_STEPS,
    },
  );
  const findings = answerOf(result, Findings);
  if (!findings)
    return stop("gave_up", "the Investigator ended without answer");
  const { proven: evidence, made } = await checkQuotes(ws, findings);
  await emit(run, {
    step: "investigate",
    kind: "findings",
    title: `${findings.outcome}: ${findings.cause}`,
    data: {
      ...findings,
      evidence,
      rejectedQuotes: made,
    },
  });
  if (findings.outcome !== "bug_in_code")
    return new Command({
      update: {
        findings,
        outcome: "gave_up" as const,
        reason: `${findings.outcome}: ${findings.cause}`,
      },
      goto: "report",
    });
  if (evidence.length === 0) {
    const doubt = `"${findings.cause}" was not proven: these quotes are not in the files named: ${made.map((e) => `${e.path}: ${e.quote.slice(0, 120)}`).join(" | ") || "none given"}. Copy a full line exactly.`;
    return state.doubts.length + 1 >= MAX_INVESTIGATIONS
      ? stop("gave_up", `the cause could not be proven: ${doubt}`)
      : new Command({ update: { doubts: [doubt] }, goto: "investigate" });
  }
  return new Command({
    update: { findings: { ...findings, evidence } },
    goto: "fix",
  });
};

/** Back to the Investigator with the reason, or the end when the attempts are used up. */
const refuse = (last: Attempt, by: string, failed: string) => {
  const attempts = [{ ...last, by, failed }];
  return last.n >= MAX_ATTEMPTS
    ? new Command<unknown, Partial<State>, Nodes>({
        update: {
          attempts,
          outcome: "gave_up",
          reason: `${MAX_ATTEMPTS} attempts failed; the last was refused by ${by}: ${failed}`,
        },
        goto: "report",
      })
    : new Command<unknown, Partial<State>, Nodes>({
        update: { attempts },
        goto: "investigate",
      });
};

const fix: Node = async (state, rt) => {
  const { workspace, run, spend } = ctxOf(rt);
  const ws = await workspace();
  await ws.file("reset"); // Every attempt starts clean, also one repeated after a crash.
  const f = state.findings as Findings;
  const n = state.attempts.length + 1;
  const lessons = state.attempts
    .map(
      (a) =>
        `Attempt ${a.n} was refused by ${a.by}: ${a.failed}\nIts patch:\n${a.patch.slice(0, 1200)}`,
    )
    .join("\n\n");
  const result = await engineer.invoke(
    {
      messages: [
        {
          role: "user",
          content: `${failureText(state.contract as Contract)}

Cause (from the Investigator): ${f.cause}
Proven lines:
${f.evidence.map((e) => `- ${e.path}: ${e.quote}`).join("\n")}
Suggested change: ${f.plan}
Workspaces: ${state.workspaces.join(", ")}${lessons ? `\n\nThe working copy is clean again. ${lessons}\nDo something different.` : ""}`,
        },
      ],
    },
    {
      context: { run, step: "fix", ws, spend, workspaces: state.workspaces },
      signal: rt.signal,
      recursionLimit: AGENT_STEPS,
    },
  );
  const answer = answerOf(result, FixAnswer);
  // The patch is what is on disk, not what the model says it did.
  const patch = await ws.patch();
  const facts = inspectPatch(patch);
  await emit(run, {
    step: "fix",
    kind: "attempt",
    title: `Attempt ${n}: ${answer?.outcome ?? "no answer"}, ${facts.files.length} files, +${facts.added} -${facts.removed}`,
    data: { summary: answer?.summary ?? "", patch: patch.slice(0, 6000) },
  });
  const made: Attempt = {
    n,
    cause: f.cause,
    patch,
    summary: answer?.summary ?? "",
    failed: null,
    by: null,
  };
  if (answer?.outcome !== "fixed")
    return refuse(made, "the Engineer", answer?.summary ?? "no answer");
  return new Command({
    update: { attempts: [made], verdict: null },
    goto: "verify",
  });
};

const verifyNode: Node = async (state, rt) => {
  const { fresh, run } = ctxOf(rt);
  const last = state.attempts.at(-1) as Attempt;
  const copy = await fresh();
  try {
    const verdict = await verify(
      copy,
      last.patch,
      state.contract as Contract,
      state.baseline as Baseline,
      (g) =>
        emit(run, {
          step: "verify",
          kind: "gate",
          title: g.name,
          status: g.ok ? "pass" : "fail",
          ms: g.ms,
          data: g.ok ? {} : { detail: g.detail.slice(0, 600) },
        }),
    );
    // The sandbox failed, not the fix: the retry policy runs this node again.
    if (verdict.infra) throw new InfraError(verdict.gates.at(-1)?.detail);
    if (verdict.ok) return new Command({ update: { verdict }, goto: "judge" });
    const bad = verdict.gates.find((g) => !g.ok);
    return refuse(last, `Verify ("${bad?.name}")`, bad?.detail ?? "");
  } finally {
    await copy.close();
  }
};

const judgeNode: Node = async (state, rt) => {
  const { workspace, run, spend } = ctxOf(rt);
  const ws = await workspace();
  const last = state.attempts.at(-1) as Attempt;
  const contract = state.contract as Contract;
  const result = await judge.invoke(
    {
      messages: [
        {
          role: "user",
          // Not the Engineer's own story: the Judge sees the problem and the patch.
          content: `The problem:\n${failureText(contract)}\n\nThe patch:\n${last.patch.slice(0, 8000)}\n\nPassed: ${state.verdict?.gates.map((g) => g.name).join(", ")}`,
        },
      ],
    },
    {
      context: { run, step: "judge", ws, spend, workspaces: state.workspaces },
      signal: rt.signal,
      recursionLimit: AGENT_STEPS,
    },
  );
  const review = answerOf(result, Review);
  await emit(run, {
    step: "judge",
    kind: "review",
    title: review
      ? `${review.accept ? "Accepted" : "Rejected"}: ${review.reason}`
      : "No answer",
    status: review?.accept ? "pass" : "fail",
  });
  // No answer is not a yes.
  if (!review?.accept)
    return refuse(last, "the Judge", review?.reason ?? "no answer");
  return stop("fixed", last.summary);
};

const report: Node = async (state, rt) => {
  const { run, spend } = ctxOf(rt);
  await emit(run, {
    step: "report",
    kind: "agent.finished",
    title: `${state.outcome}: ${state.reason.slice(0, 300)}`,
    status: state.outcome === "fixed" ? "pass" : "fail",
    data: {
      outcome: state.outcome,
      attempts: state.attempts.length,
      modelCalls: spend.calls,
      tokens: spend.tokens,
      usd: Number(spend.usd.toFixed(5)),
    },
  });
  return {};
};

/** After the retries of a node are used up: end honestly instead of crashing the run. */
const onError = async (_: unknown, failure: NodeError, config?: unknown) => {
  const { signal } = (config ?? {}) as { signal?: AbortSignal };
  if (signal?.aborted) throw failure.error;
  const infra =
    failure.error instanceof InfraError ||
    failure.error.name === "NodeTimeoutError";
  return stop(
    infra ? "infra" : "gave_up",
    `${failure.node}: ${failure.error.message.slice(0, 400)}`,
  );
};

export function buildGraph(checkpointer?: BaseCheckpointSaver) {
  return new StateGraph({
    state: FixState,
    context: FixContext,
  })
    .addNode("triage", triage, { ends: ["investigate", "report"] })
    .addNode("investigate", investigate, {
      ends: ["investigate", "fix", "report"],
    })
    .addNode("fix", fix, { ends: ["verify", "investigate", "report"] })
    .addNode("verify", verifyNode, { ends: ["judge", "investigate", "report"] })
    .addNode("judge", judgeNode, { ends: ["investigate", "report"] })
    .addNode("report", report)
    .setNodeDefaults({
      // Only sandbox trouble is worth repeating. A wrong answer is handled by the loops.
      retryPolicy: {
        maxAttempts: 2,
        retryOn: (e: unknown) => e instanceof InfraError,
        logWarning: false,
      },
      timeout: { runTimeout: 8 * 60_000 },
      errorHandler: onError,
    })
    .addEdge(START, "triage")
    .addEdge("report", END)
    .compile({ checkpointer, name: "rox-fix" });
}
