// Starts, replaces and cancels Rox Lab runs. One workflow id per pull request, so a new run for
// the same pull request first stops the old one and says why.
//
//   pnpm lab start --pr 1 [--repo owner/name] [--wait]
//   pnpm lab start --ref main --base <sha> [--repo owner/name] [--wait]
//   pnpm lab cancel --pr 1 [--repo owner/name]
import {
  Client,
  Connection,
  WorkflowIdReusePolicy,
  WorkflowNotFoundError,
} from "@temporalio/client";
import { commitSha, pullInfo } from "../../Tests/src/github";
import { LAB_TASK_QUEUE, TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE } from "./config";
import { labChecks, replacedSignal } from "./workflows";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const command = args[0];
const repo = flag("repo") ?? "ronitrai27/Testing_SRE_Demo_App";
const pr = Number(flag("pr"));
const ref = flag("ref");
const baseRef = flag("base");
const VIEWER = "http://127.0.0.1:8790";

/** Stops the running workflow of this pull request, if there is one, and waits for it. */
async function stopRunning(client: Client, workflowId: string, why: string) {
  const handle = client.workflow.getHandle(workflowId);
  try {
    const d = await handle.describe();
    if (d.status.name !== "RUNNING") return null;
    await handle.signal(replacedSignal, why);
    await handle.cancel();
    await handle.result().catch(() => {});
    console.log(`Stopped run ${d.runId}: ${why}`);
    return d.runId;
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) return null;
    throw error;
  }
}

async function main() {
  if (!["start", "cancel"].includes(command ?? "") || (!pr && !ref)) {
    console.log(
      "Usage: pnpm lab start --pr <number> [--repo owner/name] [--wait]",
    );
    console.log("       pnpm lab cancel --pr <number> [--repo owner/name]");
    process.exit(1);
  }
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  const client = new Client({ connection, namespace: TEMPORAL_NAMESPACE });
  const workflowId = pr ? `lab:${repo}#${pr}` : `lab:${repo}@${ref}`;

  if (command === "cancel") {
    const stopped = await stopRunning(client, workflowId, "cancelled by hand");
    if (!stopped) console.log("Nothing was running for this pull request.");
    await connection.close();
    return;
  }

  const target = pr
    ? await pullInfo(repo, pr).then((p) => ({
        head: p.headSha,
        base: p.baseSha,
        title: p.title,
      }))
    : {
        head: await commitSha(repo, ref as string),
        base: baseRef ? await commitSha(repo, baseRef) : null,
        title: `${ref}${baseRef ? ` compared with ${baseRef.slice(0, 7)}` : ""}`,
      };
  await stopRunning(
    client,
    workflowId,
    `a newer run started for ${pr ? `PR #${pr}` : ref} at ${target.head.slice(0, 7)}`,
  );
  const handle = await client.workflow.start(labChecks, {
    taskQueue: LAB_TASK_QUEUE,
    workflowId,
    workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
    args: [{ repo, pr: pr || null, ...target }],
  });
  console.log(`Started ${workflowId}`);
  console.log(`  run    ${handle.firstExecutionRunId}`);
  console.log(`  watch  ${VIEWER}/runs/${handle.firstExecutionRunId}`);

  if (args.includes("--wait")) {
    const results = await handle.result();
    console.table(
      results.map((r) => ({
        check: r.id,
        status: r.status,
        seconds: Math.round(r.ms / 1000),
        summary: r.summary.slice(0, 90),
      })),
    );
  }
  await connection.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
