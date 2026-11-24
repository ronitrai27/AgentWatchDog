// The agent's own to-do list, shown to the user as a queue (to do, doing, done).
import { z } from "zod";
import { defineTool } from "./define";

export const planUpdate = defineTool({
  name: "plan_update",
  group: "plan",
  description:
    "Writes or updates your to-do list for the current job so the user can follow it. Send the whole list every time, with each item marked todo, doing or done. " +
    "Use it at the start of a job with several steps and again as steps finish. Do not use it for a one-step answer.",
  input: z.object({
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
  title: (input) => `Update the plan (${input.items.length} steps)`,
  async run(input, ctx) {
    await ctx.emit({ type: "plan.updated", data: { items: input.items } });
    const count = (status: string) =>
      input.items.filter((i) => i.status === status).length;
    return {
      saved: true,
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
