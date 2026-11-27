// What the Engineer may change. Enforced here, on the host, for every edit and again for the
// final patch. A prompt is never the thing that stops a forbidden change.

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

const FORBIDDEN: [RegExp, string][] = [
  [/(^|\/)(test|tests|__tests__|e2e)\//, "tests are the exam, not the answer"],
  [/\.(test|spec)\.\w+$/, "tests are the exam, not the answer"],
  [
    /(^|\/)(migrations|auth|secrets)\//,
    "a protected folder; a human must change it",
  ],
  [/(^|\/)\./, "a hidden file or folder (CI, env, config)"],
  [
    /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/,
    "dependencies and scripts",
  ],
  [
    /(^|\/)(tsconfig[^/]*\.json|biome\.jsonc?|[^/]+\.config\.\w+)$/,
    "tool configuration",
  ],
];

/** Why a file may not be edited, or null when it may. */
export function editDenied(path: string): string | null {
  const clean = path.replaceAll("\\", "/").replace(/^\.?\//, "");
  if (clean.includes("..")) return "outside the repository";
  for (const [re, why] of FORBIDDEN) if (re.test(clean)) return why;
  if (!SOURCE.test(clean))
    return "only source files (ts, tsx, js) may be changed";
  return null;
}

export const PATCH_LIMITS = { files: 5, lines: 120 };

/** Lines that hide a problem instead of fixing it. Only added lines are looked at. */
const CHEATS: [RegExp, string][] = [
  [/@ts-(ignore|nocheck|expect-error)/, "silences the type checker"],
  [/(biome|eslint)-(ignore|disable)/, "silences the linter"],
  [/\b(it|test|describe)\.(skip|todo|only)\b/, "skips tests"],
  [
    /process\.env\.(CI|VITEST|NODE_ENV|TEST)\b|import\.meta\.vitest/,
    "behaves differently under test",
  ],
  [/catch\s*(\([^)]*\))?\s*\{\s*\}/, "swallows an error"],
  [
    /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/,
    "turns off TLS checks",
  ],
  [/\b(eval|Function)\s*\(/, "runs code from a string"],
];

export type PatchFacts = {
  files: string[];
  added: number;
  removed: number;
  problems: string[];
};

/** Reads a unified diff and lists everything about it that breaks the rules. */
export function inspectPatch(patch: string): PatchFacts {
  const files: string[] = [];
  const problems: string[] = [];
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      files.push(header[2] as string);
      continue;
    }
    if (
      /^(new|old|deleted) (file )?mode|^similarity index|^rename |^GIT binary|^Binary files/.test(
        line,
      )
    ) {
      if (/^deleted file/.test(line)) problems.push(`deletes ${files.at(-1)}`);
      if (/^rename|^Binary|^GIT binary/.test(line))
        problems.push(`renames or changes a binary: ${files.at(-1)}`);
      if (/^new file mode 120000/.test(line))
        problems.push(`adds a symbolic link: ${files.at(-1)}`);
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      added++;
      for (const [re, why] of CHEATS)
        if (re.test(line))
          problems.push(
            `${files.at(-1)}: ${why}: ${line.slice(1).trim().slice(0, 80)}`,
          );
    } else if (line.startsWith("-")) removed++;
  }
  for (const f of files) {
    const why = editDenied(f);
    if (why) problems.push(`${f} may not be changed: ${why}`);
  }
  if (files.length === 0) problems.push("the patch is empty");
  if (files.length > PATCH_LIMITS.files)
    problems.push(
      `${files.length} files changed, the limit is ${PATCH_LIMITS.files}`,
    );
  if (added + removed > PATCH_LIMITS.lines)
    problems.push(
      `${added + removed} lines changed, the limit is ${PATCH_LIMITS.lines}`,
    );
  return { files, added, removed, problems };
}
