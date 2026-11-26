// The agent's working copy: one long-lived sandbox (same rules as every other: no network, no
// secrets, not root) holding its own copy of the code and dependencies. Tool calls run inside it
// with `docker exec`, which takes a fraction of the time of a new container per call.
import { spawn } from "node:child_process";
import {
  docker,
  ensureVolume,
  isRunning,
  type Mount,
  sandbox,
  startService,
  stopService,
} from "../docker";
import { type JunitCase, junitCases } from "../reports";
import { volumes } from "../source";

export type Exec = {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
};

const nameOf = (run: string, kind: string) => `rox-${run}-${kind}`;
export const agentVolume = (run: string, kind = "agent") =>
  `rox-${kind}-${run}`;

export class Workspace {
  readonly container: string;
  /** Where node_modules folders are, and the installed volume they come from (after open). */
  private modules: { source: string; dirs: string[] } | null = null;
  constructor(
    readonly run: string,
    readonly kind: "agent" | "verify" = "agent",
  ) {
    this.container = nameOf(run, kind);
  }
  get root() {
    return `/${this.kind}`;
  }

  /**
   * Makes a copy of the source (from the installed volume) if it is not there yet, records the
   * starting point as a git commit, and starts the sandbox. Dependencies are mounted read-only,
   * so nothing the agent does can change them. Safe to call again after a crash.
   */
  async open(
    source = volumes(this.run).work,
    prepare = "true",
    env: Record<string, string> = {},
  ): Promise<void> {
    const volume = agentVolume(this.run, this.kind);
    await ensureVolume(volume, this.run);
    const copy = await sandbox({
      name: `${this.container}-copy`,
      run: this.run,
      script: `cd /work && find . -name node_modules -type d -prune | sed 's#^./##' > /tmp/nm
if [ ! -f ${this.root}/.rox-ready ]; then
  find ${this.root} -mindepth 1 -delete 2>/dev/null
  tar -C /work --exclude=node_modules --exclude=.git --exclude=.next --exclude=.stryker-tmp -cf - . | tar -C ${this.root} -xf - && cd ${this.root} && (${prepare})   && while read -r d; do mkdir -p "$d"; done < /tmp/nm   && git init -q && git config user.email rox@localhost && git config user.name rox   && printf '.rox-ready
node_modules
' >> .git/info/exclude && git add -A && git commit -q -m start && touch .rox-ready || exit 1
fi
cat /tmp/nm`,
      mounts: [
        { volume: source, at: "/work", readOnly: true },
        { volume, at: this.root, readOnly: false },
      ],
      network: "none",
      workdir: "/tmp",
      timeoutMs: 5 * 60_000,
      env,
    });
    if (copy.code !== 0)
      throw new Error(
        `could not make the working copy: ${copy.stderr.slice(-300)}`,
      );
    this.modules = {
      source,
      dirs: copy.stdout
        .split(/\r?\n/)
        .map((d) => d.trim())
        .filter(Boolean),
    };
    if (await isRunning(this.container)) return;
    await startService({
      name: this.container,
      run: this.run,
      script: "sleep infinity",
      mounts: [
        { volume, at: this.root, readOnly: false },
        ...copy.stdout
          .split(/\r?\n/)
          .map((d) => d.trim())
          .filter(Boolean)
          .map((d) => ({
            volume: source,
            at: `${this.root}/${d}`,
            readOnly: true,
            subpath: d,
          })),
      ],
      network: "none",
      workdir: this.root,
      env: { CI: "1", NO_COLOR: "1", ROX_ROOT: this.root, NODE_ENV: "test" },
    });
  }

  /** The copy mounted read-only at /app with its dependencies, for running the app itself. */
  appMounts(): Mount[] {
    if (!this.modules) throw new Error("the working copy is not open");
    const { source, dirs } = this.modules;
    return [
      { volume: agentVolume(this.run, this.kind), at: "/app", readOnly: true },
      ...dirs.map((d) => ({
        volume: source,
        at: `/app/${d}`,
        readOnly: true,
        subpath: d,
      })),
    ];
  }

  exec(
    command: string[],
    stdin = "",
    timeoutMs = 60_000,
    limit = 200_000,
  ): Promise<Exec> {
    const started = Date.now();
    return new Promise((resolve) => {
      const seconds = Math.ceil(timeoutMs / 1000);
      const child = spawn(
        "docker",
        [
          "exec",
          "-i",
          this.container,
          "timeout",
          "-k",
          "2",
          String(seconds),
          ...command,
        ],
        { windowsHide: true },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => {
        if (stdout.length < limit) stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        if (stderr.length < 20_000) stderr += d.toString("utf8");
      });
      child.on("error", (e) =>
        resolve({
          code: null,
          stdout,
          stderr: e.message,
          ms: Date.now() - started,
        }),
      );
      child.on("close", (code) =>
        resolve({ code, stdout, stderr, ms: Date.now() - started }),
      );
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    });
  }

  /** One file operation inside the sandbox (see Tests/sandbox/tools.mjs). */
  async file(
    op: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown> & { ok: boolean; error?: string }> {
    const r = await this.exec(
      ["node", "/opt/rox/tools.mjs"],
      JSON.stringify({ op, ...args }),
      20_000,
      400_000,
    );
    try {
      return JSON.parse(r.stdout);
    } catch {
      return {
        ok: false,
        error: `the sandbox did not answer (exit ${r.code}): ${r.stderr.slice(0, 150)}`,
      };
    }
  }

  async patch(): Promise<string> {
    const r = await this.file("diff");
    if (!r.ok) throw new Error(r.error);
    return String(r.patch ?? "");
  }

  /** Runs test files of one workspace (all of them when `files` is empty). */
  async tests(
    ws: string,
    files: string[] = [],
    timeoutMs = 120_000,
  ): Promise<{
    cases: (JunitCase & { message: string })[];
    ok: boolean;
    output: string;
  }> {
    const out = `/tmp/junit-${Math.random().toString(36).slice(2)}.xml`;
    const r = await this.exec(
      [
        "sh",
        "-c",
        `cd "$0" && npx --no-install vitest run "$@" --reporter=junit --outputFile.junit=${out}; code=$?; echo; echo ROX-XML; cat ${out} 2>/dev/null; rm -f ${out}; exit $code`,
        `${this.root}/${ws}`,
        ...files,
      ],
      "",
      timeoutMs,
      2_000_000,
    );
    const xml = r.stdout.split("ROX-XML\n")[1] ?? "";
    const messages = failureMessages(xml);
    return {
      ok: r.code === 0,
      cases: junitCases(xml).map((c) => ({
        ...c,
        message: messages.get(`${c.file}|${c.name}`) ?? "",
      })),
      output: `${r.stdout.split("ROX-XML\n")[0] ?? ""}${r.stderr}`.slice(-3000),
    };
  }

  async close(): Promise<void> {
    await stopService(this.container);
    await docker([
      "volume",
      "rm",
      "-f",
      agentVolume(this.run, this.kind),
    ]).catch(() => "");
  }
}

const decode = (s: string) =>
  s
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

/** The failure text of each failing test case, shortened. */
function failureMessages(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(
    /<testcase\b([^>]*[^/])>([\s\S]*?)<\/testcase>/g,
  )) {
    const attrs = m[1] ?? "";
    const body = /<failure\b[^>]*>([\s\S]*?)<\/failure>/.exec(m[2] ?? "")?.[1];
    if (!body) continue;
    const file = decode(/\bclassname="([^"]*)"/.exec(attrs)?.[1] ?? "");
    const name = decode(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? "");
    out.set(
      `${file}|${name}`,
      decode(body)
        // biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal colours
        .replace(/\x1b\[[0-9;]*m/g, "")
        .trim()
        .slice(0, 900),
    );
  }
  return out;
}
