import { NextResponse } from "next/server";
import { isUuid, rox } from "@/lib/rox";
import { getSession } from "@/lib/session";
import { deleteSession } from "@/lib/sessions";

/** Deletes a chat session with all its turns and events. */
export async function DELETE(
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
    await rox()
      .stop(session.uid, id)
      .catch(() => {});
    const deleted = await deleteSession(session.uid, id);
    if (!deleted)
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ deleted: true });
  } catch {
    return NextResponse.json({ error: "delete_failed" }, { status: 503 });
  }
}
