// Run with: pnpm temporal:hello
// Starts one "example" Workflow, waits for it, and prints the result.
import { randomUUID } from "node:crypto";
import { Client, Connection } from "@temporalio/client";
import {
  HELLO_TASK_QUEUE,
  TEMPORAL_ADDRESS,
  TEMPORAL_NAMESPACE,
} from "./config";
import { example } from "./workflows";

async function run() {
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  const client = new Client({ connection, namespace: TEMPORAL_NAMESPACE });

  const handle = await client.workflow.start(example, {
    taskQueue: HELLO_TASK_QUEUE,
    args: ["Temporal"],
    workflowId: `hello-${randomUUID()}`,
  });
  console.log(`Started workflow ${handle.workflowId}`);
  console.log(await handle.result()); // Hello, Temporal!
  await connection.close();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
