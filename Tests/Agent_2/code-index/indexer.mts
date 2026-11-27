// CodeIndex (U2): reads one checkout of a JavaScript/TypeScript repository with the TypeScript
// compiler and prints one JSON index: symbols, references between them, file imports, the HTTP
// route map and what could not be followed.
//
// It runs INSIDE the sandbox (no network, read-only source), sent in with the pinned `typescript`
// package by code-index/run.ts. It only parses and type-checks; it never runs the repository's
// code. Node runs this file directly (type stripping), so it uses erasable syntax only: no enums,
// namespaces or parameter properties.
//
// Nothing here is about one repository. Routes are found per framework, from the object a route
// call is made on (created by `express()`, `new Hono()`, `Fastify()`, … or typed as one), from
// NestJS decorators, and from Next.js file conventions.
//
//   node indexer.mts <root> [maxFiles]

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  frameworkOfModule,
  packageOf,
  SOURCE_EXT,
  UNMAPPED,
} from "./support.mts";

// --- the output

export type Range = { file: string; start: number; end: number };
export type Sym = {
  id: string;
  name: string;
  kind: string;
  file: string;
  start: number;
  end: number;
  exported: boolean;
};
export type Tag = "call" | "value" | "import" | "type" | "implements";
export type Edge = { from: string; to: string; tag: Tag; line: number };
/** What a handler or middleware argument resolved to. */
export type Target = {
  text: string;
  /** Indexed symbols it is (a factory's returned function counts as the factory). */
  symbols: string[];
  /** Inline functions, with the indexed symbols they use. */
  ranges: Range[];
  uses: string[];
  /** It could not be followed to code. */
  unknown: boolean;
};
export type Route = {
  framework: string;
  method: string;
  path: string;
  file: string;
  line: number;
  handler: Target;
  /** Route-level middleware, guards, preHandlers, Next.js layouts. */
  middleware: Target[];
  /** The package folder it belongs to. */
  pkg: string;
};
export type Global = {
  framework: string;
  file: string;
  line: number;
  target: Target;
  /** "all" or the path patterns it covers. */
  scope: "all" | string[];
  pkg: string;
};
export type Unresolved = { file: string; line: number; why: string };
export type Pkg = {
  dir: string;
  name: string | null;
  /** Frameworks this package uses, from package.json dependencies. */
  frameworks: string[];
  /** Server frameworks without a route adapter: routes there are unknown. */
  unmapped: string[];
};
export type Index = {
  root: string;
  files: string[];
  packages: Pkg[];
  symbols: Sym[];
  edges: Edge[];
  imports: { from: string; to: string }[];
  /** Packages each file imports or requires (bare names, such as "express" or "@prisma/client"). */
  externals: Record<string, string[]>;
  /** Files that contain JSX. */
  jsx: string[];
  routes: Route[];
  globals: Global[];
  unresolved: Unresolved[];
  stats: {
    files: number;
    symbols: number;
    edges: number;
    ms: number;
    truncated: boolean;
  };
};

// --- what counts as source, and the framework tables (frameworks, never repositories)

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".cache",
  "coverage",
  ".stryker-tmp",
]);

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "all",
  "del",
];
const NEXT_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];
const NEST_METHODS: Record<string, string> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Patch: "PATCH",
  Delete: "DELETE",
  Options: "OPTIONS",
  Head: "HEAD",
  All: "ALL",
};
const FASTIFY_HOOKS = new Set([
  "onRequest",
  "preParsing",
  "preValidation",
  "preHandler",
  "preSerialization",
  "onSend",
]);

// --- files

function walk(
  root: string,
  max: number,
): { files: string[]; truncated: boolean } {
  const out: string[] = [];
  let truncated = false;
  const visit = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= max) {
        truncated = true;
        return;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) visit(full);
      } else if (
        e.isFile() &&
        SOURCE_EXT.includes(path.extname(e.name)) &&
        !e.name.endsWith(".d.ts") &&
        !/\.d\.[mc]ts$/.test(e.name) &&
        !/\.min\.js$/.test(e.name)
      ) {
        try {
          if (statSync(full).size <= 1_000_000) out.push(full);
        } catch {}
      }
    }
  };
  visit(root);
  return { files: out, truncated };
}

/** package.json folders (not in node_modules), nearest first for a file. */
function findPackages(root: string): Pkg[] {
  const out: Pkg[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 6) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "package.json")) {
      let pkg: Record<string, unknown> = {};
      try {
        pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      } catch {}
      const deps = {
        ...(pkg.dependencies as object),
        ...(pkg.devDependencies as object),
        ...(pkg.peerDependencies as object),
      } as Record<string, string>;
      const names = Object.keys(deps);
      out.push({
        dir: rel(root, dir),
        name: typeof pkg.name === "string" ? pkg.name : null,
        frameworks: [
          ...new Set(
            names.map(frameworkOfModule).filter((f): f is string => Boolean(f)),
          ),
        ],
        unmapped: names.filter((n) => UNMAPPED.includes(n)),
      });
    }
    for (const e of entries)
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
        visit(path.join(dir, e.name), depth + 1);
  };
  visit(root, 0);
  return out;
}

const rel = (root: string, p: string) => {
  const r = path.relative(root, p).split(path.sep).join("/");
  return r === "" ? "." : r;
};

/** Groups files by the nearest tsconfig.json / jsconfig.json, so each keeps its own paths. */
function groupByConfig(root: string, files: string[]) {
  const configs = new Map<string, string | null>();
  const nearest = (dir: string): string | null => {
    if (configs.has(dir)) return configs.get(dir) ?? null;
    let found: string | null = null;
    for (const n of ["tsconfig.json", "jsconfig.json"]) {
      try {
        if (statSync(path.join(dir, n)).isFile()) {
          found = path.join(dir, n);
          break;
        }
      } catch {}
    }
    if (!found && dir !== root && dir.startsWith(root))
      found = nearest(path.dirname(dir));
    configs.set(dir, found);
    return found;
  };
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const c = nearest(path.dirname(f)) ?? "";
    groups.set(c, [...(groups.get(c) ?? []), f]);
  }
  return groups;
}

const DEFAULTS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  jsx: ts.JsxEmit.Preserve,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
};

function optionsFor(config: string): {
  options: ts.CompilerOptions;
  error?: string;
} {
  if (!config) return { options: { ...DEFAULTS } };
  const read = ts.readConfigFile(config, ts.sys.readFile);
  if (read.error)
    return { options: { ...DEFAULTS }, error: "unreadable config" };
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    path.dirname(config),
  );
  return {
    options: {
      ...parsed.options,
      allowJs: true,
      checkJs: false,
      noEmit: true,
      skipLibCheck: true,
      jsx: parsed.options.jsx ?? ts.JsxEmit.Preserve,
      maxNodeModuleJsDepth: 0,
      composite: false,
      incremental: false,
      declaration: false,
      allowImportingTsExtensions: true,
      types: parsed.options.types,
    },
  };
}

// --- the index itself

export function buildIndex(rootArg: string, maxFiles = 8000): Index {
  const t0 = Date.now();
  const root = realpathSync(rootArg);
  const { files, truncated } = walk(root, maxFiles);
  const packages = findPackages(root);
  const fileSet = new Set(files.map((f) => realpathSync(f)));
  const inRepo = (fileName: string) => {
    let real = fileName;
    try {
      real = realpathSync(fileName);
    } catch {}
    return fileSet.has(real) ? rel(root, real) : null;
  };
  const pkgOf = (file: string) =>
    packages
      .filter(
        (p) => p.dir === "." || file === p.dir || file.startsWith(`${p.dir}/`),
      )
      .sort((a, b) => b.dir.length - a.dir.length)[0] ?? null;

  const symbols: Sym[] = [];
  const symById = new Map<string, Sym>();
  const edges = new Map<string, Edge>();
  const imports = new Map<string, { from: string; to: string }>();
  const externals = new Map<string, Set<string>>();
  const jsx = new Set<string>();
  const unresolved: Unresolved[] = [];
  const routes: Route[] = [];
  const globals: Global[] = [];
  if (truncated)
    unresolved.push({
      file: ".",
      line: 1,
      why: `more than ${maxFiles} source files; the rest were not indexed`,
    });

  // Each declaration node maps to its symbol id. Filled per program; node identity is per program.
  for (const [config, group] of groupByConfig(root, files)) {
    const { options, error } = optionsFor(config);
    if (error)
      unresolved.push({ file: rel(root, config), line: 1, why: error });
    const program = ts.createProgram({ rootNames: group, options });
    const checker = program.getTypeChecker();
    const decl = new Map<ts.Node, string>();
    const moduleSym = new Map<string, string>();
    const own = new Set(group.map((f) => realpathSync(f)));
    const sources = program
      .getSourceFiles()
      .filter((sf) => !sf.isDeclarationFile && own.has(safeReal(sf.fileName)));

    // Pass 1: symbols.
    for (const sf of sources) {
      const file = rel(root, safeReal(sf.fileName));
      const lineOf = (pos: number) =>
        sf.getLineAndCharacterOfPosition(pos).line + 1;
      const add = (
        node: ts.Node,
        name: string,
        kind: string,
        exported: boolean,
      ) => {
        let id = `${file}#${name}`;
        for (let i = 2; symById.has(id) && !decl.has(node); i++)
          id = `${file}#${name}~${i}`;
        if (symById.has(id)) return id;
        const s: Sym = {
          id,
          name,
          kind,
          file,
          start: lineOf(node.getStart(sf)),
          end: lineOf(node.getEnd()),
          exported,
        };
        symbols.push(s);
        symById.set(id, s);
        decl.set(node, id);
        return id;
      };
      const mod = add(sf, "<module>", "module", false);
      moduleSym.set(file, mod);
      const exportedNode = (n: ts.Node) => {
        let x: ts.Node | undefined = n;
        if (ts.isVariableDeclaration(x)) x = x.parent?.parent; // VariableStatement
        return Boolean(
          x &&
            ts.canHaveModifiers(x) &&
            ts
              .getModifiers(x)
              ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
        );
      };
      const visit = (node: ts.Node, scope: string | null) => {
        let next = scope;
        const q = (n: string) => (scope ? `${scope}.${n}` : n);
        const isFn = (n: ts.Node | undefined) =>
          Boolean(
            n &&
              (ts.isArrowFunction(n) ||
                ts.isFunctionExpression(n) ||
                ts.isClassExpression(n)),
          );
        if (ts.isFunctionDeclaration(node)) {
          next = q(node.name?.text ?? "default");
          add(node, next, "function", exportedNode(node));
        } else if (ts.isClassDeclaration(node)) {
          next = q(node.name?.text ?? "default");
          add(node, next, "class", exportedNode(node));
        } else if (
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node)
        ) {
          next = q(node.name.text);
          add(node, next, "type", exportedNode(node));
        } else if (ts.isEnumDeclaration(node)) {
          next = q(node.name.text);
          add(node, next, "enum", exportedNode(node));
        } else if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name)
        ) {
          const init = node.initializer;
          const top = !scope;
          if (top || isFn(init)) {
            next = q(node.name.text);
            const id = add(
              node,
              next,
              isFn(init) ? "function" : "variable",
              exportedNode(node),
            );
            if (init && isFn(init)) decl.set(init, id);
          }
        } else if (
          (ts.isMethodDeclaration(node) ||
            ts.isGetAccessorDeclaration(node) ||
            ts.isSetAccessorDeclaration(node) ||
            ts.isConstructorDeclaration(node) ||
            ts.isPropertyDeclaration(node) ||
            ts.isPropertyAssignment(node) ||
            ts.isPropertySignature(node) ||
            ts.isMethodSignature(node)) &&
          scope
        ) {
          const name = ts.isConstructorDeclaration(node)
            ? "constructor"
            : node.name &&
                (ts.isIdentifier(node.name) ||
                  ts.isStringLiteral(node.name) ||
                  ts.isPrivateIdentifier(node.name))
              ? node.name.text
              : null;
          const init =
            ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)
              ? node.initializer
              : undefined;
          const fnLike =
            ts.isMethodDeclaration(node) ||
            ts.isGetAccessorDeclaration(node) ||
            ts.isSetAccessorDeclaration(node) ||
            ts.isConstructorDeclaration(node) ||
            ts.isMethodSignature(node) ||
            ts.isPropertySignature(node) ||
            isFn(init) ||
            ts.isClassDeclaration(node.parent);
          if (name && fnLike) {
            next = q(name);
            const kind =
              ts.isPropertySignature(node) || ts.isMethodSignature(node)
                ? "member"
                : ts.isPropertyDeclaration(node) && !isFn(init)
                  ? "property"
                  : "method";
            const id = add(node, next, kind, false);
            if (init && isFn(init)) decl.set(init, id);
          }
        } else if (ts.isExportAssignment(node) && !node.isExportEquals) {
          next = "default";
          const id = add(node, "default", "value", true);
          if (isFn(node.expression)) decl.set(node.expression, id);
        }
        ts.forEachChild(node, (c) => visit(c, next));
      };
      ts.forEachChild(sf, (c) => visit(c, null));
    }

    // The nearest indexed symbol around a node.
    const enclosing = (node: ts.Node): string => {
      for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
        const id = decl.get(n);
        if (id) return id;
      }
      return (
        moduleSym.get(rel(root, safeReal(node.getSourceFile().fileName))) ?? ""
      );
    };
    const idOfDeclaration = (d: ts.Declaration | undefined): string | null => {
      if (!d) return null;
      if (decl.has(d)) return decl.get(d) ?? null;
      // A name inside a declaration, or a binding pattern element.
      if (
        d.parent &&
        decl.has(d.parent) &&
        (d.parent as { name?: ts.Node }).name === d
      )
        return decl.get(d.parent) ?? null;
      if (ts.isSourceFile(d)) return decl.get(d) ?? null;
      return null;
    };
    const resolveSymbol = (s: ts.Symbol | undefined): ts.Symbol | undefined => {
      let x = s;
      for (let i = 0; x && x.flags & ts.SymbolFlags.Alias && i < 8; i++) {
        try {
          x = checker.getAliasedSymbol(x);
        } catch {
          break;
        }
      }
      return x;
    };
    /**
     * The indexed symbols a symbol stands for. A property or local variable that only forwards
     * another value (`{ requireRole }`, `{ guard: requireRole }`, `const loadUser =
     * createLoadUser(service)`) is followed to what it forwards, so a call through a returned
     * object still points at the real function.
     */
    const targetsOf = (s: ts.Symbol | undefined, depth = 0): string[] => {
      const out: string[] = [];
      for (const d of resolveSymbol(s)?.declarations ?? []) {
        if (!inRepo(d.getSourceFile().fileName)) continue;
        const id = idOfDeclaration(d);
        if (id) {
          out.push(id);
          continue;
        }
        if (depth >= 4) continue;
        let next: ts.Expression | undefined;
        if (ts.isShorthandPropertyAssignment(d)) {
          out.push(
            ...targetsOf(
              checker.getShorthandAssignmentValueSymbol(d),
              depth + 1,
            ),
          );
          continue;
        }
        if (ts.isPropertyAssignment(d) || ts.isVariableDeclaration(d))
          next = d.initializer;
        if (!next) continue;
        let e = next;
        while (
          ts.isAwaitExpression(e) ||
          ts.isParenthesizedExpression(e) ||
          ts.isAsExpression(e)
        )
          e = e.expression;
        if (ts.isCallExpression(e) || ts.isNewExpression(e)) e = e.expression;
        if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e))
          out.push(...targetsOf(checker.getSymbolAtLocation(e), depth + 1));
      }
      return [...new Set(out)];
    };

    // All references, kept per file for the route pass (inline handlers).
    const refsByFile = new Map<
      string,
      { pos: number; end: number; line: number; to: string }[]
    >();
    const callSites = new Map<string, ts.CallExpression[]>();

    const isDeclName = (id: ts.Identifier) => {
      const p = id.parent as ts.Node & { name?: ts.Node };
      return (
        p.name === id &&
        (ts.isFunctionDeclaration(p) ||
          ts.isClassDeclaration(p) ||
          ts.isInterfaceDeclaration(p) ||
          ts.isTypeAliasDeclaration(p) ||
          ts.isEnumDeclaration(p) ||
          ts.isVariableDeclaration(p) ||
          ts.isMethodDeclaration(p) ||
          ts.isPropertyDeclaration(p) ||
          ts.isPropertyAssignment(p) ||
          ts.isPropertySignature(p) ||
          ts.isMethodSignature(p) ||
          ts.isParameter(p) ||
          ts.isBindingElement(p) ||
          ts.isGetAccessorDeclaration(p) ||
          ts.isSetAccessorDeclaration(p) ||
          ts.isEnumMember(p))
      );
    };
    const tagOf = (id: ts.Identifier): Tag => {
      for (
        let n: ts.Node | undefined = id.parent;
        n && !ts.isSourceFile(n);
        n = n.parent
      ) {
        if (
          ts.isImportDeclaration(n) ||
          ts.isExportDeclaration(n) ||
          ts.isImportEqualsDeclaration(n)
        )
          return "import";
        if (ts.isStatement(n)) break;
      }
      if (
        ts.isPartOfTypeNode(id) ||
        (id.parent && ts.isTypeQueryNode(id.parent))
      )
        return "type";
      if (id.parent && ts.isHeritageClause(id.parent.parent ?? id.parent))
        return "type";
      let callee: ts.Node = id;
      if (
        id.parent &&
        ts.isPropertyAccessExpression(id.parent) &&
        id.parent.name === id
      )
        callee = id.parent;
      const p = callee.parent;
      if (
        p &&
        (ts.isCallExpression(p) || ts.isNewExpression(p)) &&
        p.expression === callee
      )
        return "call";
      if (p && ts.isTaggedTemplateExpression(p) && p.tag === callee)
        return "call";
      if (
        p &&
        (ts.isJsxOpeningElement(p) ||
          ts.isJsxSelfClosingElement(p) ||
          ts.isJsxClosingElement(p)) &&
        p.tagName === callee
      )
        return "call";
      return "value";
    };

    // Pass 2: references, imports, implements, dynamic requires.
    for (const sf of sources) {
      const file = rel(root, safeReal(sf.fileName));
      const lineOf = (pos: number) =>
        sf.getLineAndCharacterOfPosition(pos).line + 1;
      const fileRefs: { pos: number; end: number; line: number; to: string }[] =
        [];
      refsByFile.set(file, fileRefs);
      const addImport = (spec: string, at: ts.Node) => {
        const bare = packageOf(spec);
        if (bare)
          externals.set(file, (externals.get(file) ?? new Set()).add(bare));
        const r = ts.resolveModuleName(
          spec,
          sf.fileName,
          options,
          ts.sys,
        ).resolvedModule;
        const to =
          r && !r.isExternalLibraryImport ? inRepo(r.resolvedFileName) : null;
        if (to && to !== file) imports.set(`${file}>${to}`, { from: file, to });
        else if (!r && (spec.startsWith(".") || spec.startsWith("/")))
          unresolved.push({
            file,
            line: lineOf(at.getStart(sf)),
            why: `import "${spec}" could not be resolved`,
          });
      };
      const visit = (node: ts.Node) => {
        if (
          ts.isJsxElement(node) ||
          ts.isJsxSelfClosingElement(node) ||
          ts.isJsxFragment(node)
        )
          jsx.add(file);
        if (ts.isIdentifier(node) && !isDeclName(node)) {
          let s: ts.Symbol | undefined;
          if (
            ts.isShorthandPropertyAssignment(node.parent) &&
            node.parent.name === node
          )
            s = checker.getShorthandAssignmentValueSymbol(node.parent);
          else s = checker.getSymbolAtLocation(node);
          if (s) {
            const to = targetsOf(s);
            if (to.length) {
              const from = enclosing(node);
              const tag = tagOf(node);
              const line = lineOf(node.getStart(sf));
              for (const t of to) {
                fileRefs.push({
                  pos: node.getStart(sf),
                  end: node.getEnd(),
                  line,
                  to: t,
                });
                if (t === from) continue;
                const key = `${from}|${t}|${tag}`;
                if (!edges.has(key)) edges.set(key, { from, to: t, tag, line });
              }
              if (tag === "call") {
                let call: ts.Node = node;
                if (
                  ts.isPropertyAccessExpression(node.parent) &&
                  node.parent.name === node
                )
                  call = node.parent;
                if (call.parent && ts.isCallExpression(call.parent))
                  for (const t of to)
                    callSites.set(t, [
                      ...(callSites.get(t) ?? []),
                      call.parent,
                    ]);
              }
            }
          }
        }
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          addImport(node.moduleSpecifier.text, node);
        if (
          ts.isExportDeclaration(node) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          addImport(node.moduleSpecifier.text, node);
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          const isRequire =
            ts.isIdentifier(callee) && callee.text === "require";
          const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
          if (isRequire || isImport) {
            const a = node.arguments[0];
            if (a && ts.isStringLiteralLike(a)) addImport(a.text, node);
            else
              unresolved.push({
                file,
                line: lineOf(node.getStart(sf)),
                why: `${isRequire ? "require" : "import"}() with a computed name`,
              });
          }
        }
        // An object literal method that implements a declared member (interface or type).
        if (
          (ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) &&
          ts.isObjectLiteralExpression(node.parent) &&
          node.name &&
          ts.isIdentifier(node.name)
        ) {
          const own = decl.get(node);
          const ctx = checker.getContextualType(node.parent);
          const member = ctx?.getProperty(node.name.text);
          if (own && member)
            for (const t of targetsOf(member))
              if (t !== own)
                edges.set(`${own}|${t}|implements`, {
                  from: own,
                  to: t,
                  tag: "implements",
                  line: lineOf(node.getStart(sf)),
                });
        }
        // A class method that implements an interface member.
        if (ts.isClassDeclaration(node))
          for (const h of node.heritageClauses ?? [])
            for (const ty of h.types) {
              const iface = checker.getTypeAtLocation(ty);
              for (const m of node.members) {
                const own = decl.get(m);
                if (!own || !m.name || !ts.isIdentifier(m.name)) continue;
                for (const t of targetsOf(iface.getProperty(m.name.text)))
                  if (t !== own)
                    edges.set(`${own}|${t}|implements`, {
                      from: own,
                      to: t,
                      tag: "implements",
                      line: lineOf(m.getStart(sf)),
                    });
              }
            }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    // --- routes: helpers to follow an expression back to code

    const moduleOfIdentifier = (id: ts.Identifier): string | null => {
      const s = checker.getSymbolAtLocation(id);
      for (const d of s?.declarations ?? []) {
        let n: ts.Node | undefined = d;
        while (
          n &&
          !ts.isImportDeclaration(n) &&
          !ts.isImportEqualsDeclaration(n) &&
          !ts.isVariableDeclaration(n)
        )
          n = n.parent;
        if (
          n &&
          ts.isImportDeclaration(n) &&
          ts.isStringLiteral(n.moduleSpecifier)
        )
          return n.moduleSpecifier.text;
        if (
          n &&
          ts.isImportEqualsDeclaration(n) &&
          ts.isExternalModuleReference(n.moduleReference)
        ) {
          const e = n.moduleReference.expression;
          if (ts.isStringLiteral(e)) return e.text;
        }
        if (n && ts.isVariableDeclaration(n) && n.initializer) {
          let i: ts.Expression = n.initializer;
          while (ts.isPropertyAccessExpression(i)) i = i.expression;
          if (
            ts.isCallExpression(i) &&
            ts.isIdentifier(i.expression) &&
            i.expression.text === "require"
          ) {
            const a = i.arguments[0];
            if (a && ts.isStringLiteral(a)) return a.text;
          }
        }
      }
      return null;
    };
    const leftmost = (e: ts.Expression): ts.Identifier | null => {
      let x: ts.Expression = e;
      while (
        ts.isPropertyAccessExpression(x) ||
        ts.isCallExpression(x) ||
        ts.isParenthesizedExpression(x)
      )
        x = ts.isCallExpression(x) ? x.expression : x.expression;
      return ts.isIdentifier(x) ? x : null;
    };
    /** The framework of the type of an expression, from where its type is declared. */
    const frameworkOfType = (e: ts.Expression): string | null => {
      let t: ts.Type;
      try {
        t = checker.getTypeAtLocation(e);
      } catch {
        return null;
      }
      const seen = [
        t.getSymbol(),
        t.aliasSymbol,
        ...(t.isUnion() || t.isIntersection()
          ? t.types.map((x) => x.getSymbol())
          : []),
      ];
      for (const s of seen)
        for (const d of s?.declarations ?? []) {
          const f = d.getSourceFile().fileName.replaceAll("\\", "/");
          const m = /\/node_modules\/((?:@types\/)?(?:@[^/]+\/)?[^/]+)\//.exec(
            f,
          )?.[1];
          if (!m) continue;
          const name = m.startsWith("@types/")
            ? m.slice(7).replace(/^([^_]+)__/, "@$1/")
            : m;
          const fw =
            frameworkOfModule(name) ??
            (name === "express-serve-static-core" ? "express" : null);
          if (fw) return fw;
        }
      return null;
    };

    type Container = {
      key: string;
      framework: string;
      root: boolean;
      prefix: string;
      file: string;
    };
    const containers = new Map<string, Container>();
    const alias = new Map<string, string>(); // parameter container → real container
    const find = (k: string): string => {
      let x = k;
      for (let i = 0; alias.has(x) && i < 20; i++) x = alias.get(x) as string;
      return x;
    };
    const nodeKey = (n: ts.Node) =>
      `${rel(root, safeReal(n.getSourceFile().fileName))}:${n.getStart()}`;

    /** A call or `new` that creates an app or router, and which framework. */
    const creation = (
      e: ts.Expression,
    ): { framework: string; root: boolean; prefix: string } | null => {
      if (!ts.isCallExpression(e) && !ts.isNewExpression(e)) return null;
      const id = leftmost(e.expression);
      const mod = id ? moduleOfIdentifier(id) : null;
      const fw = mod ? frameworkOfModule(mod) : null;
      if (!fw || fw === "nestjs" || fw === "nextjs") return null;
      const calleeText = e.expression.getText();
      const isRouter = /Router\b/.test(calleeText);
      const fromKoaRouter = mod === "@koa/router" || mod === "koa-router";
      let prefix = "";
      const opt = e.arguments?.[0];
      if (opt && ts.isObjectLiteralExpression(opt))
        for (const p of opt.properties)
          if (
            ts.isPropertyAssignment(p) &&
            p.name.getText() === "prefix" &&
            ts.isStringLiteralLike(p.initializer)
          )
            prefix = p.initializer.text;
      return { framework: fw, root: !isRouter && !fromKoaRouter, prefix };
    };

    /** Follows an expression to the app/router containers it may be. */
    const containersOf = (
      e: ts.Expression,
      depth = 0,
      seen = new Set<ts.Node>(),
    ): Container[] => {
      if (depth > 10 || seen.has(e)) return [];
      seen.add(e);
      const x = skipOuter(e);
      const made = creation(x);
      if (made) {
        const key = nodeKey(x);
        if (!containers.has(key))
          containers.set(key, {
            key,
            ...made,
            file: rel(root, safeReal(x.getSourceFile().fileName)),
          });
        return [containers.get(key) as Container];
      }
      if (ts.isCallExpression(x)) {
        const callee = x.expression;
        // router.get(...).post(...), router.routes(), app.basePath("/x"), express.Router()
        if (ts.isPropertyAccessExpression(callee)) {
          const name = callee.name.text;
          if (
            [
              ...HTTP_METHODS,
              "use",
              "route",
              "routes",
              "basePath",
              "middleware",
            ].includes(name)
          ) {
            const inner = containersOf(callee.expression, depth + 1, seen);
            if (inner.length) return inner;
          }
        }
        // A function that returns a router.
        return returnsOf(callee).flatMap((r) =>
          containersOf(r, depth + 1, seen),
        );
      }
      if (ts.isIdentifier(x) || ts.isPropertyAccessExpression(x)) {
        const s =
          ts.isIdentifier(x) &&
          ts.isShorthandPropertyAssignment(x.parent) &&
          x.parent.name === x
            ? checker.getShorthandAssignmentValueSymbol(x.parent)
            : checker.getSymbolAtLocation(x);
        const out: Container[] = [];
        for (const d of resolveSymbol(s)?.declarations ?? []) {
          if (ts.isParameter(d) || (ts.isBindingElement(d) && paramOf(d))) {
            const key = nodeKey(d);
            const fw = frameworkOfType(x);
            if (fw) {
              if (!containers.has(key))
                containers.set(key, {
                  key,
                  framework: fw,
                  root: false,
                  prefix: "",
                  file: rel(root, safeReal(d.getSourceFile().fileName)),
                });
              out.push(containers.get(key) as Container);
            }
            for (const a of argumentsFor(d))
              out.push(...containersOf(a, depth + 1, seen));
          } else {
            const init = initializerOf(d);
            if (init) out.push(...containersOf(init, depth + 1, seen));
          }
        }
        return out;
      }
      return [];
    };

    /** Follows a handler or middleware expression to code. */
    const targetOf = (
      e: ts.Expression,
      depth = 0,
      seen = new Set<ts.Node>(),
      acc?: Target,
    ): Target => {
      const t = acc ?? {
        text: e.getText().slice(0, 120),
        symbols: [],
        ranges: [],
        uses: [],
        unknown: false,
      };
      const x = skipOuter(e);
      if (depth > 10 || seen.has(x)) return t;
      seen.add(x);
      if (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) {
        const id = decl.get(x);
        if (id) t.symbols.push(id);
        const sf = x.getSourceFile();
        const file = rel(root, safeReal(sf.fileName));
        const start = sf.getLineAndCharacterOfPosition(x.getStart(sf)).line + 1;
        const end = sf.getLineAndCharacterOfPosition(x.getEnd()).line + 1;
        t.ranges.push({ file, start, end });
        for (const r of refsByFile.get(file) ?? [])
          if (r.pos >= x.getStart(sf) && r.end <= x.getEnd()) t.uses.push(r.to);
        return t;
      }
      if (ts.isCallExpression(x)) {
        // A factory: requireRole("admin"), createLoadUser(service), passport.authenticate("jwt").
        const before = t.symbols.length;
        targetOf(x.expression, depth + 1, seen, t);
        if (t.symbols.length === before && !t.ranges.length) {
          for (const r of returnsOf(x.expression))
            targetOf(r, depth + 1, seen, t);
        }
        return t;
      }
      if (ts.isArrayLiteralExpression(x)) {
        for (const el of x.elements) targetOf(el, depth + 1, seen, t);
        return t;
      }
      if (ts.isIdentifier(x) || ts.isPropertyAccessExpression(x)) {
        const s =
          ts.isIdentifier(x) &&
          ts.isShorthandPropertyAssignment(x.parent) &&
          x.parent.name === x
            ? checker.getShorthandAssignmentValueSymbol(x.parent)
            : checker.getSymbolAtLocation(x);
        const r = resolveSymbol(s);
        if (!r?.declarations?.length) {
          // Imported from a package that is not installed here: a library, not our code.
          const id = leftmost(x);
          const mod = id ? moduleOfIdentifier(id) : null;
          if (!(mod && !mod.startsWith(".") && !mod.startsWith("/")))
            t.unknown = true;
          return t;
        }
        let followed = false;
        for (const d of r.declarations) {
          if (!inRepo(d.getSourceFile().fileName)) {
            followed = true; // a library function (express.json(), helmet()): not our code
            continue;
          }
          const id = idOfDeclaration(d);
          if (id && (symById.get(id)?.kind ?? "") !== "variable") {
            t.symbols.push(id);
            followed = true;
            continue;
          }
          if (ts.isParameter(d) || (ts.isBindingElement(d) && paramOf(d))) {
            const args = argumentsFor(d);
            if (!args.length) t.unknown = true;
            for (const a of args) targetOf(a, depth + 1, seen, t);
            followed = true;
            continue;
          }
          const init = initializerOf(d);
          if (init) {
            if (id) t.symbols.push(id);
            targetOf(init, depth + 1, seen, t);
            followed = true;
          }
        }
        if (!followed) t.unknown = true;
        return t;
      }
      t.unknown = true;
      return t;
    };

    const skipOuter = (e: ts.Expression): ts.Expression => {
      let x = e;
      while (
        ts.isParenthesizedExpression(x) ||
        ts.isAsExpression(x) ||
        ts.isNonNullExpression(x) ||
        ts.isSatisfiesExpression(x) ||
        ts.isAwaitExpression(x) ||
        ts.isTypeAssertionExpression(x)
      )
        x = x.expression;
      return x;
    };
    const initializerOf = (d: ts.Declaration): ts.Expression | null => {
      if (
        ts.isVariableDeclaration(d) ||
        ts.isPropertyDeclaration(d) ||
        ts.isPropertyAssignment(d)
      )
        return d.initializer ?? null;
      if (ts.isShorthandPropertyAssignment(d)) return d.name;
      if (ts.isBindingElement(d)) return null;
      if (ts.isExportAssignment(d)) return d.expression;
      return null;
    };
    /** The function a parameter (or destructured parameter property) belongs to. */
    const paramOf = (
      d: ts.Declaration,
    ): {
      fn: ts.SignatureDeclaration;
      index: number;
      prop: string | null;
    } | null => {
      let prop: string | null = null;
      let n: ts.Node = d;
      if (ts.isBindingElement(d)) {
        prop = (d.propertyName ?? d.name).getText();
        n = d.parent.parent; // ObjectBindingPattern → ParameterDeclaration
        if (!ts.isParameter(n)) return null;
      }
      if (!ts.isParameter(n)) return null;
      const fn = n.parent as ts.SignatureDeclaration;
      return { fn, index: fn.parameters.indexOf(n), prop };
    };
    /** What callers pass for a parameter. */
    const argumentsFor = (d: ts.Declaration): ts.Expression[] => {
      const p = paramOf(d);
      if (!p) return [];
      const fnId =
        decl.get(p.fn) ?? (p.fn.parent ? decl.get(p.fn.parent) : undefined);
      if (!fnId) return [];
      const out: ts.Expression[] = [];
      for (const call of callSites.get(fnId) ?? []) {
        const a = call.arguments[p.index];
        if (!a) continue;
        if (p.prop === null) out.push(a);
        else if (ts.isObjectLiteralExpression(a))
          for (const prop of a.properties) {
            if (ts.isPropertyAssignment(prop) && prop.name.getText() === p.prop)
              out.push(prop.initializer);
            if (
              ts.isShorthandPropertyAssignment(prop) &&
              prop.name.text === p.prop
            )
              out.push(prop.name);
          }
      }
      return out;
    };
    /** The expressions a called function may return. */
    const returnsOf = (callee: ts.Expression): ts.Expression[] => {
      const s = resolveSymbol(checker.getSymbolAtLocation(skipOuter(callee)));
      const out: ts.Expression[] = [];
      for (const d of s?.declarations ?? []) {
        if (!inRepo(d.getSourceFile().fileName)) continue;
        let fn: ts.Node | undefined = d;
        if (ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d))
          fn = d.initializer;
        if (!fn || !ts.isFunctionLike(fn)) continue;
        const body = (fn as ts.FunctionLikeDeclaration).body;
        if (!body) continue;
        if (!ts.isBlock(body)) {
          out.push(body);
          continue;
        }
        const visit = (n: ts.Node) => {
          if (ts.isFunctionLike(n) && n !== fn) return;
          if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
          ts.forEachChild(n, visit);
        };
        visit(body);
      }
      return out;
    };

    // --- routes: Express, Koa (+ router), Hono, Fastify

    type Reg = {
      container: Container;
      method: string;
      path: string;
      file: string;
      line: number;
      handler: Target;
      middleware: Target[];
    };
    const regs: Reg[] = [];
    const mounts: { parent: Container; prefix: string; child: Container }[] =
      [];
    const levelMw: {
      container: Container;
      prefix: string;
      target: Target;
      file: string;
      line: number;
    }[] = [];
    const pathText = (a: ts.Expression | undefined) =>
      a && ts.isStringLiteralLike(a) ? a.text : a ? "<dynamic>" : "";

    for (const sf of sources) {
      const file = rel(root, safeReal(sf.fileName));
      const lineOf = (n: ts.Node) =>
        sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression)
        ) {
          const method = node.expression.name.text;
          const relevant = [
            ...HTTP_METHODS,
            "use",
            "route",
            "register",
            "addHook",
          ].includes(method);
          const recv = node.expression.expression;
          const owners = relevant ? containersOf(recv) : [];
          // `router.route("/x").get(h)`: the path comes from .route()
          let routePath: string | null = null;
          if (
            ts.isCallExpression(recv) &&
            ts.isPropertyAccessExpression(recv.expression) &&
            recv.expression.name.text === "route" &&
            recv.arguments.length === 1
          )
            routePath = pathText(recv.arguments[0]);
          for (const c of owners) {
            const args = [...node.arguments];
            if (HTTP_METHODS.includes(method)) {
              if (
                c.framework === "fastify" &&
                args.length >= 2 &&
                ts.isObjectLiteralExpression(args[1] as ts.Expression)
              ) {
                const opts = args[1] as ts.ObjectLiteralExpression;
                const mw = hookTargets(opts);
                const h = args[2] ?? propOf(opts, "handler");
                regs.push({
                  container: c,
                  method: method.toUpperCase(),
                  path: pathText(args[0]),
                  file,
                  line: lineOf(node),
                  handler: h ? targetOf(h) : emptyTarget("no handler"),
                  middleware: mw,
                });
              } else {
                const p = routePath ?? pathText(args.shift());
                const handlers = args.flatMap((a) =>
                  ts.isArrayLiteralExpression(a) ? [...a.elements] : [a],
                );
                const h = handlers.pop();
                regs.push({
                  container: c,
                  method: method === "del" ? "DELETE" : method.toUpperCase(),
                  path: p,
                  file,
                  line: lineOf(node),
                  handler: h ? targetOf(h) : emptyTarget("no handler"),
                  middleware: handlers.map((m) => targetOf(m)),
                });
              }
            } else if (
              method === "route" &&
              c.framework === "fastify" &&
              args[0] &&
              ts.isObjectLiteralExpression(args[0])
            ) {
              const o = args[0];
              const m = propOf(o, "method");
              const url = propOf(o, "url") ?? propOf(o, "path");
              const methods =
                m && ts.isArrayLiteralExpression(m)
                  ? m.elements.map((e) => pathText(e))
                  : [pathText(m)];
              const h = propOf(o, "handler");
              for (const mm of methods)
                regs.push({
                  container: c,
                  method: mm.toUpperCase(),
                  path: pathText(url),
                  file,
                  line: lineOf(node),
                  handler: h ? targetOf(h) : emptyTarget("no handler"),
                  middleware: hookTargets(o),
                });
            } else if (
              method === "route" &&
              c.framework === "hono" &&
              args.length === 2
            ) {
              for (const child of containersOf(args[1] as ts.Expression))
                mounts.push({ parent: c, prefix: pathText(args[0]), child });
            } else if (method === "use") {
              const prefix =
                args[0] && ts.isStringLiteralLike(args[0])
                  ? (args.shift() as ts.StringLiteralLike).text
                  : "";
              for (const a of args.flatMap((a) =>
                ts.isArrayLiteralExpression(a) ? [...a.elements] : [a],
              )) {
                const kids = containersOf(a);
                if (kids.length)
                  for (const child of kids)
                    mounts.push({ parent: c, prefix, child });
                else
                  levelMw.push({
                    container: c,
                    prefix,
                    target: targetOf(a),
                    file,
                    line: lineOf(node),
                  });
              }
            } else if (
              method === "register" &&
              c.framework === "fastify" &&
              args[0]
            ) {
              const o =
                args[1] && ts.isObjectLiteralExpression(args[1])
                  ? args[1]
                  : null;
              const prefix = o ? pathText(propOf(o, "prefix")) : "";
              const plugin = targetOf(args[0]);
              // The plugin's first parameter is the child instance.
              for (const fnNode of pluginFunctions(args[0])) {
                const p0 = fnNode.parameters[0];
                if (!p0) continue;
                const key = nodeKey(p0);
                if (!containers.has(key))
                  containers.set(key, {
                    key,
                    framework: "fastify",
                    root: false,
                    prefix: "",
                    file: rel(root, safeReal(p0.getSourceFile().fileName)),
                  });
                mounts.push({
                  parent: c,
                  prefix,
                  child: containers.get(key) as Container,
                });
              }
              if (plugin.unknown)
                unresolved.push({
                  file,
                  line: lineOf(node),
                  why: "a Fastify plugin that could not be followed",
                });
            } else if (
              method === "addHook" &&
              c.framework === "fastify" &&
              args[0] &&
              ts.isStringLiteralLike(args[0])
            ) {
              if (FASTIFY_HOOKS.has(args[0].text) && args[1])
                levelMw.push({
                  container: c,
                  prefix: "",
                  target: targetOf(args[1]),
                  file,
                  line: lineOf(node),
                });
            }
          }
          if (
            relevant &&
            !owners.length &&
            (method === "use" || HTTP_METHODS.includes(method))
          ) {
            // A route-like call on something we could not identify: only worth noting when the
            // file uses a mapped server framework.
            const id = leftmost(recv);
            const mod = id ? moduleOfIdentifier(id) : null;
            if (mod && frameworkOfModule(mod))
              unresolved.push({
                file,
                line: lineOf(node),
                why: `${recv.getText().slice(0, 60)}.${method}() could not be tied to an app or router`,
              });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    function propOf(
      o: ts.ObjectLiteralExpression,
      name: string,
    ): ts.Expression | undefined {
      for (const p of o.properties) {
        if (
          ts.isPropertyAssignment(p) &&
          p.name.getText().replace(/['"]/g, "") === name
        )
          return p.initializer;
        if (ts.isShorthandPropertyAssignment(p) && p.name.text === name)
          return p.name;
        if (ts.isMethodDeclaration(p) && p.name.getText() === name)
          return p as unknown as ts.Expression;
      }
      return undefined;
    }
    function hookTargets(o: ts.ObjectLiteralExpression): Target[] {
      const out: Target[] = [];
      for (const h of FASTIFY_HOOKS) {
        const v = propOf(o, h);
        if (v) out.push(targetOf(v));
      }
      return out;
    }
    function pluginFunctions(e: ts.Expression): ts.SignatureDeclaration[] {
      const x = skipOuter(e);
      if (ts.isArrowFunction(x) || ts.isFunctionExpression(x)) return [x];
      if (ts.isCallExpression(x))
        return x.arguments.flatMap((a) => pluginFunctions(a)); // fp(plugin)
      const s = resolveSymbol(checker.getSymbolAtLocation(x));
      const out: ts.SignatureDeclaration[] = [];
      for (const d of s?.declarations ?? []) {
        if (ts.isFunctionDeclaration(d)) out.push(d);
        const init = initializerOf(d);
        if (init) out.push(...pluginFunctions(init));
      }
      return out;
    }

    // Parameters that receive an app (`setupRoutes(app)`) are the same container as the app.
    for (const [key, c] of containers) {
      if (c.root || c.prefix) continue;
      // A parameter container: find what callers pass.
      const [f, pos] = [
        key.slice(0, key.lastIndexOf(":")),
        Number(key.slice(key.lastIndexOf(":") + 1)),
      ];
      const sf = sources.find((s) => rel(root, safeReal(s.fileName)) === f);
      if (!sf) continue;
      const node = findNodeAt(sf, pos);
      if (!node || !ts.isParameter(node)) continue;
      // Fastify plugin children are mounted explicitly; others are aliases of their argument.
      if (mounts.some((m) => m.child.key === key)) continue;
      for (const a of argumentsFor(node)) {
        const real = containersOf(a).find((r) => r.key !== key);
        if (real) {
          alias.set(key, real.key);
          break;
        }
      }
    }

    // Compose full paths from the roots down.
    const childrenOf = new Map<string, { prefix: string; child: string }[]>();
    const isChild = new Set<string>();
    for (const m of mounts) {
      const p = find(m.parent.key);
      const ch = find(m.child.key);
      if (p === ch) continue;
      childrenOf.set(p, [
        ...(childrenOf.get(p) ?? []),
        { prefix: m.prefix, child: ch },
      ]);
      isChild.add(ch);
    }
    const mwOf = new Map<string, { prefix: string; target: Target }[]>();
    for (const l of levelMw) {
      if (!meaningful(l.target)) continue;
      const k = find(l.container.key);
      mwOf.set(k, [
        ...(mwOf.get(k) ?? []),
        { prefix: l.prefix, target: l.target },
      ]);
    }
    const regsOf = new Map<string, Reg[]>();
    for (const r of regs) {
      const k = find(r.container.key);
      regsOf.set(k, [...(regsOf.get(k) ?? []), r]);
    }
    const join = (...parts: string[]) =>
      `/${parts
        .map((p) => p.replace(/^\/+|\/+$/g, ""))
        .filter(Boolean)
        .join("/")}`;
    const matches = (prefix: string, p: string) => {
      if (!prefix || prefix === "/" || prefix === "*" || prefix === "/*")
        return true;
      const base = prefix.replace(/\/?\*+$/, "");
      return p === base || p.startsWith(`${base.replace(/\/$/, "")}/`);
    };
    const emitted = new Set<string>();
    const walkTree = (
      k: string,
      prefix: string,
      inherited: Target[],
      depth: number,
      rootKey: string,
    ) => {
      if (depth > 12) return;
      const c = containers.get(k);
      const own = join(prefix, c?.prefix ?? "");
      const mws = (mwOf.get(k) ?? []).map((m) => ({
        prefix: join(own, m.prefix),
        target: m.target,
      }));
      for (const r of regsOf.get(k) ?? []) {
        const full =
          r.path === "<dynamic>" ? `${own}/<dynamic>` : join(own, r.path);
        const key = `${r.method} ${full} ${r.file}:${r.line}`;
        if (emitted.has(key)) continue;
        emitted.add(key);
        routes.push({
          framework: c?.framework ?? r.container.framework,
          method: r.method,
          path: full,
          file: r.file,
          line: r.line,
          handler: r.handler,
          middleware: [
            ...inherited,
            ...mws.filter((m) => matches(m.prefix, full)).map((m) => m.target),
            ...r.middleware,
          ].filter(meaningful),
          pkg: pkgOf(r.file)?.dir ?? ".",
        });
      }
      for (const ch of childrenOf.get(k) ?? [])
        walkTree(
          ch.child,
          join(own, ch.prefix),
          [
            ...inherited,
            ...mws
              .filter((m) => matches(m.prefix, join(own, ch.prefix)))
              .map((m) => m.target),
          ],
          depth + 1,
          rootKey,
        );
    };
    const roots = [...new Set([...containers.keys()].map(find))].filter(
      (k) => !isChild.has(k),
    );
    for (const k of roots) {
      walkTree(k, "", [], 0, k);
      const c = containers.get(k);
      // Root-level middleware without a path covers every route of that app.
      for (const m of mwOf.get(k) ?? [])
        if (
          c &&
          (!m.prefix ||
            m.prefix === "/" ||
            m.prefix === "*" ||
            m.prefix === "/*")
        )
          globals.push({
            framework: c.framework,
            file: c.file,
            line: 1,
            target: m.target,
            scope: "all",
            pkg: pkgOf(c.file)?.dir ?? ".",
          });
        else if (c)
          globals.push({
            framework: c.framework,
            file: c.file,
            line: 1,
            target: m.target,
            scope: [m.prefix],
            pkg: pkgOf(c.file)?.dir ?? ".",
          });
      // Routers that are never mounted and not apps: their routes still count, with no prefix.
    }
    for (const r of routes) {
      if (r.handler.unknown)
        unresolved.push({
          file: r.file,
          line: r.line,
          why: `the handler of ${r.method} ${r.path} could not be followed`,
        });
      for (const m of r.middleware)
        if (m.unknown)
          unresolved.push({
            file: r.file,
            line: r.line,
            why: `middleware "${m.text}" on ${r.method} ${r.path} could not be followed`,
          });
    }

    // --- NestJS: controllers, route decorators, guards
    for (const sf of sources) {
      const file = rel(root, safeReal(sf.fileName));
      const lineOf = (n: ts.Node) =>
        sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      const decoratorsOf = (n: ts.Node) =>
        (ts.canHaveDecorators(n) ? (ts.getDecorators(n) ?? []) : [])
          .map((d) => d.expression)
          .filter(ts.isCallExpression)
          .map((c) => {
            const id = leftmost(c.expression);
            return {
              name: c.expression.getText(),
              call: c,
              mod: id ? moduleOfIdentifier(id) : null,
            };
          })
          .filter((d) => d.mod === "@nestjs/common");
      const visit = (node: ts.Node) => {
        if (ts.isClassDeclaration(node)) {
          const decs = decoratorsOf(node);
          const ctrl = decs.find((d) => d.name === "Controller");
          if (ctrl) {
            const a = ctrl.call.arguments[0];
            const prefix = !a
              ? ""
              : ts.isStringLiteralLike(a)
                ? a.text
                : ts.isObjectLiteralExpression(a)
                  ? pathText(propOf(a, "path"))
                  : "<dynamic>";
            const guards = decs
              .filter(
                (d) => d.name === "UseGuards" || d.name === "UseInterceptors",
              )
              .flatMap((d) => d.call.arguments.map((x) => targetOf(x)));
            for (const m of node.members) {
              const mdecs = decoratorsOf(m);
              const route = mdecs.find((d) => NEST_METHODS[d.name]);
              if (!route) continue;
              const id = decl.get(m);
              const sfm = m.getSourceFile();
              routes.push({
                framework: "nestjs",
                method: NEST_METHODS[route.name] as string,
                path: join(prefix, pathText(route.call.arguments[0])),
                file,
                line: lineOf(m),
                handler: {
                  text: m.name?.getText() ?? "handler",
                  symbols: id ? [id] : [],
                  ranges: [
                    {
                      file,
                      start:
                        sfm.getLineAndCharacterOfPosition(m.getStart(sfm))
                          .line + 1,
                      end:
                        sfm.getLineAndCharacterOfPosition(m.getEnd()).line + 1,
                    },
                  ],
                  uses: [],
                  unknown: !id,
                },
                middleware: [
                  ...guards,
                  ...mdecs
                    .filter(
                      (d) =>
                        d.name === "UseGuards" || d.name === "UseInterceptors",
                    )
                    .flatMap((d) => d.call.arguments.map((x) => targetOf(x))),
                ],
                pkg: pkgOf(file)?.dir ?? ".",
              });
            }
          }
        }
        // Global guards, interceptors, pipes, middleware and prefix.
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression)
        ) {
          const n = node.expression.name.text;
          if (
            [
              "useGlobalGuards",
              "useGlobalInterceptors",
              "useGlobalPipes",
              "useGlobalFilters",
            ].includes(n)
          )
            for (const a of node.arguments)
              globals.push({
                framework: "nestjs",
                file,
                line: lineOf(node),
                target: targetOf(a),
                scope: "all",
                pkg: pkgOf(file)?.dir ?? ".",
              });
          if (
            n === "apply" &&
            /consumer|MiddlewareConsumer/i.test(
              node.expression.expression.getText(),
            )
          )
            for (const a of node.arguments)
              globals.push({
                framework: "nestjs",
                file,
                line: lineOf(node),
                target: targetOf(a),
                scope: "all",
                pkg: pkgOf(file)?.dir ?? ".",
              });
        }
        if (ts.isObjectLiteralExpression(node)) {
          const provide = propOf(node, "provide");
          if (
            provide &&
            /^APP_(GUARD|INTERCEPTOR|PIPE|FILTER)$/.test(provide.getText())
          ) {
            const v =
              propOf(node, "useClass") ??
              propOf(node, "useExisting") ??
              propOf(node, "useValue");
            if (v)
              globals.push({
                framework: "nestjs",
                file,
                line: lineOf(node),
                target: targetOf(v),
                scope: "all",
                pkg: pkgOf(file)?.dir ?? ".",
              });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    // A global prefix applies to every Nest route of that package.
    for (const sf of sources) {
      const file = rel(root, safeReal(sf.fileName));
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "setGlobalPrefix"
        ) {
          const p = pathText(node.arguments[0]);
          const pkg = pkgOf(file)?.dir ?? ".";
          for (const r of routes)
            if (r.framework === "nestjs" && r.pkg === pkg)
              r.path = join(p, r.path);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    // --- Next.js: app router, pages router, middleware/proxy, layouts
    for (const pkg of packages.filter((p) => p.frameworks.includes("nextjs"))) {
      const base = pkg.dir === "." ? "" : `${pkg.dir}/`;
      const inPkg = sources.filter((sf) => {
        const f = rel(root, safeReal(sf.fileName));
        return f.startsWith(base) && (pkgOf(f)?.dir ?? ".") === pkg.dir;
      });
      for (const sf of inPkg) {
        const file = rel(root, safeReal(sf.fileName));
        const local = file.slice(base.length);
        const lineOf = (n: ts.Node) =>
          sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        const appM =
          /^(?:src\/)?app\/(?:(.*)\/)?(route|page|layout)\.(?:[mc]?[jt]sx?)$/.exec(
            local,
          );
        const pagesM = /^(?:src\/)?pages\/(.*)\.(?:[mc]?[jt]sx?)$/.exec(local);
        const mwM = /^(?:src\/)?(middleware|proxy)\.(?:[mc]?[jt]s)$/.exec(
          local,
        );
        const exportsOf = () => {
          const out = new Map<string, string | null>();
          const modSym = checker.getSymbolAtLocation(sf);
          for (const e of modSym ? checker.getExportsOfModule(modSym) : []) {
            const ids = targetsOf(e);
            out.set(e.getName(), ids[0] ?? null);
          }
          return out;
        };
        if (appM) {
          const dir = appM[1] ?? "";
          if (dir.split("/").some((s) => s.startsWith("_"))) continue;
          const segs = dir
            .split("/")
            .filter(
              (s) =>
                s &&
                !(s.startsWith("(") && s.endsWith(")")) &&
                !s.startsWith("@"),
            )
            .map((s) =>
              s
                .replace(/^\[\[?\.\.\.(\w+)\]?\]$/, "*")
                .replace(/^\[(\w+)\]$/, ":$1"),
            );
          const routePath = join(...segs);
          const kind = appM[2];
          const ex = exportsOf();
          const here = (sym: string | null): Target => ({
            text: sym ?? file,
            symbols: sym ? [sym] : [],
            ranges: sym
              ? []
              : [
                  {
                    file,
                    start: 1,
                    end: sf.getLineAndCharacterOfPosition(sf.getEnd()).line + 1,
                  },
                ],
            uses: [],
            unknown: false,
          });
          if (kind === "route")
            for (const m of NEXT_METHODS)
              if (ex.has(m))
                routes.push({
                  framework: "nextjs",
                  method: m,
                  path: routePath,
                  file,
                  line: 1,
                  handler: here(ex.get(m) ?? null),
                  middleware: [],
                  pkg: pkg.dir,
                });
          if (kind === "page")
            routes.push({
              framework: "nextjs",
              method: "PAGE",
              path: routePath,
              file,
              line: 1,
              handler: here(ex.get("default") ?? null),
              middleware: [],
              pkg: pkg.dir,
            });
          if (kind === "layout")
            globals.push({
              framework: "nextjs",
              file,
              line: 1,
              target: here(ex.get("default") ?? null),
              scope: [`${routePath === "/" ? "" : routePath}/*`],
              pkg: pkg.dir,
            });
        } else if (pagesM) {
          const p = pagesM[1] ?? "";
          if (/(^|\/)_(app|document|error)$/.test(p)) {
            if (/(^|\/)_app$/.test(p))
              globals.push({
                framework: "nextjs",
                file,
                line: 1,
                target: {
                  text: file,
                  symbols: [...exportsOf().values()].filter((x): x is string =>
                    Boolean(x),
                  ),
                  ranges: [],
                  uses: [],
                  unknown: false,
                },
                scope: "all",
                pkg: pkg.dir,
              });
            continue;
          }
          const segs = p
            .split("/")
            .map((s) =>
              s
                .replace(/^\[\[?\.\.\.(\w+)\]?\]$/, "*")
                .replace(/^\[(\w+)\]$/, ":$1"),
            )
            .filter((s) => s !== "index");
          const ex = exportsOf();
          const def = ex.get("default") ?? null;
          routes.push({
            framework: "nextjs",
            method: p.startsWith("api/") || p === "api" ? "ALL" : "PAGE",
            path: join(...segs),
            file,
            line: 1,
            handler: {
              text: file,
              symbols: def ? [def] : [],
              ranges: def ? [] : [{ file, start: 1, end: 1_000_000 }],
              uses: [],
              unknown: false,
            },
            middleware: [],
            pkg: pkg.dir,
          });
        } else if (mwM) {
          const ex = exportsOf();
          const fnId = ex.get(mwM[1] as string) ?? ex.get("default") ?? null;
          let scope: "all" | string[] = "all";
          const visit = (n: ts.Node) => {
            if (
              ts.isVariableDeclaration(n) &&
              n.name.getText() === "config" &&
              n.initializer &&
              ts.isObjectLiteralExpression(n.initializer)
            ) {
              const m = propOf(n.initializer, "matcher");
              if (m && ts.isStringLiteralLike(m)) scope = [m.text];
              else if (
                m &&
                ts.isArrayLiteralExpression(m) &&
                m.elements.every((e) => ts.isStringLiteralLike(e))
              )
                scope = m.elements.map((e) => (e as ts.StringLiteralLike).text);
              else if (m)
                unresolved.push({
                  file,
                  line: lineOf(n),
                  why: "a middleware matcher that is not a plain list of paths; treated as every route",
                });
            }
            ts.forEachChild(n, visit);
          };
          visit(sf);
          globals.push({
            framework: "nextjs",
            file,
            line: 1,
            target: {
              text: file,
              symbols: fnId ? [fnId] : [],
              ranges: fnId ? [] : [{ file, start: 1, end: 1_000_000 }],
              uses: [],
              unknown: false,
            },
            scope,
            pkg: pkg.dir,
          });
        }
      }
    }
  }

  return {
    root,
    files: [...fileSet].map((f) => rel(root, f)).sort(),
    packages,
    symbols,
    edges: [...edges.values()],
    imports: [...imports.values()],
    externals: Object.fromEntries(
      [...externals].map(([f, s]) => [f, [...s].sort()]),
    ),
    jsx: [...jsx].sort(),
    routes,
    globals: globals.filter((g) => meaningful(g.target)),
    unresolved: dedupe(unresolved),
    stats: {
      files: fileSet.size,
      symbols: symbols.length,
      edges: edges.size,
      ms: Date.now() - t0,
      truncated,
    },
  };
}

/** A target that points at our code (a library middleware like express.json() does not). */
function meaningful(t: Target): boolean {
  return t.unknown || t.symbols.length > 0 || t.ranges.length > 0;
}
function emptyTarget(why: string): Target {
  return { text: why, symbols: [], ranges: [], uses: [], unknown: true };
}
function safeReal(f: string) {
  try {
    return realpathSync(f);
  } catch {
    return f;
  }
}
function findNodeAt(sf: ts.SourceFile, pos: number): ts.Node | null {
  let found: ts.Node | null = null;
  const visit = (n: ts.Node) => {
    if (n.getStart(sf) === pos && ts.isParameter(n)) found = n;
    if (!found && n.getStart(sf) <= pos && n.getEnd() >= pos)
      ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}
function dedupe(u: Unresolved[]) {
  const seen = new Set<string>();
  return u.filter((x) => {
    const k = `${x.file}:${x.line}:${x.why}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Run as a script: print the index of argv[2].
const entry = process.argv[1] ?? "";
if (/indexer\.mts$/.test(entry)) {
  const root = process.argv[2] ?? ".";
  const max = Number(process.argv[3] ?? 8000);
  process.stdout.write(JSON.stringify(buildIndex(root, max)));
}
