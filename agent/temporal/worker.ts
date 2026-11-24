// Run with: pnpm temporal:worker
// A Worker polls a Task Queue and runs the Workflows and Activities registered
// here. Keep it running while you start Workflows.
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities";
import {
  HELLO_TASK_QUEUE,
  TEMPORAL_ADDRESS,
  TEMPORAL_NAMESPACE,
} from "./config";

async function run() {
  const connection = await NativeConnection.connect({
    address: TEMPORAL_ADDRESS,
  });
  try {
    const worker = await Worker.create({
      connection,
      namespace: TEMPORAL_NAMESPACE,
      taskQueue: HELLO_TASK_QUEUE,
      // Workflows are registered by path because they run in a separate
      // JavaScript context.
      workflowsPath: require.resolve("./workflows"),
      activities,
    });
    console.log(
      `Worker ready: ${TEMPORAL_ADDRESS}, namespace "${TEMPORAL_NAMESPACE}", queue "${HELLO_TASK_QUEUE}"`,
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
