// What this version of Rox supports, in one place. The indexer (in the sandbox) and the host code
// both read it, so the language gate's message always names what the route map really handles.
// Erasable TypeScript only: Node runs this file directly inside the sandbox.

/** The only source languages Rox reads: JavaScript and TypeScript. */
export const SOURCE_EXT = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/** Module name → framework, for frameworks the route map understands. */
export const MAPPED: Record<string, string> = {
  express: "express",
  fastify: "fastify",
  hono: "hono",
  koa: "koa",
  "@koa/router": "koa",
  "koa-router": "koa",
  "@nestjs/core": "nestjs",
  "@nestjs/common": "nestjs",
  next: "nextjs",
};

/** How each mapped framework is named to people. */
export const FRAMEWORK_NAMES: Record<string, string> = {
  express: "Express",
  fastify: "Fastify",
  hono: "Hono",
  koa: "Koa",
  nestjs: "NestJS",
  nextjs: "Next.js (App Router and Pages)",
};

/** Test runners the checks know how to run. */
export const TEST_RUNNERS = ["Vitest", "Jest"];

/**
 * JavaScript server frameworks without a route adapter yet. A repository using one is still
 * checked, but its routes count as unknown, so every route-dependent check runs.
 */
export const UNMAPPED = [
  "restify",
  "@hapi/hapi",
  "hapi",
  "@trpc/server",
  "@apollo/server",
  "apollo-server",
  "graphql-yoga",
  "@remix-run/node",
  "@remix-run/server-runtime",
  "@react-router/node",
  "@sveltejs/kit",
  "nuxt",
  "astro",
  "elysia",
  "polka",
  "micro",
  "h3",
  "nitropack",
  "@feathersjs/feathers",
  "@adonisjs/core",
  "sails",
  "@loopback/core",
];

/** Source files of other programming languages, by extension. Rox stops when a PR changes one. */
export const OTHER_LANGUAGES: Record<string, string> = {
  ".py": "Python",
  ".pyi": "Python",
  ".ipynb": "Python (notebook)",
  ".go": "Go",
  ".rb": "Ruby",
  ".erb": "Ruby",
  ".java": "Java",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".scala": "Scala",
  ".groovy": "Groovy",
  ".rs": "Rust",
  ".php": "PHP",
  ".cs": "C#",
  ".fs": "F#",
  ".vb": "Visual Basic",
  ".swift": "Swift",
  ".m": "Objective-C",
  ".mm": "Objective-C++",
  ".c": "C",
  ".h": "C/C++",
  ".cc": "C++",
  ".cpp": "C++",
  ".cxx": "C++",
  ".hpp": "C++",
  ".dart": "Dart",
  ".ex": "Elixir",
  ".exs": "Elixir",
  ".erl": "Erlang",
  ".clj": "Clojure",
  ".cljs": "ClojureScript",
  ".hs": "Haskell",
  ".lua": "Lua",
  ".pl": "Perl",
  ".pm": "Perl",
  ".r": "R",
  ".jl": "Julia",
  ".ml": "OCaml",
  ".zig": "Zig",
  ".nim": "Nim",
  ".sol": "Solidity",
  ".elm": "Elm",
  ".coffee": "CoffeeScript",
  ".res": "ReScript",
  ".vue": "Vue single-file components",
  ".svelte": "Svelte components",
  ".astro": "Astro components",
};

export const frameworkOfModule = (m: string): string | null => {
  if (MAPPED[m]) return MAPPED[m];
  const top = m.startsWith("@")
    ? m.split("/").slice(0, 2).join("/")
    : m.split("/")[0];
  return MAPPED[top ?? ""] ?? null;
};

/** The package a bare import names: "@scope/pkg/x" → "@scope/pkg", "pkg/x" → "pkg". */
export const packageOf = (spec: string): string | null => {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#"))
    return null;
  if (spec.startsWith("node:")) return spec;
  const parts = spec.split("/");
  return spec.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? null);
};
