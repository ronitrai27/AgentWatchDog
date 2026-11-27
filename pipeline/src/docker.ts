// The only code that talks to Docker. Every sandbox it starts follows the same rules:
// no route to the internet, no secrets, no privileges, a read-only root, a non-root user, hard
// limits on CPU, memory, processes and time, and it is removed when the run ends.
import { execFile, spawn } from "node:child_process";
import type { Readable } from "node:stream";

export const IMAGE = "rox-sandbox:1";
export const USER = "10001:10001";
export const LIMITS = {
  cpus: "2",
  memory: "3g",
  pids: 1024,
  tmp: "1g",
};
/** The most output kept in memory per stream. The rest is cut from the front. */
const TAIL = 64 * 1024;

export type Mount = {
  volume: string;
  at: string;
  readOnly: boolean;
  /** Only this folder of the volume. */
  subpath?: string;
};

/**
 * "none": no network at all (every check that does not need the running app).
 * A named network: one created by `createNetwork` with `--internal`, so it has no route out.
 * Only the egress proxy is ever put on Docker's normal network.
 */
export type Network = "none" | { name: string; alias?: string };

export type SandboxCommand = {
  /** Docker container name. The same name twice replaces a stale container from a crash. */
  name: string;
  /** The run it belongs to; everything labelled with it is destroyed together. */
  run: string;
  script: string;
  mounts: Mount[];
  network: Network;
  workdir: string;
  timeoutMs: number;
  /** The only environment the sandbox gets. Never secrets. */
  env?: Record<string, string>;
  signal?: AbortSignal;
  stdin?: Readable;
  /** Keep the whole stdout up to this size instead of only its tail (for copying reports out). */
  stdoutLimit?: number;
};

export type SandboxResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
  cancelled: boolean;
};

export function docker(args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) =>
        error
          ? reject(
              new Error(`docker ${args[0]}: ${stderr.trim() || error.message}`),
            )
          : resolve(stdout),
    );
  });
}

const tail = (text: string) => (text.length > TAIL ? text.slice(-TAIL) : text);
const labels = (run?: string) => [
  "--label",
  "rox.lab=1",
  ...(run ? ["--label", `rox.run=${run}`] : []),
];

export async function ensureVolume(name: string, run?: string) {
  await docker(["volume", "create", ...labels(run), name]);
}

/** An internal network: containers on it reach each other and nothing else. */
export async function createNetwork(name: string, run: string) {
  const exists = await docker(["network", "inspect", name])
    .then(() => true)
    .catch(() => false);
  if (!exists)
    await docker(["network", "create", "--internal", ...labels(run), name]);
}

/** The flags every sandbox gets. Exported so the isolation proof checks the very same ones. */
export function sandboxFlags(c: SandboxCommand): string[] {
  const network =
    c.network === "none"
      ? ["--network", "none"]
      : [
          "--network",
          c.network.name,
          ...(c.network.alias ? ["--network-alias", c.network.alias] : []),
        ];
  return [
    "--name",
    c.name,
    "--rm",
    ...labels(c.run),
    ...network,
    "--read-only",
    "--tmpfs",
    `/tmp:rw,exec,nosuid,size=${LIMITS.tmp}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    USER,
    "--pids-limit",
    String(LIMITS.pids),
    "--cpus",
    LIMITS.cpus,
    "--memory",
    LIMITS.memory,
    "--memory-swap",
    LIMITS.memory,
    "--workdir",
    c.workdir,
    ...c.mounts.flatMap((m) =>
      m.subpath
        ? [
            "--mount",
            `type=volume,src=${m.volume},dst=${m.at},volume-subpath=${m.subpath}${m.readOnly ? ",readonly" : ""}`,
          ]
        : ["-v", `${m.volume}:${m.at}${m.readOnly ? ":ro" : ""}`],
    ),
    ...Object.entries(c.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
  ];
}

const CANCELLED: SandboxResult = {
  code: null,
  stdout: "",
  stderr: "",
  ms: 0,
  timedOut: false,
  cancelled: true,
};

/** Runs one command in a fresh sandbox and removes it. Never throws for a failing command. */
export async function sandbox(c: SandboxCommand): Promise<SandboxResult> {
  // A cancelled run starts nothing new. (Docker would also re-create a deleted volume.)
  if (c.signal?.aborted) return CANCELLED;
  await docker(["rm", "-f", c.name]).catch(() => {});
  const started = Date.now();
  const args = [
    "run",
    ...(c.stdin ? ["-i"] : []),
    ...sandboxFlags(c),
    IMAGE,
    "sh",
    "-c",
    c.script,
  ];
  return new Promise((resolve) => {
    const child = spawn("docker", args, {
      windowsHide: true,
      stdio: [c.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    const kill = () => void docker(["kill", c.name]).catch(() => {});
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, c.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    c.signal?.addEventListener("abort", onAbort, { once: true });
    if (c.signal?.aborted) onAbort();

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
      if (!c.stdoutLimit) stdout = tail(stdout);
      else if (stdout.length > c.stdoutLimit) kill();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr = tail(stderr + d.toString("utf8"));
    });
    if (c.stdin && child.stdin) c.stdin.pipe(child.stdin);
    child.on("close", (code) => {
      clearTimeout(timer);
      c.signal?.removeEventListener("abort", onAbort);
      resolve({
        code,
        stdout,
        stderr,
        ms: Date.now() - started,
        timedOut,
        cancelled,
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        code: null,
        stdout,
        stderr: `could not start docker: ${error.message}`,
        ms: Date.now() - started,
        timedOut,
        cancelled,
      });
    });
  });
}

/**
 * Starts a long-running sandbox (the app under test, Toxiproxy) with the same rules, and returns
 * at once. Stopped by `destroyRun`, or by `stopService`.
 */
export async function startService(
  c: Omit<SandboxCommand, "timeoutMs" | "stdin" | "stdoutLimit" | "signal">,
) {
  await docker(["rm", "-f", c.name]).catch(() => {});
  await docker([
    "run",
    "-d",
    ...sandboxFlags({ ...c, timeoutMs: 0 }),
    IMAGE,
    "sh",
    "-c",
    c.script,
  ]);
}

export async function isRunning(name: string): Promise<boolean> {
  return docker(["inspect", "-f", "{{.State.Running}}", name])
    .then((out) => out.trim() === "true")
    .catch(() => false);
}

export async function serviceLogs(name: string, lines = 40): Promise<string> {
  return docker(["logs", "--tail", String(lines), name])
    .then((out) => out)
    .catch((e: Error) => e.message);
}

export const stopService = (name: string) =>
  docker(["rm", "-f", name]).catch(() => "");

/**
 * The egress proxy: the only container on Docker's normal network. It joins the run's install
 * network so the dependency install can reach the allowed registry through it, and nothing else.
 */
export async function startEgress(run: string, installNetwork: string) {
  const name = `rox-${run}-egress`;
  await docker(["rm", "-f", name]).catch(() => {});
  await docker([
    "run",
    "-d",
    "--name",
    name,
    ...labels(run),
    "--network",
    "bridge",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    USER,
    "--pids-limit",
    "256",
    "--cpus",
    "1",
    "--memory",
    "256m",
    "-e",
    "EGRESS_ALLOW=registry.npmjs.org",
    IMAGE,
    "node",
    "/opt/rox/egress-proxy.mjs",
  ]);
  await docker([
    "network",
    "connect",
    "--alias",
    "egress",
    installNetwork,
    name,
  ]);
  return name;
}

/** Removes every container, network and volume of a run. Safe to call more than once. */
export async function destroyRun(run: string): Promise<{
  containers: number;
  volumes: number;
  networks: number;
  /** What was removed, by name (the kill switch lists each in the trace). */
  names: { containers: string[]; networks: string[]; volumes: string[] };
}> {
  const filter = `label=rox.run=${run}`;
  const list = async (args: string[]) =>
    (await docker([...args, "--filter", filter])).split("\n").filter(Boolean);
  const containers = await list(["ps", "-a", "--format", "{{.Names}}"]);
  if (containers.length)
    await docker(["rm", "-f", ...containers]).catch(() => {});
  const networks = await list(["network", "ls", "--format", "{{.Name}}"]);
  if (networks.length)
    await docker(["network", "rm", ...networks]).catch(() => {});
  const volumes = await list(["volume", "ls", "-q"]);
  if (volumes.length)
    await docker(["volume", "rm", "-f", ...volumes]).catch(() => {});
  return {
    containers: containers.length,
    volumes: volumes.length,
    networks: networks.length,
    names: { containers, networks, volumes },
  };
}
