// U1 (part 2): the change profile. Every changed file gets one or more kinds, each with the reason,
// so a reader can see why. The evidence is general: what the code index says the file does
// (defines routes, is used as middleware, renders JSX), which libraries it imports (an auth or
// database library), what its code touches (cookies, sessions, credentials), and the conventions of
// the JavaScript ecosystem (lockfiles, test file names, CI and container files). Nothing here names
// a repository, folder layout or project.
import path from "node:path";
import type { Index } from "./code-index/indexer.mts";
import { classify, type FileChange } from "./gate";
import type { Reach } from "./reach";
import { packageOfFile, type Stack } from "./stack";

export type Kind =
  | "route"
  | "middleware"
  | "auth"
  | "data"
  | "server-logic"
  | "library"
  | "ui"
  | "agent-prompt"
  | "deps"
  | "infra"
  | "config"
  | "tests"
  | "docs"
  | "other";

export type FileProfile = {
  path: string;
  status: FileChange["status"];
  kinds: Kind[];
  reasons: string[];
};

export type ChangeProfile = {
  kinds: Kind[];
  filesByKind: Partial<Record<Kind, string[]>>;
  files: FileProfile[];
};

// Library tables: what a package does, not who uses it.
const AUTH_LIBS = [
  "jsonwebtoken",
  "jose",
  "jwt-decode",
  "express-jwt",
  "passport",
  "bcrypt",
  "bcryptjs",
  "argon2",
  "next-auth",
  "better-auth",
  "express-session",
  "cookie-session",
  "iron-session",
  "lucia",
  "oslo",
  "otplib",
  "speakeasy",
  "openid-client",
  "oauth4webapi",
  "csurf",
  "keycloak-connect",
  "firebase-admin",
  "@fastify/jwt",
  "@fastify/session",
  "@fastify/cookie",
  "@fastify/auth",
  "@nestjs/passport",
  "@nestjs/jwt",
  "hono/jwt",
  "hono/basic-auth",
  "hono/bearer-auth",
  "@clerk/nextjs",
  "@clerk/express",
  "@clerk/backend",
  "@auth0/nextjs-auth0",
  "express-openid-connect",
  "@supabase/auth-helpers-nextjs",
  "@supabase/ssr",
  "@simplewebauthn/server",
];
const AUTH_PREFIXES = [
  "passport-",
  "@auth/",
  "@clerk/",
  "@okta/",
  "@workos-inc/",
];
const DB_LIBS = [
  "pg",
  "postgres",
  "mysql",
  "mysql2",
  "better-sqlite3",
  "sqlite3",
  "sqlite",
  "@prisma/client",
  "prisma",
  "drizzle-orm",
  "typeorm",
  "sequelize",
  "mongoose",
  "mongodb",
  "knex",
  "kysely",
  "ioredis",
  "redis",
  "@upstash/redis",
  "@supabase/supabase-js",
  "@planetscale/database",
  "@neondatabase/serverless",
  "@libsql/client",
  "@vercel/postgres",
  "@aws-sdk/client-dynamodb",
  "@aws-sdk/lib-dynamodb",
  "firebase-admin",
  "@google-cloud/firestore",
  "@mikro-orm/core",
  "objection",
  "node:sqlite",
];
const LLM_LIBS = [
  "openai",
  "@anthropic-ai/sdk",
  "langchain",
  "ai",
  "@google/generative-ai",
  "@google/genai",
  "cohere-ai",
  "groq-sdk",
  "ollama",
  "llamaindex",
  "@mistralai/mistralai",
  "@modelcontextprotocol/sdk",
];
const LLM_PREFIXES = ["@langchain/", "@ai-sdk/", "@openai/", "@anthropic-ai/"];

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
]);
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "overrides",
  "resolutions",
  "pnpm",
  "packageManager",
  "engines",
];

/** Code that handles credentials, sessions or identity. Counted in server-side files only. */
const AUTH_CODE =
  /\b(?:req|request|ctx|c|event)\.(?:cookies|signedCookies|session|user|auth)\b|\bheaders?\b[^\n]{0,40}\bauthorization\b|['"]authorization['"]|\bcookies\(\)|\bset[-_]?cookie\b|\bclearCookie\b|\bjwt\b|\bbearer\b|\bpassword(?:Hash)?\b|\btimingSafeEqual\b|\bcsrf\b|\bsession(?:Id|Token)\b|\bsignIn\b|\bsignOut\b|\bcanActivate\b|\bisAuthenticated\b/i;
const AUTH_NAME =
  /auth|login|logout|sign.?in|session|role|permission|guard|acl|rbac|policy|token|jwt|oauth|password|credential|identity/i;

const TEST_FILE =
  /(^|\/)(__tests__|__mocks__|__fixtures__|tests?|specs?|e2e|cypress|playwright)\/|\.(test|spec|e2e|cy|stories)\.[mc]?[jt]sx?$/;
const DOC_EXT = new Set([".md", ".mdx", ".rst", ".adoc", ".txt"]);
const STYLE_EXT = new Set([
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".styl",
  ".pcss",
  ".html",
  ".htm",
]);
const INFRA =
  /(^|\/)(Dockerfile|Containerfile)(\.[\w.-]+)?$|\.dockerfile$|(^|\/)\.dockerignore$|(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$|(^|\/)\.github\/(workflows|actions)\/|(^|\/)\.gitlab-ci\.ya?ml$|(^|\/)\.circleci\/|(^|\/)Jenkinsfile$|(^|\/)(azure-pipelines|bitbucket-pipelines|cloudbuild|buildspec|serverless|render|app|apprunner)\.ya?ml$|\.(tf|tfvars|hcl)$|(^|\/)Chart\.yaml$|(^|\/)(Procfile|vercel\.json|netlify\.toml|fly\.toml|wrangler\.(toml|jsonc?)|railway\.(json|toml)|nixpacks\.toml)$|(^|\/)nginx[\w.-]*\.conf$|\.(sh|bash|ps1|bat|cmd)$/;
const CONFIG =
  /(^|\/)(tsconfig|jsconfig)(\.[\w-]+)?\.json$|(^|\/)[\w.-]+\.config\.[mc]?[jt]s$|(^|\/)\.(eslintrc|prettierrc|babelrc|swcrc|stylelintrc|npmrc|nvmrc|node-version|editorconfig|browserslistrc|env\.example|env\.sample|env\.template)([\w.]*)$|(^|\/)(biome|turbo|nx|lerna|vercel|components)\.jsonc?$|(^|\/)pnpm-workspace\.yaml$|\.(json|jsonc|ya?ml|toml|ini)$/;

/**
 * @param read Reads a file's text at the head commit (null when missing).
 * @param readBase Reads a file's text at the base commit (null when missing).
 */
export async function profileChange(o: {
  changes: FileChange[];
  stack: Stack;
  head: Index;
  base: Index | null;
  reach: Reach;
  read: (file: string) => Promise<string | null>;
  readBase: (file: string) => Promise<string | null>;
}): Promise<ChangeProfile> {
  const { head, base, reach } = o;
  const symFile = new Map<string, string>();
  for (const idx of [head, base])
    for (const s of idx?.symbols ?? []) symFile.set(s.id, s.file);
  const fileOf = (id: string) => symFile.get(id) ?? id.split("#")[0] ?? "";

  // What the index says each file does.
  const routeFiles = new Map<string, string>();
  const mwFiles = new Map<string, string>();
  for (const idx of [head, base])
    for (const r of idx?.routes ?? []) {
      routeFiles.set(r.file, `registers ${r.method} ${r.path}`);
      for (const id of r.handler.symbols)
        if (!routeFiles.has(fileOf(id)))
          routeFiles.set(fileOf(id), `handles ${r.method} ${r.path}`);
      for (const m of r.middleware)
        for (const id of m.symbols)
          mwFiles.set(
            fileOf(id),
            `"${m.text}" runs before ${r.method} ${r.path}`,
          );
    }
  for (const idx of [head, base])
    for (const g of idx?.globals ?? []) {
      const where = g.scope === "all" ? "every route" : g.scope.join(", ");
      mwFiles.set(g.file, `${g.framework} middleware or layout for ${where}`);
      for (const id of g.target.symbols)
        mwFiles.set(fileOf(id), `"${g.target.text}" runs for ${where}`);
    }
  for (const r of reach.routes)
    if (/new|removed|chain changed/.test(r.why) && !routeFiles.has(r.file))
      routeFiles.set(r.file, `${r.method} ${r.path}: ${r.why}`);
  const jsx = new Set([...head.jsx, ...(base?.jsx ?? [])]);
  const externals = (f: string) => [
    ...(head.externals[f] ?? []),
    ...(base?.externals[f] ?? []),
  ];
  const reachedFiles = new Set(
    reach.routes.length ? reach.changedSymbols.map((c) => fileOf(c.id)) : [],
  );

  const files: FileProfile[] = [];
  for (const c of o.changes) {
    const kinds = new Set<Kind>();
    const reasons: string[] = [];
    const k = (kind: Kind, why: string) => {
      kinds.add(kind);
      reasons.push(`${kind}: ${why}`);
    };
    const f = c.path;
    const name = path.posix.basename(f);
    const ext = path.posix.extname(f).toLowerCase();
    const cls = classify(f);
    const pkg = packageOfFile(o.stack, f);
    const isTest = TEST_FILE.test(f);

    if (isTest) k("tests", "a test file by name or folder");
    if (LOCKFILES.has(name)) k("deps", "a lockfile");
    if (name === "package.json") {
      const [a, b] = [parse(await o.readBase(f)), parse(await o.read(f))];
      const changedFields = DEP_FIELDS.filter(
        (x) => JSON.stringify(a[x] ?? null) !== JSON.stringify(b[x] ?? null),
      );
      if (changedFields.length)
        k("deps", `package.json ${changedFields.join(", ")} changed`);
      else k("config", "package.json changed outside its dependencies");
    }
    if (INFRA.test(f))
      k("infra", "a container, CI, deployment or shell script file");
    else if (
      (ext === ".yaml" || ext === ".yml") &&
      /^\s*apiVersion:/m.test((await o.read(f)) ?? "") &&
      /^\s*kind:/m.test((await o.read(f)) ?? "")
    )
      k("infra", "a Kubernetes manifest");
    if (/(^|\/)prompts?\//i.test(f) || /\.prompt(\.|$)/i.test(name))
      k("agent-prompt", "a prompt file");
    if (DOC_EXT.has(ext) && !kinds.has("agent-prompt"))
      k("docs", "documentation");
    if (STYLE_EXT.has(ext)) k("ui", "styles or markup");
    if (
      ext === ".sql" ||
      ext === ".prisma" ||
      /(^|\/)(migrations?|seeds?)\//.test(f)
    )
      k("data", "a schema, migration or seed file");

    if (cls.kind === "source" && !isTest) {
      const ex = externals(f);
      const auth = ex.filter(
        (m) =>
          AUTH_LIBS.includes(m) || AUTH_PREFIXES.some((p) => m.startsWith(p)),
      );
      const db = ex.filter((m) => DB_LIBS.includes(m));
      const llm = ex.filter(
        (m) =>
          LLM_LIBS.includes(m) || LLM_PREFIXES.some((p) => m.startsWith(p)),
      );
      const isUi = jsx.has(f);
      if (routeFiles.has(f)) k("route", routeFiles.get(f) as string);
      if (mwFiles.has(f)) k("middleware", mwFiles.get(f) as string);
      if (auth.length) k("auth", `imports ${auth.join(", ")}`);
      if (db.length) k("data", `imports ${db.join(", ")}`);
      if (llm.length) k("agent-prompt", `imports ${llm.join(", ")}`);
      if (isUi) k("ui", "renders JSX");
      if (!isUi && !auth.length) {
        const text = (await o.read(f)) ?? (await o.readBase(f)) ?? "";
        const m = AUTH_CODE.exec(text);
        if (m) k("auth", `its code handles "${m[0]}"`);
        else if (mwFiles.has(f) && AUTH_NAME.test(mwFiles.get(f) ?? ""))
          k("auth", "it is middleware with an auth-like name");
      }
      const server =
        Boolean(
          pkg?.frameworks.some((x) => x !== "nextjs") ||
            pkg?.unmappedServer.length,
        ) ||
        reachedFiles.has(f) ||
        routeFiles.has(f) ||
        mwFiles.has(f);
      if (!isUi && server)
        k(
          "server-logic",
          reachedFiles.has(f)
            ? "its changed code is reached from a route"
            : "code in a server package",
        );
      else if (!isUi && !kinds.size)
        k("library", "shared code outside any server or UI package");
    }
    if (cls.kind === "neutral" && !kinds.size && CONFIG.test(f))
      k("config", "a configuration file");
    if (!kinds.size)
      k(
        "other",
        cls.kind === "other-language"
          ? `${cls.language} file`
          : "no category applies",
      );
    files.push({
      path: f,
      status: c.status,
      kinds: [...kinds].sort(),
      reasons,
    });
  }

  const filesByKind: Partial<Record<Kind, string[]>> = {};
  for (const fp of files)
    for (const kind of fp.kinds)
      filesByKind[kind] = [...(filesByKind[kind] ?? []), fp.path];
  return {
    kinds: (Object.keys(filesByKind) as Kind[]).sort(),
    filesByKind,
    files,
  };
}

function parse(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}
