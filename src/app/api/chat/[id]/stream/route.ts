import { NextResponse } from "next/server";
import { isUuid, rox } from "@/lib/rox";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** The chat as server-sent events: everything so far, then each event as Rox works. */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  const { id } = await context.params;
  if (!isUuid(id))
    return NextResponse.json({ error: "not_found" }, { status: 404 });

  const after =
    Number(new URL(request.url).searchParams.get("after") ?? 0) || 0;
  const closed = new AbortController();
  request.signal.addEventListener("abort", () => closed.abort());
  const encoder = new TextEncoder();
  let beat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      const write = (text: string) => {
        if (!closed.signal.aborted) controller.enqueue(encoder.encode(text));
      };
      beat = setInterval(() => write(": ping\n\n"), 15_000);
      try {
        const messages = rox().follow(
          session.uid,
          id,
          Math.max(0, Math.floor(after)),
          closed.signal,
        );
        for await (const message of messages) {
          const data = message.kind === "event" ? message.event : message;
          write(`event: ${message.kind}\ndata: ${JSON.stringify(data)}\n\n`);
        }
      } catch {
        write(
          'event: failed\ndata: {"message":"Rox could not read this chat"}\n\n',
        );
      } finally {
        clearInterval(beat);
        if (!closed.signal.aborted) controller.close();
      }
    },
    cancel() {
      clearInterval(beat);
      closed.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
