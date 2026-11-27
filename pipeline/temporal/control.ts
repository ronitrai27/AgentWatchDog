// Pause, resume and abort a running Rox run. Used by `pnpm lab pause|resume|abort`, and meant for
// the Stop and Pause buttons in chat and `@rox stop` in Slack. Only @temporalio/client: safe to
// import from the web app.
//
//   pause   the running step stops within a heartbeat (about 5 s); sandbox and checkpoints stay.
//   resume  that step runs again; the fix agent continues from its last finished node.
//   abort   terminated at once, no step is waited for; then a cleanup run destroys the sandbox
//           and records where it stopped (trace event run.aborted, and the terminate reason in
//           Temporal's history).
import {
  type Client,
  WorkflowIdReusePolicy,
  WorkflowNotFoundError,
} from "@temporalio/client";
import type { RunState } from "./workflows";

const TASK_QUEUE = "rox-lab";

const running = async (client: Client, workflowId: string) => {
  const handle = client.workflow.getHandle(workflowId);
  try {
    const d = await handle.describe();
    return d.status.name === "RUNNING" ? { handle, runId: d.runId } : null;
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) return null;
    throw error;
  }
};

/** Where the run is, if a worker answers within 3 s. */
async function stateOf(
  handle: ReturnType<Client["workflow"]["getHandle"]>,
): Promise<RunState | null> {
  return Promise.race([
    handle.query<RunState>("state").catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), 3000)),
  ]);
}

export async function pauseRun(
  client: Client,
  workflowId: string,
  why: string,
): Promise<RunState | null> {
  const r = await running(client, workflowId);
  if (!r) return null;
  await r.handle.signal("pause", why);
  return stateOf(r.handle);
}

export async function resumeRun(
  client: Client,
  workflowId: string,
): Promise<RunState | null> {
  const r = await running(client, workflowId);
  if (!r) return null;
  await r.handle.signal("resume");
  return stateOf(r.handle);
}

/** The kill switch. Returns where the run was, or null when nothing was running. */
export async function abortRun(
  client: Client,
  workflowId: string,
  why: string,
): Promise<RunState | null> {
  const r = await running(client, workflowId);
  if (!r) return null;
  const state: RunState = (await stateOf(r.handle)) ?? {
    run: r.runId,
    repo: "",
    pr: null,
    step: "unknown (no worker answered)",
    paused: false,
    report: null,
  };
  // At once: Temporal stops scheduling anything; a step still running on a worker loses its
  // heartbeat, is cancelled, and finds its containers gone.
  await r.handle.terminate(`aborted at ${state.step}: ${why}`);
  await client.workflow.start("labAbort", {
    taskQueue: TASK_QUEUE,
    workflowId: `abort:${state.run}`,
    workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
    args: [state, why],
  });
  return state;
}
