// U0: the language gate. Runs first, before anything is installed or any model is called, and only
// looks at file names. Rox reads JavaScript and TypeScript only:
//   - a pull request that adds or changes a source file of another language is stopped, with a
//     fixed message that names what this version supports;
//   - a repository with no JavaScript or TypeScript at all is stopped the same way;
//   - other-language files the change does not touch (helper scripts, tooling) do not matter, and
//     config, docs, styles, data and infra files never stop a run (the security scanners read them).
import path from "node:path";
import {
  FRAMEWORK_NAMES,
  OTHER_LANGUAGES,
  SOURCE_EXT,
  TEST_RUNNERS,
} from "./code-index/support.mts";

export type FileChange = {
  /** A added, M modified, D deleted, R renamed (the new path), C copied, T type changed. */
  status: "A" | "M" | "D" | "R" | "C" | "T" | "U" | "X";
  path: string;
  /** The old path, for a rename or copy. */
  from?: string;
};

export type FileClass =
  | { kind: "source"; language: "JavaScript" | "TypeScript" }
  | { kind: "other-language"; language: string }
  | { kind: "neutral" };

export type GateResult = {
  ok: boolean;
  /** Why the run stopped, in the exact words Rox says. Null when it goes on. */
  message: string | null;
  /** Changed files in a language Rox does not read. */
  blocked: { path: string; language: string }[];
  /** How many changed files are JavaScript or TypeScript. */
  sourceFiles: number;
  /** Other-language files the repository has but the change does not touch (just noted). */
  untouchedOtherLanguages: string[];
};

export function classify(file: string): FileClass {
  const ext = path.posix.extname(file).toLowerCase();
  if (SOURCE_EXT.includes(ext))
    return {
      kind: "source",
      language: /\.[mc]?tsx?$/.test(ext) ? "TypeScript" : "JavaScript",
    };
  const other = OTHER_LANGUAGES[ext];
  if (other) return { kind: "other-language", language: other };
  return { kind: "neutral" };
}

/** What this version supports, in one sentence each. Built from the same tables the indexer uses. */
export function supportStatement(): string {
  return [
    `This version of Rox works only on JavaScript and TypeScript (${SOURCE_EXT.join(", ")}).`,
    `Route maps: ${Object.values(FRAMEWORK_NAMES).join(", ")}.`,
    `Test runners: ${TEST_RUNNERS.join(", ")}.`,
  ].join(" ");
}

/**
 * @param changes What the pull request changed (from `git diff --name-status`).
 * @param repoFiles Every file in the repository at head (paths relative to its root).
 */
export function languageGate(
  changes: FileChange[],
  repoFiles: string[],
): GateResult {
  // A deleted file adds no code in its language, so it does not stop the run.
  const touched = changes.filter((c) => c.status !== "D");
  const blocked = touched
    .map((c) => ({ path: c.path, c: classify(c.path) }))
    .filter((x) => x.c.kind === "other-language")
    .map((x) => ({
      path: x.path,
      language: (x.c as { language: string }).language,
    }));
  const sourceFiles = touched.filter(
    (c) => classify(c.path).kind === "source",
  ).length;
  const repoHasSource = repoFiles.some(
    (f) =>
      classify(f).kind === "source" &&
      !f.split("/").includes("node_modules") &&
      !/\.d\.[mc]?ts$/.test(f),
  );
  const repoHasPackage = repoFiles.some(
    (f) => f === "package.json" || f.endsWith("/package.json"),
  );
  const changedPaths = new Set(touched.map((c) => c.path));
  const untouchedOtherLanguages = [
    ...new Set(
      repoFiles
        .filter(
          (f) => !changedPaths.has(f) && classify(f).kind === "other-language",
        )
        .map((f) => (classify(f) as { language: string }).language),
    ),
  ].sort();

  if (blocked.length) {
    const languages = [...new Set(blocked.map((b) => b.language))];
    const sample = blocked
      .slice(0, 5)
      .map((b) => b.path)
      .join(", ");
    return {
      ok: false,
      message: `Sorry, I stopped without checking this change. ${supportStatement()} This change includes ${languages.join(", ")} files (${sample}${blocked.length > 5 ? `, and ${blocked.length - 5} more` : ""}), which I cannot read yet.`,
      blocked,
      sourceFiles,
      untouchedOtherLanguages,
    };
  }
  if (!repoHasSource || !repoHasPackage) {
    return {
      ok: false,
      message: `Sorry, I stopped without checking this change. ${supportStatement()} This repository has ${repoHasSource ? "no package.json" : "no JavaScript or TypeScript source"}, so there is nothing I can check.`,
      blocked,
      sourceFiles,
      untouchedOtherLanguages,
    };
  }
  return {
    ok: true,
    message: null,
    blocked,
    sourceFiles,
    untouchedOtherLanguages,
  };
}
