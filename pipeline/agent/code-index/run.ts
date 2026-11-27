// Runs the indexer inside the sandbox. The indexer and the pinned `typescript` package go in as a
// small tar on stdin, so the shared sandbox image and its tools stay exactly as they are. The
// sandbox has no network, a read-only copy of the code, and the usual limits.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable } from "node:stream";
import { type Mount, sandbox } from "../../src/docker";
import { labDir } from "../../src/env";
import type { Index } from "./indexer.mts";

const HERE = path.join(labDir, "Agent_2", "code-index");
const SPLIT = "\n@@ROX-BASE@@\n";

let bundle: Buffer | null = null;

/** indexer.mts + support.mts + node_modules/typescript (package.json, typescript.js, lib.*.d.ts). */
function payload(): Buffer {
  if (bundle) return bundle;
  const tsDir = path.dirname(
    createRequire(path.join(labDir, "package.json")).resolve(
      "typescript/package.json",
    ),
  );
  const files: [string, Buffer][] = [
    ["indexer.mts", readFileSync(path.join(HERE, "indexer.mts"))],
    ["support.mts", readFileSync(path.join(HERE, "support.mts"))],
    [
      "node_modules/typescript/package.json",
      readFileSync(path.join(tsDir, "package.json")),
    ],
    [
      "node_modules/typescript/lib/typescript.js",
      readFileSync(path.join(tsDir, "lib", "typescript.js")),
    ],
    ...readdirSync(path.join(tsDir, "lib"))
      .filter((f) => /^lib\..*\.d\.ts$/.test(f))
      .map(
        (f) =>
          [
            `node_modules/typescript/lib/${f}`,
            readFileSync(path.join(tsDir, "lib", f)),
          ] as [string, Buffer],
      ),
  ];
  bundle = tar(files);
  return bundle;
}

/** A minimal ustar archive (regular files only). */
function tar(files: [string, Buffer][]): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, data] of files) {
    const h = Buffer.alloc(512);
    const put = (s: string, at: number, len: number) =>
      h.write(s.slice(0, len), at, len, "utf8");
    const octal = (n: number, len: number) =>
      `${n.toString(8).padStart(len - 1, "0")}\0`;
    if (Buffer.byteLength(name) > 100)
      throw new Error(`tar name too long: ${name}`);
    put(name, 0, 100);
    put(octal(0o644, 8), 100, 8);
    put(octal(0, 8), 108, 8);
    put(octal(0, 8), 116, 8);
    put(octal(data.length, 12), 124, 12);
    put(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
    h.fill(" ", 148, 156);
    put("0", 156, 1);
    put("ustar\0", 257, 6);
    put("00", 263, 2);
    let sum = 0;
    for (const b of h) sum += b;
    put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export type Indexes = { head: Index; base: Index | null; ms: number };

/**
 * Indexes the head copy and, when a base commit is given, the base commit too.
 * @param volume A volume holding the head checkout with its `.git` (the run's installed copy).
 * @param baseVolume An installed copy of the base, when the run has one; otherwise the base is
 *   taken from git history and borrows the head's node_modules for types.
 */
export async function indexInSandbox(o: {
  run: string;
  volume: string;
  baseRef: string | null;
  baseVolume?: string | null;
  signal?: AbortSignal;
  maxFiles?: number;
}): Promise<Indexes> {
  if (o.baseRef && !/^[0-9a-f]{7,40}$/.test(o.baseRef))
    throw new Error("the base must be a commit id");
  const mounts: Mount[] = [{ volume: o.volume, at: "/repo", readOnly: true }];
  if (o.baseVolume)
    mounts.push({ volume: o.baseVolume, at: "/base", readOnly: true });
  const max = String(o.maxFiles ?? 8000);
  const script = `set -e
mkdir -p /tmp/ci && tar -x -C /tmp/ci
node /tmp/ci/indexer.mts /repo ${max} > /tmp/head.json
if [ -n "$ROX_BASE" ]; then
  if [ -n "$ROX_BASE_MOUNTED" ]; then B=/base; else
    B=/tmp/base; mkdir -p $B
    git -c safe.directory='*' -C /repo archive "$ROX_BASE" | tar -x -C $B
    (cd /repo && find . -name node_modules -type d -prune -print) | while read -r d; do
      mkdir -p "$B/$(dirname "$d")"; [ -e "$B/$d" ] || ln -s "/repo/$d" "$B/$d"; done
  fi
  node /tmp/ci/indexer.mts $B ${max} > /tmp/base.json
fi
cat /tmp/head.json
if [ -n "$ROX_BASE" ]; then printf '${SPLIT.replaceAll("\n", "\\n")}'; cat /tmp/base.json; fi`;
  const r = await sandbox({
    name: `rox-${o.run}-codeindex`,
    run: o.run,
    script,
    mounts,
    network: "none",
    workdir: "/tmp",
    timeoutMs: 10 * 60_000,
    env: {
      ROX_BASE: o.baseRef ?? "",
      ROX_BASE_MOUNTED: o.baseVolume ? "1" : "",
      NODE_OPTIONS: "--max-old-space-size=2560",
    },
    stdin: Readable.from([payload()]),
    stdoutLimit: 512 * 1024 * 1024,
    signal: o.signal,
  });
  if (r.cancelled) throw new Error("cancelled");
  if (r.code !== 0)
    throw new Error(
      `the code index failed (exit ${r.code}${r.timedOut ? ", timed out" : ""}): ${r.stderr.slice(-600)}`,
    );
  const [head, base] = r.stdout.split(SPLIT);
  return {
    head: JSON.parse(head ?? "") as Index,
    base: base ? (JSON.parse(base) as Index) : null,
    ms: r.ms,
  };
}
