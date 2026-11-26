// Proves every route of the graph without a model: stand-in agents give scripted answers, and the
// real graph, sandbox and gates do the rest.   pnpm --dir Tests proof:loops [name]
import { MemorySaver } from "@langchain/langgraph";
import { readEvents } from "../events";
import { CASES } from "./cases";
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
const ACCEPT = { accept: true, reason: "Small and correct." };
const REJECT = { accept: false, reason: "Rejected on purpose by the proof." };

type Scenario = {
  name: string;
  clean?: boolean;
  limitUsd?: number;
  real?: boolean;
  agents?: (calls: Record<string, number>) => Agents;
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
