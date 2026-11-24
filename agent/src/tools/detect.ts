// Works out what kind of project a repository is from its file names and a few small files.
// Pure: no network, so it can be tested on its own.

export type Detection = {
  languages: string[];
  packageManager: "pnpm" | "npm" | "yarn" | "bun" | null;
  framework: string | null;
  commands: {
    install: string | null;
    build: string | null;
    test: string | null;
    lint: string | null;
    start: string | null;
  };
  hasTests: boolean;
  docker: { dockerfile: boolean; compose: boolean };
  ci: { provider: string | null; workflows: string[] };
  hasRoxConfig: boolean;
  notes: string[];
};

type PackageJson = {
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const LOCKFILES: [string, NonNullable<Detection["packageManager"]>][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

const INSTALL: Record<NonNullable<Detection["packageManager"]>, string> = {
  pnpm: "pnpm install --frozen-lockfile",
  npm: "npm ci",
  yarn: "yarn install --frozen-lockfile",
  bun: "bun install --frozen-lockfile",
};

const FRAMEWORKS: [string, string][] = [
  ["next", "Next.js"],
  ["nuxt", "Nuxt"],
  ["@remix-run/react", "Remix"],
  ["@sveltejs/kit", "SvelteKit"],
  ["@nestjs/core", "NestJS"],
  ["fastify", "Fastify"],
  ["express", "Express"],
  ["hono", "Hono"],
  ["koa", "Koa"],
  ["vite", "Vite"],
  ["react", "React"],
];

const NO_TEST = /no test specified/i;

export function parsePackageJson(
  text: string | null | undefined,
): PackageJson | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as PackageJson) : null;
  } catch {
    return null;
  }
}

export function detectProject(input: {
  rootNames: string[];
  packageJson: string | null;
  workflows: string[];
}): Detection {
  const names = new Set(input.rootNames);
  const has = (name: string) => names.has(name);
  const hasMatch = (re: RegExp) => input.rootNames.some((n) => re.test(n));
  const notes: string[] = [];

  const languages: string[] = [];
  const pkg = parsePackageJson(input.packageJson);
  if (has("package.json")) {
    if (!pkg)
      notes.push("package.json is there but could not be read as JSON.");
    languages.push(
      has("tsconfig.json") ||
        pkg?.devDependencies?.typescript ||
        pkg?.dependencies?.typescript
        ? "TypeScript"
        : "JavaScript",
    );
  }
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py"))
    languages.push("Python");
  if (has("go.mod")) languages.push("Go");
  if (has("Cargo.toml")) languages.push("Rust");
  if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts"))
    languages.push("Java/Kotlin");

  let packageManager: Detection["packageManager"] = null;
  if (has("package.json")) {
    packageManager = LOCKFILES.find(([file]) => has(file))?.[1] ?? null;
    if (!packageManager && pkg?.packageManager) {
      const declared = pkg.packageManager.split("@")[0];
      if (
        declared === "pnpm" ||
        declared === "npm" ||
        declared === "yarn" ||
        declared === "bun"
      )
        packageManager = declared;
    }
    if (!packageManager)
      notes.push("No lockfile found: installs would not be reproducible.");
  }

  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const framework = FRAMEWORKS.find(([dep]) => dep in deps)?.[1] ?? null;

  const scripts = pkg?.scripts ?? {};
  const pm = packageManager ?? "npm";
  const run = (script: string) =>
    script in scripts ? `${pm} run ${script}` : null;
  const testScript =
    scripts.test && !NO_TEST.test(scripts.test) ? scripts.test : null;

  const commands: Detection["commands"] = {
    install: packageManager ? INSTALL[packageManager] : null,
    build: run("build"),
    test: testScript ? (pm === "npm" ? "npm test" : `${pm} run test`) : null,
    lint: run("lint"),
    start: run("start") ?? run("dev"),
  };

  if (
    languages.includes("Python") &&
    !languages.includes("JavaScript") &&
    !languages.includes("TypeScript")
  ) {
    commands.install = has("requirements.txt")
      ? "pip install -r requirements.txt"
      : "pip install .";
    commands.test = "pytest";
  }
  if (languages.includes("Go") && languages.length === 1) {
    commands.install = "go mod download";
    commands.build = "go build ./...";
    commands.test = "go test ./...";
  }

  const hasTests =
    commands.test !== null ||
    hasMatch(/^(jest|vitest|playwright|cypress)\.config\./) ||
    has("tests") ||
    has("test") ||
    has("__tests__") ||
    has("pytest.ini");
  if (!hasTests)
    notes.push(
      "No tests were found. Rox cannot prove a fix without a test that fails first.",
    );

  return {
    languages,
    packageManager,
    framework,
    commands,
    hasTests,
    docker: {
      dockerfile: has("Dockerfile"),
      compose: hasMatch(/^(docker-)?compose\.ya?ml$/),
    },
    ci: {
      provider: input.workflows.length > 0 ? "GitHub Actions" : null,
      workflows: input.workflows,
    },
    hasRoxConfig: has(".agentwatchdog.yml"),
    notes,
  };
}
