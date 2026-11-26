// Proves every route of the graph without a model: stand-in agents give scripted answers, and the
// real graph, sandbox and gates do the rest.   pnpm --dir Tests proof:loops [name]
import { MemorySaver } from "@langchain/langgraph";
import { readEvents } from "../events";
import { CASES } from "./cases";
import type { Answer, Decide, Question } from "./decisions";
import type { AgentLike, Agents } from "./graph";
import { startCase } from "./lab-run";
import { type FixResult, runFix } from "./run";
import type { AgentContext } from "./tools";

const bug = CASES[0];
if (!bug) throw new Error("no case");

type Script = (ctx: AgentContext, n: number) => Promise<unknown> | unknown;
const scripted = (
  name: string,
  script: Script,
  calls: Record<string, number>,
) =>
  ({
    invoke: async (_input, { context }) => {
      calls[name] = (calls[name] ?? 0) + 1;
      return {
        messages: [],
        structuredResponse: await script(context, calls[name] as number),
      };
    },
  }) satisfies AgentLike;

const RIGHT_CAUSE = {
  outcome: "bug_in_code",
  cause:
    "nextCursor is taken from rows, which include the extra row fetched to see if there is more.",
  evidence: [
    {
      path: bug.file,
      quote:
        "return { items, nextCursor: hasMore ? (rows.at(-1)?.id ?? null) : null };",
    },
  ],
  plan: "Take the cursor from items.",
};
const MADE_UP = {
  ...RIGHT_CAUSE,
  evidence: [
    { path: bug.file, quote: "const cursor = rows.pop().identifier;" },
  ],
};
const edit = (ctx: AgentContext, put: string) =>
  ctx.ws.file("edit", { path: bug.file, old_text: bug.put, new_text: put });
const RIGHT = async (ctx: AgentContext) => {
  await edit(ctx, bug.find);
  return {
    outcome: "fixed",
    summary: "Cursor from items.",
    title: "fix: cursor from items",
  };
};
const WRONG = async (ctx: AgentContext) => {
  await edit(ctx, "items.at(0)?.id");
  return {
    outcome: "fixed",
    summary: "Cursor from the first item.",
    title: "fix: cursor",
  };
};
const NO_COMPILE = async (ctx: AgentContext) => {
  await edit(ctx, "items.at(-1)?.nope");
  return {
    outcome: "fixed",
    summary: "Cursor from items.",
    title: "fix: cursor",
  };
};

// ---- Scripted Decisions API: answers by question set, numbered per set ----
type Answers = Record<string, number | string>;
type DecisionScript = {
  judge?: (n: number) => Answers;
  route?: (n: number) => Answers;
  scan?: (input: string) => Answers;
};
/** Unsure, so the scripted written Judge decides; the old route; nothing injected. */
const UNSURE = {
  hides_symptom: 0.5,
  weakens_security: 0,
  breaks_callers: 0,
  unrelated_edits: 0,
  fix_quality: 0.5,
};
const CLEAN = {
  hides_symptom: 0,
  weakens_security: 0,
  breaks_callers: 0,
  unrelated_edits: 0,
  fix_quality: 1,
};
const route = (v: string, p = 0.95) => ({ next_step: v, p });
const scripted_decide =
  (s: DecisionScript, calls: Record<string, number>): Decide =>
  async (input: string, questions: Question[]) => {
    const set =
      questions[0]?.name === "next_step"
        ? "route"
        : questions[0]?.name === "hides_symptom"
          ? "judge"
          : questions[0]?.name === "prompt_injection"
            ? "scan"
            : "gates";
    const n = (calls[`decide.${set}`] ?? 0) + 1;
    calls[`decide.${set}`] = n;
    const a: Answers =
      set === "judge"
        ? (s.judge?.(n) ?? UNSURE)
        : set === "route"
          ? (s.route?.(n) ?? route("reinvestigate_new_cause"))
          : set === "scan"
            ? (s.scan?.(input) ?? { prompt_injection: 0 })
            : {};
    const answers: Record<string, Answer> = {};
    for (const q of questions) {
      const v = a[q.name];
      if (v === undefined) continue;
      answers[q.name] =
        q.type === "choice"
          ? {
              type: "choice",
              name: q.name,
              choice: String(v),
              confidence: 0.9,
              probabilities: [
                { value: String(v), probability: Number(a.p ?? 0.95) },
              ],
            }
          : q.type === "score"
            ? { type: "score", name: q.name, score: Number(v), confidence: 0.9 }
            : { type: "predicate", name: q.name, probability: Number(v) };
    }
    return { answers, ms: 1, inputTokens: 0 };
  };

const ACCEPT = { accept: true, reason: "Small and correct." };
const REJECT = { accept: false, reason: "Rejected on purpose by the proof." };

type Scenario = {
  name: string;
  clean?: boolean;
  limitUsd?: number;
  real?: boolean;
  agents?: (calls: Record<string, number>) => Agents;
  decisions?: DecisionScript;
  expect: (
    r: FixResult,
    calls: Record<string, number>,
    kinds: string[],
  ) => string | null;
};

const agents =
  (investigate: Script, fix: Script, review: Script) =>
  (calls: Record<string, number>): Agents => ({
    investigator: scripted("investigator", investigate, calls),
    engineer: scripted("engineer", fix, calls),
    judge: scripted("judge", review, calls),
  });

const SCENARIOS: Scenario[] = [
  {
    name: "Verify refuses, the cause is looked at again, then fixed",
    agents: agents(
      () => RIGHT_CAUSE,
      (ctx, n) => (n === 1 ? WRONG(ctx) : RIGHT(ctx)),
      () => ACCEPT,
    ),
    expect: (r, c) =>
      r.outcome === "fixed" &&
      r.attempts.length === 2 &&
      r.attempts[0]?.by?.startsWith("Verify") &&
      c.investigator === 2
        ? null
        : `${r.outcome}, ${r.attempts.length} attempts, first by ${r.attempts[0]?.by}, ${c.investigator} investigations`,
  },
  {
    name: "the Judge rejects, the cause is looked at again, then fixed",
    agents: agents(
      () => RIGHT_CAUSE,
      RIGHT,
      (_, n) => (n === 1 ? REJECT : ACCEPT),
    ),
    expect: (r, c) =>
      r.outcome === "fixed" &&
      r.attempts[0]?.by === "the Judge" &&
      c.judge === 2
        ? null
        : `${r.outcome}, first by ${r.attempts[0]?.by}, ${c.judge} reviews`,
  },
  {
    name: "three refusals end the run honestly",
    agents: agents(
      () => RIGHT_CAUSE,
      RIGHT,
      () => REJECT,
    ),
    expect: (r, c) =>
      r.outcome === "gave_up" && r.attempts.length === 3 && c.engineer === 3
        ? null
        : `${r.outcome}, ${r.attempts.length} attempts, ${c.engineer} fixes`,
  },
  {
    name: "a made-up quote is refused twice, then the run stops",
    agents: agents(
      () => MADE_UP,
      RIGHT,
      () => ACCEPT,
    ),
    expect: (r, c) =>
      r.outcome === "gave_up" && !c.engineer && c.investigator === 2
        ? null
        : `${r.outcome}, ${c.investigator} investigations, ${c.engineer ?? 0} fixes`,
  },
  {
    name: "the Engineer gives up three times",
    agents: agents(
      () => RIGHT_CAUSE,
      () => ({
        outcome: "give_up",
        summary: "The cause is outside what I may change.",
      }),
      () => ACCEPT,
    ),
    expect: (r) =>
      r.outcome === "gave_up" &&
      r.attempts.every((a) => a.by === "the Engineer") &&
      r.attempts.length === 3
        ? null
        : `${r.outcome}, ${r.attempts.map((a) => a.by).join(", ")}`,
  },
  {
    name: "router: a compile error keeps the cause, fix again",
    agents: agents(
      () => RIGHT_CAUSE,
      (ctx, n) => (n === 1 ? NO_COMPILE(ctx) : RIGHT(ctx)),
      () => ACCEPT,
    ),
    decisions: { route: () => route("retry_fix_same_cause") },
    expect: (r, c) =>
      r.outcome === "fixed" &&
      r.attempts.length === 2 &&
      r.attempts[0]?.by?.startsWith("Verify") &&
      c.investigator === 1
        ? null
        : `${r.outcome}, ${r.attempts.length} attempts, first by ${r.attempts[0]?.by}, ${c.investigator} investigations`,
  },
  {
    name: "router: a fix in a protected place stops after one attempt",
    agents: agents(
      () => RIGHT_CAUSE,
      () => ({
        outcome: "give_up",
        summary: "The fix is in migrations/, which may not be changed.",
      }),
      () => ACCEPT,
    ),
    decisions: { route: () => route("stop_unfixable", 0.9) },
    expect: (r, c) =>
      r.outcome === "gave_up" && r.attempts.length === 1 && c.engineer === 1
        ? null
        : `${r.outcome}, ${r.attempts.length} attempts, ${c.engineer} fixes`,
  },
  {
    name: "router: an unsure stop is not trusted, the old route is taken",
    agents: agents(
      () => RIGHT_CAUSE,
      (ctx, n) => (n === 1 ? WRONG(ctx) : RIGHT(ctx)),
      () => ACCEPT,
    ),
    decisions: { route: () => route("stop_unfixable", 0.7) },
    expect: (r, c) =>
      r.outcome === "fixed" && c.investigator === 2
        ? null
        : `${r.outcome}, ${c.investigator} investigations`,
  },
  {
    name: "decision Judge rejects, then accepts, no written review",
    agents: agents(
      () => RIGHT_CAUSE,
      RIGHT,
      () => REJECT,
    ),
    decisions: {
      judge: (n) =>
        n === 1 ? { ...CLEAN, hides_symptom: 0.95, fix_quality: 0.1 } : CLEAN,
      route: () => route("retry_fix_same_cause"),
    },
    expect: (r, c) =>
      r.outcome === "fixed" && r.attempts[0]?.by === "the Judge" && !c.judge
        ? null
        : `${r.outcome}, first by ${r.attempts[0]?.by}, ${c.judge ?? 0} written reviews`,
  },
  {
    name: "injected text is flagged and reported, the bug is still fixed",
    agents: agents(
      () => RIGHT_CAUSE,
      RIGHT,
      () => ACCEPT,
    ),
    decisions: {
      scan: (input): Answers =>
        /AssertionError|fails/.test(input)
          ? {
              prompt_injection: 0.97,
              asks_skip_checks: 0.9,
              asks_reveal_secrets: 0.8,
              asks_push_or_merge: 0.1,
              asks_approve: 0,
            }
          : { prompt_injection: 0.01 },
      judge: () => CLEAN,
    },
    expect: (r, _c, kinds) =>
      r.outcome === "fixed" && kinds.includes("security.injection_flagged")
        ? null
        : `${r.outcome}, flagged: ${kinds.includes("security.injection_flagged")}`,
  },
  {
    name: "the budget stops the real agents before any spend",
    real: true,
    limitUsd: 0,
    expect: (r) =>
      r.outcome === "gave_up" && /budget/.test(r.reason) && r.usd === 0
        ? null
        : `${r.outcome}, $${r.usd}: ${r.reason.slice(0, 120)}`,
  },
  {
    name: "nothing failing means nothing to fix",
    clean: true,
    real: true,
    expect: (r) =>
      r.outcome === "nothing_to_fix" && r.usd === 0 ? null : `${r.outcome}`,
  },
];

async function main() {
  const only = process.argv[2];
  let failed = 0;
  for (const s of SCENARIOS.filter((x) => !only || x.name.includes(only))) {
    const lab = await startCase(s.clean ? null : bug);
    const calls: Record<string, number> = {};
    const t0 = Date.now();
    try {
      const r = await runFix(
        { run: lab.run, workspaces: [bug.ws] },
        { workspace: async () => lab.ws, fresh: lab.fresh },
        {
          checkpointer: new MemorySaver(),
          agents: s.real ? undefined : s.agents?.(calls),
          decide: s.real
            ? undefined
            : scripted_decide(s.decisions ?? {}, calls),
          limitUsd: s.limitUsd,
        },
      );
      const kinds = (await readEvents(lab.run)).map((e) => e.kind);
      const problem = s.expect(r, calls, kinds);
      if (problem) failed++;
      console.log(
        `${problem ? "BROKEN " : "OK     "} ${s.name.padEnd(60)} ${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s  ${problem ?? `${r.outcome}: ${r.reason.slice(0, 80)}`}`,
      );
    } finally {
      await lab.end();
    }
  }
  console.log(failed ? `\n${failed} BROKEN` : "\nEvery route held.");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
