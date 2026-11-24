import { BusyError, NotFoundError } from "@agent/rox";
import { NextResponse } from "next/server";
import { isUuid, rox } from "@/lib/rox";
import { getSession } from "@/lib/session";

/** Sends the user's message to Rox. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  const { id } = await context.params;
  if (!isUuid(id))
    return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = (await request.json().catch(() => null)) as {
    text?: unknown;
  } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text || text.length > 8_000)
    return NextResponse.json({ error: "bad_text" }, { status: 400 });

  try {
    const turn = await rox().startTurn(session.uid, id, text);
    return NextResponse.json(turn, { status: 202 });
  } catch (error) {
    const status =
      error instanceof BusyError
        ? 409
        : error instanceof NotFoundError
          ? 404
          : 503;
    return NextResponse.json({ error: "turn_failed" }, { status });
  }
}
