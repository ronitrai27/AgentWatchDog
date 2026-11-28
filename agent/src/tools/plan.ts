// What the user sees of a job with several steps: a plan (one goal, its steps known up front)
// or a queue (several separate things the user asked for). The chat draws it from the event.
import { z } from "zod";
import { defineTool } from "./define";

export const planUpdate = defineTool({
  name: "plan_update",
  group: "plan",
  description:
    "Shows the user a plan or a queue for the current job, and updates it as you go. Send the whole list every time, each item marked todo, doing or done; keep exactly one item doing while you work. " +
    "kind 'plan': one goal whose steps you know before starting (e.g. 'Check why PR 12 failed': read the run, read its steps, check the repo). title is the goal. " +
    "kind 'queue': the user asked for several separate things in one message (e.g. 'what am I connected to, any failed runs, and how many PRs did you merge?'): one item per thing they asked. " +
    "Call it before the first other tool, then again as items finish, and once more at the end with everything done. Do NOT use it for a question one tool call answers.",
  input: z.object({
    kind: z
      .enum(["plan", "queue"])
      .describe(
        "plan: steps of one goal. queue: separate things the user asked.",
      ),
    title: z
      .string()
      .min(1)
      .max(80)
      .describe(
        "For a plan, the goal in a few words. For a queue, a short name for the batch.",
      ),
    items: z
      .array(
        z.object({
          text: z
            .string()
            .min(1)
            .max(120)
            .describe("What the step is, in a few words"),
          status: z.enum(["todo", "doing", "done"]),
        }),
      )
      .min(1)
      .max(12),
  }),
  risk: "read",
  timeoutMs: 5_000,
  title: (input) =>
    `Update the ${input.kind} (${input.items.filter((i) => i.status === "done").length} of ${input.items.length} done)`,
  async run(input, ctx) {
    await ctx.emit({
      type: "plan.updated",
      data: { kind: input.kind, title: input.title, items: input.items },
    });
    const count = (status: string) =>
      input.items.filter((i) => i.status === status).length;
    return {
      shown: true,
      todo: count("todo"),
      doing: count("doing"),
      done: count("done"),
    };
  },
  summarize(output) {
    const o = output as { todo: number; doing: number; done: number };
    return `${o.done} done · ${o.doing} doing · ${o.todo} to do`;
  },
});
