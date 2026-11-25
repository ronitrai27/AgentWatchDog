// The app under test, running in the sandbox on the run's internal network (no route out).
// Started once and reused by k6, Toxiproxy and Schemathesis; destroyed with the run.
import {
  createNetwork,
  isRunning,
  sandbox,
  serviceLogs,
  startService,
} from "./docker";
import type { Facts } from "./source";
import { networks, volumes } from "./source";

export type Side = "head" | "base";

/** The host name a client uses to reach the target service of one side. */
export const hostOf = (facts: Facts, side: Side) =>
  side === "head"
    ? (facts.stage?.target ?? "api")
    : `${facts.stage?.target ?? "api"}-base`;

const containerOf = (run: string, service: string, side: Side) =>
  `rox-${run}-${service}${side === "base" ? "-base" : ""}`;

/** Starts the app's services for one side if they are not running, and waits until healthy. */
export async function ensureStage(
  run: string,
  facts: Facts,
  side: Side,
  signal?: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
  const stage = facts.stage;
  if (!stage) return { ok: false, detail: "no way to run the app is known" };
  const net = networks(run).stage;
  await createNetwork(net, run);
  const v = volumes(run);
  for (const s of stage.services) {
    const name = containerOf(run, s.name, side);
    if (await isRunning(name)) continue;
    await startService({
      name,
      run,
      script: `cd /app/${s.dir} && exec ${s.command}`,
      mounts: [
        {
          volume: side === "head" ? v.work : v.base,
          at: "/app",
          readOnly: true,
        },
      ],
      network: {
        name: net,
        alias: side === "head" ? s.name : `${s.name}-base`,
      },
      workdir: "/app",
      env: s.env,
    });
  }
  const target = stage.services.find((s) => s.name === stage.target);
  if (!target) return { ok: false, detail: `no service named ${stage.target}` };
  const url = `http://${hostOf(facts, side)}:${target.port}${target.health}`;
  const wait = await sandbox({
    name: `rox-${run}-wait-${side}`,
    run,
    script: `node -e "const end=Date.now()+60000;(async()=>{for(;;){try{const r=await fetch('${url}',{signal:AbortSignal.timeout(2000)});if(r.ok){console.log('healthy');process.exit(0)}}catch{}if(Date.now()>end){console.log('not healthy after 60s');process.exit(1)}await new Promise(r=>setTimeout(r,500))}})()"`,
    mounts: [],
    network: { name: net },
    workdir: "/tmp",
    timeoutMs: 90_000,
    signal,
  });
  if (wait.code === 0) return { ok: true, detail: `${url} is healthy` };
  const logs = await serviceLogs(containerOf(run, stage.target, side));
  return {
    ok: false,
    detail: `${side} app did not become healthy: ${logs.trim().split("\n").slice(-5).join(" | ").slice(0, 400)}`,
  };
}

/** Toxiproxy's server on the run's network, reachable as toxi:8474 (admin) and toxi:4101. */
export async function ensureToxiproxy(run: string) {
  const name = `rox-${run}-toxi`;
  if (await isRunning(name)) return;
  await startService({
    name,
    run,
    script: "exec toxiproxy-server -host 0.0.0.0 -port 8474",
    mounts: [],
    network: { name: networks(run).stage, alias: "toxi" },
    workdir: "/tmp",
  });
}
