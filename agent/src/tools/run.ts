import type { z } from "zod";
import { redactText, redactValue } from "../redact";
import {
  type ToolContext,
  type ToolDef,
  ToolError,
  type ToolOutcome,
} from "./types";

/** The most text one tool result may put in front of the model. */
export const MAX_RESULT_CHARS = 12_000;

/** Says what was wrong with the arguments in words the model can act on. */
export function describeIssues(error: z.ZodError): string {
  const parts = error.issues.slice(0, 5).map((issue) => {
    const where = issue.path.length
      ? `'${issue.path.join(".")}'`
      : "the arguments";
    return `${where}: ${issue.message}`;
  });
  return parts.join("; ");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(error: unknown, durationMs: number): ToolOutcome {
  if (error instanceof ToolError) {
    const cause = error.cause
      ? redactText(errorText(error.cause)).slice(0, 300)
      : undefined;
    return {
      ok: false,
      durationMs,
      error: {
        kind: error.kind,
        message: redactText(error.message),
        ...(cause ? { cause } : {}),
        ...(error.hint ? { hint: error.hint } : {}),
        retryable: error.retryable,
      },
    };
  }
  return {
    ok: false,
    durationMs,
    error: {
      kind: "failed",
      message: `The tool crashed: ${redactText(errorText(error)).slice(0, 300)}`,
      retryable: false,
    },
  };
}

/**
 * Runs one tool call: checks the arguments, enforces the time limit, turns anything that goes
 * wrong into one plain error (what failed, the cause, what to try), and caps the result size.
 * A tool that ignores the abort signal still cannot hang the run: we stop waiting for it.
 */
export async function runTool(
  def: ToolDef,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) {
    return failure(
      new ToolError(
        "invalid_input",
        `The arguments for ${def.name} are not valid: ${describeIssues(parsed.error)}`,
        {
          hint: "Call the tool again with arguments that match its schema.",
        },
      ),
      elapsed(),
    );
  }
  if (ctx.signal.aborted)
    return failure(
      new ToolError("aborted", "Stopped before the tool started"),
      elapsed(),
    );

  const limit = new AbortController();
  const timer = setTimeout(
    () =>
      limit.abort(
        new ToolError(
          "timeout",
          `${def.name} took longer than ${Math.round(def.timeoutMs / 1000)}s and was cut off`,
          {
            hint: "Try again, or check whether the service it talks to is slow.",
          },
        ),
      ),
    def.timeoutMs,
  );
  const signal = AbortSignal.any([ctx.signal, limit.signal]);

  const stopped = new Promise<never>((_, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        const reason = limit.signal.aborted
          ? limit.signal.reason
          : new ToolError("aborted", "The run was stopped");
        reject(reason);
      },
      { once: true },
    );
  });
  stopped.catch(() => {}); // the race below handles it; avoid an unhandled rejection if the tool wins

  try {
    const output = await Promise.race([
      def.run(parsed.data, { ...ctx, signal }),
      stopped,
    ]);
    const clean = redactValue(output ?? null);
    let summary = "";
    try {
      summary = def.summarize
        ? redactText(def.summarize(clean)).slice(0, 200)
        : "";
    } catch {
      summary = "";
    }
    return { ok: true, output: clean, summary, durationMs: elapsed() };
  } catch (error) {
    return failure(error, elapsed());
  } finally {
    clearTimeout(timer);
  }
}

/** What the model reads back. Long results are cut, and the cut is said out loud. */
export function modelText(outcome: ToolOutcome): string {
  if (outcome.ok) {
    const json = JSON.stringify(outcome.output);
    if (json.length <= MAX_RESULT_CHARS) return json;
    return `${json.slice(0, MAX_RESULT_CHARS)}… [result cut: ${json.length} characters, showing the first ${MAX_RESULT_CHARS}]`;
  }
  const { kind, message, cause, hint } = outcome.error;
  return [
    `Error (${kind}): ${message}`,
    cause ? `Cause: ${cause}` : "",
    hint ? `Hint: ${hint}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
