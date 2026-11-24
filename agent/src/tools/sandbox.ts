// Tools about the place where Rox runs code. For now: is it there and ready.
import { z } from "zod";
import { defineTool } from "./define";
import { requireSetup } from "./shared";

export const sandboxCheck = defineTool({
  name: "sandbox_check",
  group: "sandbox",
  description:
    "Checks that the sandbox engine (Docker) is installed and running, and reports its version and the CPU and memory it has. " +
    "Use it to find out whether Rox can run code and tests for the user. It does not start any container.",
  input: z.object({}),
  risk: "read",
  timeoutMs: 10_000,
  title: () => "Check the sandbox",
  async run(_input, ctx) {
    const setup = await requireSetup(ctx);
    const chosen = setup.sandbox ?? "none";
    if (chosen !== "docker") {
      return {
        chosen,
        ready: false,
        note: "Docker is the only sandbox Rox can use for now, and it is not the one chosen in setup.",
      };
    }
    const status = await ctx.docker.status(ctx.signal);
    return {
      chosen,
      ready: true,
      engineVersion: status.serverVersion,
      host: status.os,
      cpus: status.cpus,
      memoryGiB: Math.round((status.memoryBytes / 1024 ** 3) * 10) / 10,
    };
  },
  summarize(output) {
    const o = output as {
      ready?: boolean;
      engineVersion?: string;
      cpus?: number;
      memoryGiB?: number;
    };
    return o.ready
      ? `Docker ${o.engineVersion} · ${o.cpus} CPUs · ${o.memoryGiB} GiB`
      : "not ready";
  },
});
