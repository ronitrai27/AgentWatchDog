// Read-only git on the host checkout: what changed, the changed lines, the file list and file
// contents at a commit. Nothing here runs the repository's code.
import { execFile } from "node:child_process";
import type { FileChange } from "./gate";

function git(dir: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      "git",
      [
        "-c",
        "core.quotepath=off",
        "-c",
        "safe.directory=*",
        "-C",
        dir,
        ...args,
      ],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) =>
        error
          ? reject(
              new Error(`git ${args[0]}: ${stderr.trim() || error.message}`),
            )
          : resolve(stdout),
    ),
  );
}

/** Files the change touched, with their status, renames followed. */
export async function changesBetween(
  dir: string,
  base: string,
  head: string,
): Promise<FileChange[]> {
  const out = await git(dir, ["diff", "--name-status", "-M", "-z", base, head]);
  const parts = out.split("\0").filter((p) => p !== "");
  const changes: FileChange[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++] ?? "";
    const status = code[0] as FileChange["status"];
    if (status === "R" || status === "C") {
      const from = parts[i++] ?? "";
      const to = parts[i++] ?? "";
      changes.push({ status, path: to, from });
    } else changes.push({ status, path: parts[i++] ?? "" });
  }
  return changes;
}

/** Changed line numbers per file: added/changed lines in head, removed/changed lines in base. */
export type Hunks = Map<
  string,
  { head: number[]; base: number[]; from: string }
>;

export async function changedLines(
  dir: string,
  base: string,
  head: string,
): Promise<Hunks> {
  const out = await git(dir, [
    "diff",
    "-U0",
    "-M",
    "--no-color",
    "--no-ext-diff",
    base,
    head,
  ]);
  const hunks: Hunks = new Map();
  let cur: { head: number[]; base: number[]; from: string } | null = null;
  let from = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("--- ")) from = line.slice(4).replace(/^a\//, "");
    else if (line.startsWith("+++ ")) {
      const to = line.slice(4).replace(/^b\//, "");
      const key = to === "/dev/null" ? from : to;
      cur = { head: [], base: [], from: from === "/dev/null" ? key : from };
      hunks.set(key, cur);
    } else if (line.startsWith("@@") && cur) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const [bs, bc, hs, hc] = [m[1], m[2] ?? "1", m[3], m[4] ?? "1"].map(
        Number,
      ) as [number, number, number, number];
      for (let i = 0; i < bc; i++) cur.base.push(bs + i);
      for (let i = 0; i < hc; i++) cur.head.push(hs + i);
      // A pure insertion still touches the line it was inserted after (and before).
      if (hc === 0) cur.head.push(Math.max(1, hs), hs + 1);
      if (bc === 0) cur.base.push(Math.max(1, bs), bs + 1);
    }
  }
  return hunks;
}

/** Every file at a commit. */
export async function filesAt(dir: string, ref: string): Promise<string[]> {
  const out = await git(dir, ["ls-tree", "-r", "-z", "--name-only", ref]);
  return out.split("\0").filter(Boolean);
}

/** One file at a commit, or null when it does not exist there. */
export async function fileAt(
  dir: string,
  ref: string,
  file: string,
): Promise<string | null> {
  return git(dir, ["show", `${ref}:${file}`]).catch(() => null);
}

export const resolveRef = async (dir: string, ref: string) =>
  (await git(dir, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
