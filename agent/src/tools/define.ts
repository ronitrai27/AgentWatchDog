import type { z } from "zod";
import type { ToolDef } from "./types";

const NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

/** Keeps the type of the input schema, so `run` receives parsed, typed arguments. */
export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  if (!NAME.test(def.name) || def.name.length > 64) {
    throw new Error(
      `Tool name "${def.name}" must look like group_verb (lowercase, digits, underscores)`,
    );
  }
  if (!def.name.startsWith(`${def.group}_`)) {
    throw new Error(
      `Tool "${def.name}" must start with its group "${def.group}_"`,
    );
  }
  if (def.timeoutMs <= 0 || def.timeoutMs > 10 * 60_000) {
    throw new Error(
      `Tool "${def.name}" needs a timeout between 1 ms and 10 minutes`,
    );
  }
  if (def.description.trim().length < 20) {
    throw new Error(
      `Tool "${def.name}" needs a real description: the model chooses tools by it`,
    );
  }
  return def;
}
