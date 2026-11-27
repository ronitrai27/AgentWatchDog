// U2 (reach): what a change reaches, from the base and head code indexes and the changed lines.
//   changedSymbols  the innermost symbols whose lines changed (head), or that lost lines (base)
//   callers         who uses them, walked backwards over references, depth 2
//   routes          endpoints whose handler or middleware chain uses a changed symbol at any depth,
//                   or whose wiring itself changed between base and head
//   global          the change reaches middleware that runs for every route
//   routesUnknown   the change is in a package whose routes cannot be fully mapped
//   unresolved      what the walk could not follow, in or around the change
import type {
  Global,
  Index,
  Route,
  Sym,
  Target,
  Unresolved,
} from "./code-index/indexer.mts";
import type { FileChange } from "./gate";
import type { Hunks } from "./git";

export type ReachedRoute = {
  framework: string;
  method: string;
  path: string;
  file: string;
  line: number;
  why: string;
};

export type Reach = {
  changedSymbols: {
    id: string;
    kind: string;
    how: "added" | "changed" | "removed";
  }[];
  callers: { id: string; depth: number; via: string }[];
  routes: ReachedRoute[];
  global: boolean;
  globalWhy: string[];
  routesUnknown: boolean;
  unknownWhy: string[];
  unresolved: Unresolved[];
};

/** Reference kinds that carry behaviour. Type-only uses and import lines are left out. */
const RUNTIME = new Set(["call", "value"]);
const CALLER_DEPTH = 2;
const ROUTE_DEPTH = 8;

export function computeReach(
  head: Index,
  base: Index | null,
  changes: FileChange[],
  hunks: Hunks,
): Reach {
  const headSyms = bySymbolFile(head.symbols);
  const baseSyms = base ? bySymbolFile(base.symbols) : new Map<string, Sym[]>();
  const headIds = new Set(head.symbols.map((s) => s.id));

  // 1. Changed symbols: the innermost symbol around every changed line.
  const changed = new Map<
    string,
    { id: string; kind: string; how: "added" | "changed" | "removed" }
  >();
  const mark = (s: Sym, how: "added" | "changed" | "removed") => {
    const prev = changed.get(s.id);
    if (!prev || (prev.how === "changed" && how !== "changed"))
      changed.set(s.id, { id: s.id, kind: s.kind, how });
  };
  for (const c of changes) {
    if (c.status === "A")
      for (const s of headSyms.get(c.path) ?? [])
        if (s.kind !== "module") mark(s, "added");
    if (c.status === "D")
      for (const s of baseSyms.get(c.path) ?? [])
        if (s.kind !== "module") mark(s, "removed");
    const h = hunks.get(c.path);
    if (!h || c.status === "A" || c.status === "D") continue;
    for (const line of h.head) {
      const s = innermost(headSyms.get(c.path) ?? [], line);
      if (s) mark(s, headIdsBase(base, s.id) ? "changed" : "added");
    }
    for (const line of h.base) {
      const s = innermost(baseSyms.get(h.from) ?? [], line);
      if (s) mark(s, headIds.has(s.id) ? "changed" : "removed");
    }
  }

  // 2. The reverse reference graph over both commits.
  const rev = new Map<string, Map<string, string>>(); // to → from → tag
  const impl = new Map<string, Set<string>>(); // implementation → declared member
  for (const idx of [head, base]) {
    if (!idx) continue;
    for (const e of idx.edges) {
      if (e.tag === "implements") {
        impl.set(e.from, (impl.get(e.from) ?? new Set()).add(e.to));
        continue;
      }
      if (!RUNTIME.has(e.tag)) continue;
      const m = rev.get(e.to) ?? new Map<string, string>();
      if (!m.has(e.from)) m.set(e.from, e.tag);
      rev.set(e.to, m);
    }
  }
  const seeds = new Set(changed.keys());
  // A changed implementation is reached through the member it implements.
  for (const id of [...seeds]) for (const t of impl.get(id) ?? []) seeds.add(t);

  const dist = new Map<string, { depth: number; via: string }>();
  for (const s of seeds) dist.set(s, { depth: 0, via: s });
  let frontier = [...seeds];
  for (let d = 1; d <= ROUTE_DEPTH && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier)
      for (const [from] of rev.get(id) ?? []) {
        if (dist.has(from)) continue;
        dist.set(from, { depth: d, via: id });
        next.push(from);
        for (const t of impl.get(from) ?? [])
          if (!dist.has(t)) {
            dist.set(t, { depth: d, via: from });
            next.push(t);
          }
      }
    frontier = next;
  }
  const callers = [...dist.entries()]
    .filter(
      ([id, v]) =>
        v.depth > 0 && v.depth <= CALLER_DEPTH && !id.endsWith("#<module>"),
    )
    .map(([id, v]) => ({ id, depth: v.depth, via: v.via }))
    .sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));

  // 3. Routes and global middleware.
  const changedLinesIn = (r: { file: string; start: number; end: number }) => {
    const h = hunks.get(r.file);
    return Boolean(h?.head.some((l) => l >= r.start && l <= r.end));
  };
  const hit = (t: Target): string | null => {
    for (const id of [...t.symbols, ...t.uses]) if (dist.has(id)) return id;
    for (const r of t.ranges)
      if (changedLinesIn(r)) return `${r.file}:${r.start}-${r.end}`;
    return null;
  };
  const reached = new Map<string, ReachedRoute>();
  const add = (r: Route, why: string) => {
    const key = `${r.method} ${r.path} ${r.file}:${r.line}`;
    if (!reached.has(key))
      reached.set(key, {
        framework: r.framework,
        method: r.method,
        path: r.path,
        file: r.file,
        line: r.line,
        why,
      });
  };
  for (const r of head.routes) {
    const h = hit(r.handler);
    if (h) {
      add(r, `its handler uses ${h}`);
      continue;
    }
    for (const m of r.middleware) {
      const x = hit(m);
      if (x) {
        add(r, `its middleware "${m.text}" uses ${x}`);
        break;
      }
    }
  }
  // Routes whose wiring changed: added, removed, or a different middleware chain.
  const sig = (r: Route) =>
    r.middleware.map((m) => m.symbols.join("+") || m.text).join(" > ");
  const keyOf = (r: Route) => `${r.method} ${r.path}`;
  if (base) {
    const before = new Map(base.routes.map((r) => [keyOf(r), r]));
    const after = new Map(head.routes.map((r) => [keyOf(r), r]));
    for (const [k, r] of after) {
      const b = before.get(k);
      if (!b) add(r, "the route is new");
      else if (sig(b) !== sig(r)) add(r, "its middleware chain changed");
    }
    for (const [k, r] of before)
      if (!after.has(k)) add(r, "the route was removed");
  }
  const globalWhy: string[] = [];
  const scoped: Global[] = [];
  for (const g of head.globals) {
    const x = hit(g.target);
    if (!x) continue;
    if (g.scope === "all")
      globalWhy.push(
        `${g.framework} middleware "${g.target.text}" (${g.file}) runs for every route and uses ${x}`,
      );
    else scoped.push(g);
  }
  if (base) {
    const gsig = (i: Index) =>
      new Set(
        i.globals
          .filter((g) => g.scope === "all")
          .map(
            (g) => `${g.pkg}|${g.target.symbols.join("+") || g.target.text}`,
          ),
      );
    const a = gsig(base);
    const b = gsig(head);
    for (const x of b)
      if (!a.has(x))
        globalWhy.push(
          `middleware for every route was added: ${x.split("|")[1]}`,
        );
    for (const x of a)
      if (!b.has(x))
        globalWhy.push(
          `middleware for every route was removed: ${x.split("|")[1]}`,
        );
  }
  for (const g of scoped)
    for (const r of head.routes)
      if (
        r.pkg === g.pkg &&
        // A Next.js layout wraps pages, not API route handlers.
        !(
          g.framework === "nextjs" &&
          /(^|\/)layout\.[mc]?[jt]sx?$/.test(g.file) &&
          r.method !== "PAGE"
        ) &&
        (g.scope as string[]).some((p) => covers(p, r.path))
      )
        add(r, `"${g.target.text}" (${g.file}) covers ${r.path}`);

  // 4. What cannot be known.
  const changedFiles = new Set(
    changes.flatMap((c) => [c.path, c.from ?? c.path]),
  );
  const unknownWhy: string[] = [];
  const pkgsTouched = new Set(
    [...changedFiles]
      .map((f) => pkgDirOf(head, f))
      .filter((p): p is string => p !== null),
  );
  for (const p of head.packages)
    if (pkgsTouched.has(p.dir) && p.unmapped.length)
      unknownWhy.push(
        `${p.dir} uses ${p.unmapped.join(", ")}, which Rox cannot map routes for yet`,
      );
  const unresolved = head.unresolved.filter(
    (u) =>
      changedFiles.has(u.file) ||
      u.file === "." ||
      pkgsTouched.has(pkgDirOf(head, u.file) ?? ""),
  );
  for (const u of unresolved)
    if (/router|app or router|middleware|handler|plugin|matcher/.test(u.why))
      unknownWhy.push(`${u.file}:${u.line} ${u.why}`);
  if (head.stats.truncated)
    unknownWhy.push("the repository is larger than the index limit");

  return {
    changedSymbols: [...changed.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    callers,
    routes: [...reached.values()].sort(
      (a, b) =>
        a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
    ),
    global: globalWhy.length > 0,
    globalWhy,
    routesUnknown: unknownWhy.length > 0,
    unknownWhy: [...new Set(unknownWhy)],
    unresolved,
  };
}

function bySymbolFile(symbols: Sym[]) {
  const m = new Map<string, Sym[]>();
  for (const s of symbols) m.set(s.file, [...(m.get(s.file) ?? []), s]);
  return m;
}
function innermost(symbols: Sym[], line: number): Sym | null {
  let best: Sym | null = null;
  for (const s of symbols)
    if (
      s.start <= line &&
      s.end >= line &&
      (!best || s.end - s.start < best.end - best.start)
    )
      best = s;
  return best;
}
function headIdsBase(base: Index | null, id: string) {
  return base ? base.symbols.some((s) => s.id === id) : true;
}
function pkgDirOf(i: Index, file: string): string | null {
  return (
    i.packages
      .filter((p) => p.dir === "." || file.startsWith(`${p.dir}/`))
      .sort((a, b) => b.dir.length - a.dir.length)[0]?.dir ?? null
  );
}
/** Does a path pattern ("/api/*", "/:path*", "/((?!_next).*)", "/admin") cover a route path? */
function covers(pattern: string, route: string): boolean {
  if (pattern === "/*" || pattern === "*" || pattern === "/")
    return pattern !== "/" || route === "/";
  // Anything with regex groups is treated as covering everything (safe side).
  if (/[()[\]?+|]/.test(pattern)) return true;
  const base = pattern.replace(/\/:[\w]+[*+]?$/, "").replace(/\/?\*+$/, "");
  if (base === "" || base === "/") return true;
  return route === base || route.startsWith(`${base}/`);
}
