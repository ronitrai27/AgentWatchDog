// The only things an agent can do. Every tool runs inside the sandbox; the working copy comes from
// the runtime context, so no agent can reach another run's. Refusals are answers, not exceptions:
// the model reads them and adjusts.
import { type ToolRuntime, tool } from "@langchain/core/tools";
import * as z from "zod";
import { CODE_TOOLS } from "./code-tools";
import { tidy } from "./gates";
import { editDenied } from "./policy";
import type { Spend } from "./spend";
import type { Workspace } from "./workspace";

/** What a running agent works with. Never in the graph state, so never in a checkpoint. */
export const AgentContext = z.object({
  run: z.string(),
  step: z.string(),
  ws: z.custom<Workspace>(),
  spend: z.custom<Spend>(),
  /** The workspaces whose tests may be run. */
  workspaces: z.array(z.string()),
});
export type AgentContext = z.infer<typeof AgentContext>;
type Run = ToolRuntime<unknown, typeof AgentContext>;

const show = (r: Record<string, unknown> & { ok: boolean; error?: string }) =>
  r.ok ? null : `REFUSED: ${r.error}`;

export const listFiles = tool(
  async ({ dir }, rt: Run) => {
    const r = await rt.context.ws.file("list", { dir });
    return show(r) ?? (r.files as string[]).join("\n").slice(0, 5000);
  },
  {
    name: "list_files",
    description: "List the files under a folder of the repository.",
    schema: z.object({ dir: z.string().describe('Such as "apps/api/src"') }),
  },
);

export const searchCode = tool(
  async ({ text, dir }, rt: Run) => {
    const r = await rt.context.ws.file("search", { text, dir: dir || "." });
    if (!r.ok) return `REFUSED: ${r.error}`;
    const found = r.matches as string[];
    if (!found.length) return "No matches. Try a shorter or different text.";
    const more = Number(r.more) ? `\n(${r.more} more; search narrower)` : "";
    return found.join("\n").slice(0, 4000) + more;
  },
  {
    name: "search_code",
    description:
      "Find an exact text (not a pattern) in the source. Returns path:line:text.",
    schema: z.object({
      text: z.string().min(2),
      dir: z.string().nullable().describe("Only under this folder, or null"),
    }),
  },
);

export const readFile = tool(
  async ({ path, from }, rt: Run) => {
    const r = await rt.context.ws.file("read", { path, from: from ?? 1 });
    return show(r) ?? `${r.path} (${r.lines} lines)\n${r.text}`;
  },
  {
    name: "read_file",
    description:
      "Read up to 150 lines of a file. Each line starts with its number and a tab, which are not part of the file.",
    schema: z.object({
      path: z.string(),
      from: z.number().int().nullable().describe("First line, or null for 1"),
    }),
  },
);

export const runTests = tool(
  async ({ workspace, files }, rt: Run) => {
    if (!rt.context.workspaces.includes(workspace))
      return `REFUSED: workspace must be one of ${rt.context.workspaces.join(", ")}`;
    const clean = files.map((f) => f.replace(`${workspace}/`, ""));
    if (clean.some((f) => !/^[\w./-]+$/.test(f) || f.startsWith("-")))
      return "REFUSED: files must be plain paths of test files";
    const r = await rt.context.ws.tests(workspace, clean);
    if (!r.cases.length) return `No test ran:\n${r.output.slice(-900)}`;
    const bad = r.cases.filter((c) => c.failed);
    return bad.length
      ? `${bad.length} of ${r.cases.length} failed\n${bad
          .slice(0, 4)
          .map((c) => `- ${c.name}\n${c.message.slice(0, 500)}`)
          .join("\n")}`
      : `All ${r.cases.length} passed.`;
  },
  {
    name: "run_tests",
    description:
      "Run test files of one workspace (all of its tests when files is empty).",
    schema: z.object({
      workspace: z.string().describe('Such as "apps/api"'),
      files: z.array(z.string()).max(5),
    }),
  },
);

export const editFile = tool(
  async ({ path, old_text, new_text }, rt: Run) => {
    const why = editDenied(path);
    if (why) return `REFUSED: ${path} may not be changed: ${why}`;
    const { ws } = rt.context;
    const r = await ws.file("edit", { path, old_text, new_text });
    if (!r.ok) return `REFUSED: ${r.error}`;
    await tidy(ws, [String(r.edited)]);
    return `Edited ${r.edited}. Run the failing tests now.`;
  },
  {
    name: "edit_file",
    description:
      "Replace one exact piece of a source file. old_text must be copied exactly from read_file and appear once.",
    schema: z.object({
      path: z.string(),
      old_text: z.string().min(1),
      new_text: z.string(),
    }),
  },
);

/**
 * U5: the read tools. `search_code` is Agent_2's upgraded search (regex, word, glob, context,
 * every JS/TS extension); find_symbol, outline_file, find_references and reach come from the code
 * index. The old exact-text `searchCode` above stays for reference only.
 */
export const READ_TOOLS = [listFiles, readFile, ...CODE_TOOLS];
void searchCode;
export const ENGINEER_TOOLS = [...READ_TOOLS, editFile, runTests];
