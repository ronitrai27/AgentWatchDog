// What the server checks and warms before its first request, and prints to the console.
// Each check really uses the thing it names; a required one that fails means Rox is not ready.
import { createDockerClient } from "@agent/integrations/docker";
import { db } from "./db";
import { getApp } from "./github-app";
import { rox } from "./rox";

type Check = {
  name: string;
  required: boolean;
  run: (signal: AbortSignal) => Promise<string>;
};

const LIMIT_MS = 8_000;
const NOBODY = "00000000-0000-4000-8000-000000000000";

const CHECKS: Check[] = [
  {
    name: "Graph compiled",
    required: true,
    run: async () =>
      Object.keys(rox().graph.nodes)
        .filter((node) => !node.startsWith("__"))
        .join(" -> "),
  },
  {
    name: "Database ready (web)",
    required: true,
    run: async () => {
      // Opens a few connections so the first page does not wait for them.
      await Promise.all([1, 2, 3].map(() => db().query("SELECT 1")));
      return "role rox_app, 3 connections warm";
    },
  },
  {
    name: "Database ready (agent)",
    required: true,
    run: async () => {
      await rox().store.getSetup(NOBODY);
      return "role rox_agent";
    },
  },
  {
    name: "Agent memory ready",
    required: true,
    run: async () => {
      await rox().graph.getState({
        configurable: { thread_id: "startup-check" },
      });
      return "LangGraph checkpoints in Postgres";
    },
  },
  {
    name: "Key vault ready",
    required: true,
    run: async () => {
      if (!/^[0-9a-f]{64}$/i.test(process.env.ENCRYPTION_KEY ?? ""))
        throw new Error("ENCRYPTION_KEY must be 64 hex characters");
      return "ENCRYPTION_KEY is valid";
    },
  },
  {
    name: "GitHub App ready",
    required: false,
    run: async () => (await getApp()).slug,
  },
  {
    name: "Sandbox engine ready",
    required: false,
    run: async (signal) => {
      const docker = await createDockerClient().status(signal);
      return `Docker ${docker.serverVersion}, ${docker.cpus} CPUs`;
    },
  },
  {
    name: "Groq ready",
    required: false,
    run: async (signal) => {
      const key = process.env.GROQ_API_KEY;
      if (!key) throw new Error("GROQ_API_KEY is not set");
      const res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { authorization: `Bearer ${key}` },
        signal,
      });
      if (!res.ok) throw new Error(`Groq answered ${res.status}`);
      return process.env.GROQ_MODEL || "openai/gpt-oss-120b";
    },
  },
];

async function runCheck(check: Check) {
  const started = performance.now();
  const signal = AbortSignal.timeout(LIMIT_MS);
  const late = new Promise<never>((_, reject) =>
    signal.addEventListener("abort", () =>
      reject(new Error(`no answer in ${LIMIT_MS / 1000}s`)),
    ),
  );
  late.catch(() => {});
  let ok = true;
  let detail: string;
  try {
    detail = await Promise.race([check.run(signal), late]);
  } catch (error) {
    ok = false;
    detail = error instanceof Error ? error.message : String(error);
  }
  return { ...check, ok, detail, ms: Math.round(performance.now() - started) };
}

export async function startRox(): Promise<void> {
  const started = performance.now();
  console.log("\n  Rox: checking the system...");
  // The graph first: everything else belongs to it.
  const [graph, ...rest] = CHECKS;
  const results = [
    await runCheck(graph),
    ...(await Promise.all(rest.map(runCheck))),
  ];
  for (const r of results)
    console.log(
      `  ${r.ok ? "✓" : r.required ? "✗" : "!"} ${r.name.padEnd(24)} ${r.detail} (${r.ms} ms)`,
    );
  const broken = results.filter((r) => r.required && !r.ok);
  const total = Math.round(performance.now() - started);
  console.log(
    broken.length === 0
      ? `  ✓ Agent ready in ${total} ms\n`
      : `  ✗ Agent NOT ready: ${broken.map((r) => r.name).join(", ")}\n`,
  );
}
