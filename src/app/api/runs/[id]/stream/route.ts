import { NextResponse } from "next/server";
import { getRun, runEvents } from "@/lib/runs";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const TICK_MS = 1000;

/**
 * One pipeline run as server-sent events: the run (again whenever it changes), then every event
 * after `after`, as the pipeline writes them. Ends with "end" once the run is finished.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  const { id } = await context.params;
  const first = await getRun(session.uid, id).catch(() => null);
  if (!first) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let after =
    Math.max(
      0,
      Math.floor(Number(new URL(request.url).searchParams.get("after"))),
    ) || 0;
  const encoder = new TextEncoder();
  let stopped = false;
  request.signal.addEventListener("abort", () => {
    stopped = true;
  });

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (!stopped)
          controller.enqueue(
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
      };
      let last = "";
      // After the run ends, keep listening a little: a kill's cleanup lines arrive just after.
      let quietTicks = 0;
      try {
        while (!stopped) {
          const run = await getRun(session.uid, id);
          if (!run) break;
          const now = JSON.stringify(run);
          if (now !== last) send("run", run);
          last = now;
          const events = await runEvents(session.uid, id, after);
          for (const e of events) send("event", e);
          if (events.length) after = events[events.length - 1].seq;
          quietTicks = events.length ? 0 : quietTicks + 1;
          const ago = run.finishedAt
            ? Date.now() - new Date(run.finishedAt).getTime()
            : 0;
          if (run.finishedAt && quietTicks >= 1 && ago > 15_000) {
            send("end", {});
            break;
          }
          await new Promise((r) => setTimeout(r, TICK_MS));
        }
      } catch {
        send("error", { message: "The run could not be read." });
      } finally {
        stopped = true;
        controller.close();
      }
    },
    cancel() {
      stopped = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
