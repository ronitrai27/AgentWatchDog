// k6, the comparison with the code before the fix, Toxiproxy and Schemathesis, run on the fixed
// code. The app is started twice on one internal network: the fix ("head") and the code without
// it ("base"). They run only when the fix touches server code, and say so when they do not.
//
// Which of the four run is decided from what the patch does, not its file names: the Decisions API
// says whether it can change API responses, speed or fault handling, and a check runs above a low
// threshold (GATE_RUN). Schemathesis also runs whenever a route file or the spec changed. When the
// API fails, all four run, as before.
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type CheckId,
  type CheckResult,
  type PlanItem,
  runCheck,
  touchesRoutes,
  touchesServer,
} from "../checks";
import { destroyRun, ensureVolume } from "../docker";
import { emit } from "../events";
import {
  type Facts,
  fixturesDir,
  loadVolume,
  type Stage,
  volumes,
} from "../source";
import { stageMounts } from "../stage";
import {
  brief,
  type Decide,
  decide as decisions,
  GATE_QUESTIONS,
  GATE_RUN,
  prob,
} from "./decisions";
import type { Gate, ServiceGates } from "./gates";
import type { Workspace } from "./workspace";

const CHECKS: [CheckId, string][] = [
  ["k6", "k6 (smoke and load)"],
  ["perf-compare", "Performance against the base"],
  ["toxiproxy", "Toxiproxy (network faults)"],
  ["schemathesis", "Schemathesis (API fuzzing)"],
];

/**
 * Why each check may be skipped for this patch; a check without a reason runs. The model can
 * only make a check run where a file-name rule would skip it, or skip one whose effect it puts
 * below GATE_RUN. Without an answer every check runs, except Schemathesis without a route change.
 */
async function plan(
  run: string,
  patch: string,
  files: string[],
  decide: Decide,
): Promise<Partial<Record<CheckId, string>>> {
  const routes = touchesRoutes(files);
  try {
    const d = await decide(patch.slice(0, 20_000), GATE_QUESTIONS);
    const p = (k: string) => prob(d, k) ?? 1; // a refused question runs its check
    const http = p("affects_http_api");
    const perf = p("affects_performance");
    const fault = p("affects_fault_handling");
    const below = (what: string, ...ps: number[]) =>
      `the fix is unlikely to change ${what} (${ps.map((x) => x.toFixed(2)).join(", ")} < ${GATE_RUN})`;
    const why: Partial<Record<CheckId, string>> = {};
    if (http < GATE_RUN && perf < GATE_RUN)
      why.k6 = below("API responses or speed", http, perf);
    if (perf < GATE_RUN) why["perf-compare"] = below("speed", perf);
    if (fault < GATE_RUN) why.toxiproxy = below("fault handling", fault);
    if (!routes && http < GATE_RUN)
      why.schemathesis = below("API responses, and no route changed", http);
    await emit(run, {
      step: "verify",
      kind: "decision",
      title: `Service checks: ${
        CHECKS.filter(([c]) => !why[c])
          .map(([, n]) => n)
          .join(", ") || "none needed"
      }`,
      ms: d.ms,
      data: { answers: brief(d), skipped: why, tokens: d.inputTokens },
    });
    return why;
  } catch (e) {
    await emit(run, {
      step: "verify",
      kind: "decision.failed",
      title: `Service check selection failed, running them all: ${String(e).slice(0, 200)}`,
      status: "error",
    });
    return routes ? {} : { schemathesis: "no API route changed" };
  }
}

const skipped = (why: string): Gate[] =>
  CHECKS.map(([, name]) => ({
    name,
    group: "performance",
    ok: true,
    detail: "",
    ms: 0,
    skipped: why,
  }));

/**
 * @param source The installed code without the fix (its dependencies are used by both sides).
 * @param attempt Each attempt gets its own app containers, so a crash never reuses a stale one.
 */
export function serviceGates(o: {
  run: string;
  repo: string;
  attempt: number;
  copy: Workspace;
  source: string;
  signal?: AbortSignal;
  decide?: Decide;
}): ServiceGates {
  return async (files, patch) => {
    const fixtures = fixturesDir(o.repo);
    const stage = JSON.parse(
      await readFile(path.join(fixtures, "stage.json"), "utf8").catch(
        () => "null",
      ),
    ) as Stage | null;
    if (!stage) return skipped("no way to run the app is known");
    if (!touchesServer(files, stage))
      return skipped("the fix does not touch server code");

    const why = await plan(o.run, patch, files, o.decide ?? decisions);
    if (CHECKS.every(([check]) => why[check]))
      return CHECKS.map(([check, name]) => ({
        name,
        group: "performance" as const,
        ok: true,
        detail: "",
        ms: 0,
        skipped: why[check] as string,
      }));

    const id = `${o.run}-svc${o.attempt}`;
    const facts = {
      stage,
      changed: files,
      openapi: "/fixtures/openapi.yaml",
      k6Script: "/fixtures/k6/load.js",
    } as Facts;
    try {
      const v = volumes(id);
      await loadVolume(fixtures, v.fixtures, id);
      await ensureVolume(v.src, id);
      stageMounts.set(id, (side) =>
        side === "head"
          ? o.copy.appMounts()
          : [{ volume: o.source, at: "/app", readOnly: true }],
      );
      const input = {
        run: id,
        repo: o.repo,
        head: "fix",
        base: "before",
        pr: null,
      };
      const out: Gate[] = [];
      for (const [check, name] of CHECKS) {
        const skip = why[check];
        if (skip) {
          out.push({
            name,
            group: "performance",
            ok: true,
            detail: "",
            ms: 0,
            skipped: skip,
          });
          continue;
        }
        const item: PlanItem = {
          id: check,
          title: name,
          area: "performance",
          on: "work",
          applies: true,
        };
        const r: CheckResult = await runCheck(
          input,
          item,
          facts,
          { head: true, base: true, summary: "" },
          [],
          o.signal,
        );
        out.push({
          name,
          group: "performance",
          // A crash on start or a slower fix blocks it; so does a fault the app no longer survives.
          ok: r.status === "pass" || r.status === "skipped",
          detail: r.summary,
          ms: r.ms,
          ...(r.status === "skipped" ? { skipped: r.summary } : {}),
          // "error" is the check failing to run (the app did not start, a timeout), not a finding.
          ...(r.status === "error" ? { env: true } : {}),
        });
      }
      return out;
    } finally {
      stageMounts.delete(id);
      await destroyRun(id);
    }
  };
}
