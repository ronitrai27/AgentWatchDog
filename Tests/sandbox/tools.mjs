// The agent's file tools, running inside the sandbox. One JSON request on stdin, one JSON answer
// on stdout. Every path is resolved (links included) and must stay inside the working copy.
// What may be edited is decided outside, on the host (Tests/src/agent/policy.ts).
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const ROOT = realpathSync(process.env.ROX_ROOT ?? "/agent");
const SKIP = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "coverage",
  ".stryker-tmp",
  "data",
]);

class Refused extends Error {}

function inside(p, mustExist = true) {
  const clean = String(p ?? ".")
    .replace(/^\/agent\/?/, "")
    .replace(/^\.\//, "");
  if (path.isAbsolute(clean) || clean.split("/").includes(".."))
    throw new Refused(
      `${p} is outside the repository. Use a path like apps/api/src/app.ts`,
    );
  if (clean.split("/").some((s) => s === "node_modules" || s === ".git"))
    throw new Refused(`${p} is not part of the source`);
  const full = path.join(ROOT, clean);
  if (!existsSync(full)) {
    if (mustExist)
      throw new Refused(
        `${clean} does not exist. Use list_files or search_code to find it`,
      );
    return full;
  }
  const real = realpathSync(full);
  if (real !== ROOT && !real.startsWith(ROOT + path.sep))
    throw new Refused(`${clean} links outside the repository`);
  return real;
}

const git = (...args) =>
  execFileSync("git", ["-c", "safe.directory=*", "-C", ROOT, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });

const ops = {
  list({ dir = "." }) {
    const out = [];
    const walk = (d, depth) => {
      for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (SKIP.has(e.name) || out.length >= 200) continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          if (depth > 0) walk(full, depth - 1);
          else out.push(`${path.relative(ROOT, full)}/`);
        } else out.push(path.relative(ROOT, full));
      }
    };
    walk(inside(dir), 4);
    return { files: out };
  },

  search({ text, dir = "." }) {
    let found = "";
    try {
      found = execFileSync(
        "grep",
        [
          "-rnIF",
          "--include=*.ts",
          "--include=*.tsx",
          "--include=*.js",
          "--include=*.mjs",
          "--include=*.json",
          "--include=*.sql",
          ...[...SKIP].map((d) => `--exclude-dir=${d}`),
          "--exclude=package-lock.json",
          "--",
          String(text),
          inside(dir),
        ],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 10_000 },
      );
    } catch (e) {
      if (e.status !== 1) throw new Refused("the search failed");
    }
    const lines = found
      .split("\n")
      .filter(Boolean)
      .map((l) => l.replace(`${ROOT}/`, "").slice(0, 180));
    return {
      matches: lines.slice(0, 30),
      more: Math.max(0, lines.length - 30),
    };
  },

  read({ path: p, from = 1, to }) {
    const full = inside(p);
    if (!lstatSync(full).isFile())
      throw new Refused(`${p} is a folder; use list_files`);
    const lines = readFileSync(full, "utf8").split("\n");
    const start = Math.max(1, Number(from) || 1);
    const end = Math.min(lines.length, Number(to) || start + 149, start + 149);
    return {
      path: path.relative(ROOT, full),
      lines: lines.length,
      text: lines
        .slice(start - 1, end)
        .map((l, i) => `${start + i}\t${l.slice(0, 300)}`)
        .join("\n"),
    };
  },

  edit({ path: p, old_text, new_text }) {
    const full = inside(p);
    const before = readFileSync(full, "utf8");
    // Models often paste read_file's line numbers or Windows line ends; neither is in the file.
    const clean = (t) =>
      String(t ?? "")
        .replace(/\r\n/g, "\n")
        .replace(/^[ \t]*\d+\t/gm, "");
    const oldText = clean(old_text);
    const newText = clean(new_text);
    if (!oldText.trim()) throw new Refused("old_text is empty");
    const count = before.split(oldText).length - 1;
    if (count > 1)
      throw new Refused(
        `old_text appears ${count} times. Include more surrounding lines so it is unique`,
      );
    if (count === 1) {
      writeFileSync(
        full,
        before.replace(oldText, () => newText),
      );
      return { edited: path.relative(ROOT, full) };
    }
    // Not exact: the same lines with different indentation, if that is unique.
    const lines = before.split("\n");
    const want = oldText.split("\n").map((l) => l.trim());
    while (want.length && !want[0]) want.shift();
    while (want.length && !want.at(-1)) want.pop();
    const hits = [];
    for (let i = 0; i + want.length <= lines.length; i++)
      if (want.every((w, k) => lines[i + k].trim() === w)) hits.push(i);
    if (hits.length === 1) {
      const at = hits[0];
      const fileIndent = lines[at].match(/^\s*/)[0];
      const newLines = newText.replace(/^\n+|\n+$/g, "").split("\n");
      const ownIndent = (newLines.find((l) => l.trim()) ?? "").match(/^\s*/)[0];
      const shifted = newLines.map((l) =>
        l.trim()
          ? fileIndent +
            (l.startsWith(ownIndent)
              ? l.slice(ownIndent.length)
              : l.trimStart())
          : l,
      );
      lines.splice(at, want.length, ...shifted);
      writeFileSync(full, lines.join("\n"));
      return {
        edited: path.relative(ROOT, full),
        note: `matched lines ${at + 1}-${at + want.length} ignoring indentation`,
      };
    }
    if (hits.length > 1)
      throw new Refused(
        `old_text appears ${hits.length} times. Include more surrounding lines so it is unique`,
      );
    // Show the real lines that look like what was meant, so the next try can copy them.
    const key = want.find((w) => w.length > 4) ?? "";
    const probe = key.slice(0, 24);
    const near = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => probe && l.includes(probe))
      .slice(0, 3)
      .map(({ l, i }) => `line ${i + 1}: ${JSON.stringify(l)}`);
    throw new Refused(
      `old_text was not found. Copy it exactly from read_file, without the line numbers.${near.length ? ` Lines that look similar:\n${near.join("\n")}` : ""}`,
    );
  },

  diff() {
    git("add", "-A", "-N");
    return { patch: git("diff", "--no-color", "--no-ext-diff", "HEAD") };
  },

  reset() {
    git("checkout", "-q", "-f", "HEAD");
    git("clean", "-fdq");
    return { reset: true };
  },
};

let input = "";
for await (const chunk of process.stdin) input += chunk;
try {
  const { op, ...args } = JSON.parse(input);
  const run = ops[op];
  if (!run) throw new Refused(`no such operation: ${op}`);
  console.log(JSON.stringify({ ok: true, ...run(args) }));
} catch (error) {
  const message =
    error instanceof Refused
      ? error.message
      : `the tool failed: ${String(error.message).slice(0, 200)}`;
  console.log(JSON.stringify({ ok: false, error: message }));
}
