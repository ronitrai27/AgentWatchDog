import { proxyActivities } from "@temporalio/workflow";
// Only the types are imported: Workflow code runs in a sandbox.
import type * as activities from "./activities";

const { greet } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
});

/** A Workflow that simply calls an Activity. */
export async function example(name: string): Promise<string> {
  return await greet(name);
}
