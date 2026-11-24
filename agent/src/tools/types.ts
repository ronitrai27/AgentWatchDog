// What a tool is. Every tool is one definition; the runner adds the timeout, the input
// check, the error wording and the size limit, so a tool only has to do its job.
import type { z } from "zod";
import type { DockerClient } from "../integrations/docker";
import type { GithubClient } from "../integrations/github";
import type { Store } from "../store/sessions";

export type Risk =
  | "read" // looks at something, changes nothing
  | "sandbox" // runs code in the isolated sandbox
  | "external_write"; // changes something outside Rox (a PR, an issue, a message)

export type ToolErrorKind =
  | "invalid_input" // the model sent arguments the tool cannot use
  | "unavailable" // this tool cannot work here (not connected, not configured)
  | "not_found"
  | "forbidden" // the connection exists but is not allowed to do this
  | "rate_limited"
  | "upstream" // the service we asked failed
  | "timeout"
  | "aborted" // the user pressed stop
  | "failed";

/** A failure with a reason a person can read. Tools throw this; anything else becomes kind "failed". */
export class ToolError extends Error {
  readonly kind: ToolErrorKind;
  /** What to try next, in plain words. */
  readonly hint?: string;
  readonly retryable: boolean;

  constructor(
    kind: ToolErrorKind,
    message: string,
    options: { hint?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ToolError";
    this.kind = kind;
    this.hint = options.hint;
    this.retryable =
      options.retryable ??
      (kind === "rate_limited" || kind === "upstream" || kind === "timeout");
  }
}

/** What every tool may use. Comes with the turn. */
export type ToolServices = {
  userId: string;
  sessionId: string;
  turnId: string;
  store: Store;
  /** Null when the GitHub App is not configured on this machine. */
  github: GithubClient | null;
  docker: DockerClient;
};

export type ToolContext = ToolServices & {
  /** Aborted when the call times out or the user stops the run. Tools should pass it to fetch and child processes. */
  signal: AbortSignal;
  /** Streams an event to the chat (for tools that show something in the UI, like the plan). */
  emit(event: { type: string; data: Record<string, unknown> }): Promise<void>;
};

export type ToolDef<S extends z.ZodType = z.ZodType> = {
  /** group_verb, lowercase, for example repo_overview. Providers allow letters, digits, _ and -. */
  name: string;
  /** The file or area the tool belongs to, for example "repo". */
  group: string;
  /** Said to the model: what it does and when to use it. Say when NOT to use it too. */
  description: string;
  input: S;
  risk: Risk;
  /** The most this tool may take, in milliseconds. The call is cut off after this. */
  timeoutMs: number;
  /** A short line for the screen, for example "Read the repository overview". */
  title: (input: z.infer<S>) => string;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
  /** A short result line for the screen, for example "3 open pull requests". */
  summarize?: (output: unknown) => string;
};

export type ToolOutcome =
  | { ok: true; output: unknown; summary: string; durationMs: number }
  | {
      ok: false;
      error: {
        kind: ToolErrorKind;
        message: string;
        cause?: string;
        hint?: string;
        retryable: boolean;
      };
      durationMs: number;
    };
