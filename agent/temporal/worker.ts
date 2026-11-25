// Run with: pnpm temporal:worker
// Polls the rox-lab task queue and runs Rox Lab workflows and their steps. Several workers can
// run at once; if one dies, Temporal gives its unfinished step to another.
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities";
import { LAB_TASK_QUEUE, TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE } from "./config";

async function run() {
  const connection = await NativeConnection.connect({
    address: TEMPORAL_ADDRESS,
  });
  try {
    const worker = await Worker.create({
      connection,
      namespace: TEMPORAL_NAMESPACE,
      taskQueue: LAB_TASK_QUEUE,
      // Workflows are registered by path because they run in a separate
      // JavaScript context.
      workflowsPath: require.resolve("./workflows"),
      activities,
      maxConcurrentActivityTaskExecutions: 8,
    });
    console.log(
      `Rox Lab worker ready: ${TEMPORAL_ADDRESS}, namespace "${TEMPORAL_NAMESPACE}", queue "${LAB_TASK_QUEUE}"`,
    );
    await worker.run();
  } finally {
    await connection.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
