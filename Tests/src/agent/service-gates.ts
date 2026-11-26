// k6, the comparison with the code before the fix, Toxiproxy and Schemathesis, run on the fixed
// code. The app is started twice on one internal network: the fix ("head") and the code without
// it ("base"). They run only when the fix touches server code, and say so when they do not.
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
import {
  type Facts,
  fixturesDir,
  loadVolume,
  type Stage,
  volumes,
} from "../source";
import { stageMounts } from "../stage";
import type { Gate, ServiceGates } from "./gates";
import type { Workspace } from "./workspace";

const CHECKS: [CheckId, string][] = [
  ["k6", "k6 (smoke and load)"],
  ["perf-compare", "Performance against the base"],
  ["toxiproxy", "Toxiproxy (network faults)"],
  ["schemathesis", "Schemathesis (API fuzzing)"],
];

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
}): ServiceGates {
  return async (files) => {
    const fixtures = fixturesDir(o.repo);
    const stage = JSON.parse(
      await readFile(path.join(fixtures, "stage.json"), "utf8").catch(
        () => "null",
      ),
    ) as Stage | null;
    if (!stage) return skipped("no way to run the app is known");
    if (!touchesServer(files, stage))
      return skipped("the fix does not touch server code");

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
        if (check === "schemathesis" && !touchesRoutes(files)) {
          out.push(...skipped("no API route changed").slice(3));
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
        });
      }
      return out;
    } finally {
      stageMounts.delete(id);
      await destroyRun(id);
    }
  };
}
