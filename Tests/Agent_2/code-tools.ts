// U5: better code tools for the agents, read-only, every answer capped.
//   search_code      text or regex, whole word, case, folder, file glob, context lines, every JS/TS
//                    extension plus JSON, SQL, YAML, Markdown, GraphQL, Prisma, CSS, HTML
//   find_symbol      where a function, class, type or constant is defined
//   outline_file     the symbols of a file with their lines
//   find_references  every use of a symbol, tagged call / value / import / type / implements
//   reach            callers to depth 2, the routes it sits on, and whether it runs for every route
// search_code runs inside the agent's sandbox (the working copy, edits included). The other four
// read the run's code index (U2), built from the head commit before the agents start: they do not
// see the agent's own edits, and say so.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { type ToolRuntime, tool } from "@langchain/core/tools";
import * as z from "zod";
import { runDir } from "../src/env";
import type { Index, Sym } from "./code-index/indexer.mts";
import { computeReach } from "./reach";
import type { AgentContext } from "./tools";

type Run = ToolRuntime<unknown, typeof AgentContext>;

// --- the index, loaded once per run

const cache = new Map<string, { mtime: number; index: Index }>();
async function indexOf(run: string): Promise<Index | null> {
  const file = path.join(runDir(run), "agent2", "index-head.json");
  try {
    const m = (await stat(file)).mtimeMs;
    const hit = cache.get(run);
    if (hit && hit.mtime === m) return hit.index;
    const index = JSON.parse(await readFile(file, "utf8")) as Index;
    cache.set(run, { mtime: m, index });
    return index;
  } catch {
    return null;
  }
}
const NO_INDEX =
  "REFUSED: there is no code index for this run (it could not be built). Use search_code and read_file instead.";
const NOTE =
  "(from the code index of the head commit; your own edits are not in it)";

/** Finds symbols by exact id, by name, or by the last part of a qualified name. */
function lookup(index: Index, q: string): Sym[] {
  const exact = index.symbols.filter((s) => s.id === q);
  if (exact.length) return exact;
  const name = q.includes("#") ? (q.split("#")[1] ?? q) : q;
  const file = q.includes("#") ? q.split("#")[0] : null;
  return index.symbols.filter(
    (s) =>
      s.kind !== "module" &&
      (s.name === name || s.name.endsWith(`.${name}`)) &&
      (!file || s.file === file),
  );
}
const show = (s: Sym) =>
  `${s.id}  (${s.kind}${s.exported ? ", exported" : ""}) ${s.file}:${s.start}-${s.end}`;

export const findSymbol = tool(
  async ({ name }, rt: Run) => {
    const index = await indexOf(rt.context.run);
    if (!index) return NO_INDEX;
    const found = lookup(index, name);
    if (!found.length)
      return `No symbol named "${name}". Try search_code, or a shorter name.`;
    return `${found.slice(0, 15).map(show).join("\n")}${found.length > 15 ? `\n(${found.length - 15} more)` : ""}\n${NOTE}`;
  },
  {
    name: "find_symbol",
    description:
      "Where a function, method, class, type or constant is defined. Give a name (such as requireRole) or a full id (file#name).",
    schema: z.object({ name: z.string().min(1) }),
  },
);

export const outlineFile = tool(
  async ({ path: file }, rt: Run) => {
    const index = await indexOf(rt.context.run);
    if (!index) return NO_INDEX;
    const syms = index.symbols
      .filter((s) => s.file === file && s.kind !== "module")
      .sort((a, b) => a.start - b.start);
    if (!syms.length)
      return index.files.includes(file)
        ? `${file} declares no named symbols.`
        : `${file} is not a JavaScript/TypeScript file in the index.`;
    const routes = index.routes
      .filter((r) => r.file === file)
      .map((r) => `  route ${r.method} ${r.path} (line ${r.line})`);
    return `${file}\n${syms
      .slice(0, 80)
      .map(
        (s) =>
          `  ${s.start}-${s.end} ${s.kind} ${s.name}${s.exported ? " (exported)" : ""}`,
      )
      .join(
        "\n",
      )}${routes.length ? `\n${routes.slice(0, 30).join("\n")}` : ""}\n${NOTE}`;
  },
  {
    name: "outline_file",
    description:
      "The functions, classes, types and routes a file declares, with their line numbers. Cheaper than reading the whole file.",
    schema: z.object({
      path: z.string().describe("Path from the repository root"),
    }),
  },
);

export const findReferences = tool(
  async ({ symbol }, rt: Run) => {
    const index = await indexOf(rt.context.run);
    if (!index) return NO_INDEX;
    const targets = lookup(index, symbol);
    if (!targets.length)
      return `No symbol named "${symbol}". Use find_symbol first.`;
    if (targets.length > 1 && !symbol.includes("#"))
      return `"${symbol}" names ${targets.length} symbols; ask again with one id:\n${targets.slice(0, 10).map(show).join("\n")}`;
    const ids = new Set(targets.map((t) => t.id));
    const symFile = new Map(index.symbols.map((s) => [s.id, s.file]));
    const refs = index.edges.filter((e) => ids.has(e.to));
    const byTag = (t: string) => refs.filter((e) => e.tag === t);
    const lines = ["call", "value", "implements", "import", "type"].flatMap(
      (t) =>
        byTag(t).length
          ? [
              `${t}:`,
              ...byTag(t)
                .slice(0, 25)
                .map(
                  (e) =>
                    `  ${e.from}  (${symFile.get(e.from) ?? ""}:${e.line})`,
                ),
            ]
          : [],
    );
    const inRoutes = index.routes.filter(
      (r) =>
        [...r.handler.symbols, ...r.handler.uses].some((x) => ids.has(x)) ||
        r.middleware.some((m) =>
          [...m.symbols, ...m.uses].some((x) => ids.has(x)),
        ),
    );
    return `${[...ids].join(", ")}: ${refs.length} references\n${lines.join("\n") || "  none found"}${
      inRoutes.length
        ? `\nused directly by routes:\n${inRoutes
            .slice(0, 20)
            .map((r) => `  ${r.method} ${r.path}`)
            .join("\n")}`
        : ""
    }\n${NOTE}`;
  },
  {
    name: "find_references",
    description:
      "Every place that uses a symbol, grouped as call, value (passed or stored), implements, import and type. Follows imports, re-exports and functions passed as arguments.",
    schema: z.object({
      symbol: z.string().min(1).describe("A name or a full id (file#name)"),
    }),
  },
);

export const reachTool = tool(
  async ({ target }, rt: Run) => {
    const index = await indexOf(rt.context.run);
    if (!index) return NO_INDEX;
    const isFile = index.files.includes(target);
    const syms = isFile
      ? index.symbols.filter((s) => s.file === target && s.kind !== "module")
      : lookup(index, target);
    if (!syms.length) return `Nothing named "${target}" in the index.`;
    if (!isFile && syms.length > 1 && !target.includes("#"))
      return `"${target}" names ${syms.length} symbols; ask again with one id:\n${syms.slice(0, 10).map(show).join("\n")}`;
    const hunks = new Map<
      string,
      { head: number[]; base: number[]; from: string }
    >();
    for (const s of syms) {
      const h = hunks.get(s.file) ?? { head: [], base: [], from: s.file };
      for (let l = s.start; l <= s.end; l++) h.head.push(l);
      hunks.set(s.file, h);
    }
    const r = computeReach(
      index,
      null,
      [...hunks.keys()].map((p) => ({ status: "M" as const, path: p })),
      hunks,
    );
    return [
      `If ${target} changes:`,
      `callers (depth 2): ${r.callers.length}`,
      ...r.callers.slice(0, 20).map((c) => `  ${c.depth} ${c.id}`),
      `runs for every route: ${r.global ? `yes (${r.globalWhy.slice(0, 2).join("; ")})` : "no"}`,
      `routes reached: ${r.routes.length}`,
      ...r.routes.slice(0, 25).map((x) => `  ${x.method} ${x.path} (${x.why})`),
      ...(r.routesUnknown
        ? [`routes not fully known: ${r.unknownWhy.slice(0, 3).join("; ")}`]
        : []),
      NOTE,
    ].join("\n");
  },
  {
    name: "reach",
    description:
      "What a symbol or file affects: who calls it (two levels up), which HTTP routes run it, and whether it runs for every route.",
    schema: z.object({
      target: z
        .string()
        .min(1)
        .describe("A symbol name, a full id (file#name), or a file path"),
    }),
  },
);

// --- search_code, inside the sandbox

/** Runs in the agent's sandbox with `node -e`; reads one JSON request on stdin. */
const SEARCH = String.raw`
const fs = require("node:fs"), path = require("node:path");
const ROOT = fs.realpathSync(process.env.ROX_ROOT || "/agent");
const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", "out", "coverage", ".turbo", ".stryker-tmp", ".cache"]);
const EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|sql|ya?ml|md|mdx|graphql|gql|prisma|css|scss|html|env\.example|toml)$/i;
let input = ""; process.stdin.on("data", (d) => input += d).on("end", () => {
  const out = (o) => process.stdout.write(JSON.stringify(o));
  try {
    const a = JSON.parse(input);
    const dir = String(a.dir || ".").replace(/^\.\/?/, "") || ".";
    if (path.isAbsolute(dir) || dir.split("/").includes("..")) return out({ ok: false, error: "the folder must be inside the repository" });
    const start = path.join(ROOT, dir);
    if (!fs.existsSync(start)) return out({ ok: false, error: dir + " does not exist" });
    if (!fs.realpathSync(start).startsWith(ROOT)) return out({ ok: false, error: "the folder links outside the repository" });
    const esc = (s) => s.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
    let src = a.regex ? a.pattern : esc(a.pattern);
    if (a.word) src = "\\b(?:" + src + ")\\b";
    let re; try { re = new RegExp(src, a.case_sensitive ? "" : "i"); } catch (e) { return out({ ok: false, error: "bad regex: " + e.message }); }
    const glob = a.glob ? new RegExp("(^|/)" + a.glob.split("**").map((p) => p.split("*").map(esc).join("[^/]*").replace(/\\\?/g, "[^/]")).join(".*") + "$") : null;
    const ctx = Math.max(0, Math.min(3, a.context | 0));
    const hits = []; let more = 0, files = 0;
    const scan = (full) => {
      const rel = path.relative(ROOT, full).split(path.sep).join("/");
      if (!EXT.test(full) || (glob && !glob.test(rel))) return;
      let text; try { if (fs.statSync(full).size > 1000000) return; text = fs.readFileSync(full, "utf8"); } catch { return; }
      files++;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        if (hits.length >= 40) { more++; continue; }
        const block = [];
        for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++)
          block.push(rel + (j === i ? ":" : "-") + (j + 1) + (j === i ? ":" : "-") + lines[j].slice(0, 200));
        hits.push(block.join("\n"));
      }
    };
    const walk = (d) => {
      let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      es.sort((x, y) => x.name.localeCompare(y.name));
      for (const e of es) {
        const full = path.join(d, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full); continue; }
        scan(full);
      }
    };
    if (fs.statSync(start).isFile()) scan(start); else walk(start);
    out({ ok: true, hits, more, files });
  } catch (e) { out({ ok: false, error: String(e && e.message || e) }); }
});`;

export const searchCode2 = tool(
  async (args, rt: Run) => {
    const r = await rt.context.ws.exec(
      ["node", "-e", SEARCH],
      JSON.stringify(args),
      20_000,
      300_000,
    );
    let a: {
      ok: boolean;
      error?: string;
      hits?: string[];
      more?: number;
      files?: number;
    };
    try {
      a = JSON.parse(r.stdout);
    } catch {
      return `REFUSED: the search did not answer (exit ${r.code}): ${r.stderr.slice(0, 150)}`;
    }
    if (!a.ok) return `REFUSED: ${a.error}`;
    if (!a.hits?.length)
      return `No matches in ${a.files} files. Try a shorter pattern, case_sensitive false, or another folder.`;
    return `${a.hits.join(args.context ? "\n--\n" : "\n").slice(0, 6000)}${a.more ? `\n(${a.more} more matches; narrow the folder or glob)` : ""}`;
  },
  {
    name: "search_code",
    description:
      "Search the working copy. Plain text by default; set regex for a regular expression. Covers .ts .tsx .mts .cts .js .jsx .mjs .cjs and JSON, SQL, YAML, Markdown, GraphQL, Prisma, CSS, HTML. Returns path:line:text.",
    schema: z.object({
      pattern: z.string().min(2),
      regex: z
        .boolean()
        .nullable()
        .describe("Treat the pattern as a regular expression (default false)"),
      word: z.boolean().nullable().describe("Match whole words only"),
      case_sensitive: z.boolean().nullable(),
      dir: z
        .string()
        .nullable()
        .describe('Only under this folder, such as "src/routes"'),
      glob: z
        .string()
        .nullable()
        .describe(
          'Only files matching this, such as "*.test.ts" or "src/**/*.tsx"',
        ),
      context: z
        .number()
        .int()
        .min(0)
        .max(3)
        .nullable()
        .describe("Lines of context around each match (0-3)"),
    }),
  },
);

export const CODE_TOOLS = [
  searchCode2,
  findSymbol,
  outlineFile,
  findReferences,
  reachTool,
];
