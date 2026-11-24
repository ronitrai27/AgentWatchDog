import { NotFoundError } from "@agent/rox";
import { NextResponse } from "next/server";
import { isUuid, rox } from "@/lib/rox";
import { getSession } from "@/lib/session";

/** The stop button. */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  const { id } = await context.params;
  if (!isUuid(id))
    return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    return NextResponse.json({ stopped: await rox().stop(session.uid, id) });
  } catch (error) {
    const status = error instanceof NotFoundError ? 404 : 503;
    return NextResponse.json({ error: "stop_failed" }, { status });
  }
}
