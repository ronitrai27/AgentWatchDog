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
  const clean = String(p ?? ".").replace(/^\/agent\/?/, "").replace(/^\.\//, "");
  if (path.isAbsolute(clean) || clean.split("/").includes(".."))
    throw new Refused(`${p} is outside the repository. Use a path like apps/api/src/app.ts`);
  if (clean.split("/").some((s) => s === "node_modules" || s === ".git"))
    throw new Refused(`${p} is not part of the source`);
  const full = path.join(ROOT, clean);
  if (!existsSync(full)) {
    if (mustExist) throw new Refused(`${clean} does not exist. Use list_files or search_code to find it`);
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
      for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
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
        ["-rnIF", "--include=*.ts", "--include=*.tsx", "--include=*.js", "--include=*.mjs", "--include=*.json", "--include=*.sql",
          ...[...SKIP].map((d) => `--exclude-dir=${d}`), "--exclude=package-lock.json", "--", String(text), inside(dir)],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 10_000 },
      );
    } catch (e) {
      if (e.status !== 1) throw new Refused("the search failed");
    }
    const lines = found.split("\n").filter(Boolean).map((l) => l.replace(`${ROOT}/`, "").slice(0, 180));
    return { matches: lines.slice(0, 30), more: Math.max(0, lines.length - 30) };
  },

  read({ path: p, from = 1, to }) {
    const full = inside(p);
    if (!lstatSync(full).isFile()) throw new Refused(`${p} is a folder; use list_files`);
    const lines = readFileSync(full, "utf8").split("\n");
    const start = Math.max(1, Number(from) || 1);
    const end = Math.min(lines.length, Number(to) || start + 149, start + 149);
    return {
      path: path.relative(ROOT, full),
      lines: lines.length,
      text: lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l.slice(0, 300)}`).join("\n"),
    };
  },

  edit({ path: p, old_text, new_text }) {
    const full = inside(p);
    const before = readFileSync(full, "utf8");
    if (!old_text) throw new Refused("old_text is empty");
    const count = before.split(old_text).length - 1;
    if (count === 0)
      throw new Refused("old_text was not found. Copy it exactly from read_file, without the line numbers");
    if (count > 1)
      throw new Refused(`old_text appears ${count} times. Include more surrounding lines so it is unique`);
    writeFileSync(full, before.split(old_text).join(new_text));
    return { edited: path.relative(ROOT, full) };
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
  const message = error instanceof Refused ? error.message : `the tool failed: ${String(error.message).slice(0, 200)}`;
  console.log(JSON.stringify({ ok: false, error: message }));
}
