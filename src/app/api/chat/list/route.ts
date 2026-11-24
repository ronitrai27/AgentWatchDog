import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { listSessions } from "@/lib/sessions";

/** The signed-in user's chats, newest first, for the sidebar's History. */
export async function GET() {
  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  try {
    const chats = await listSessions(session.uid, { limit: 50 });
    return NextResponse.json(
      {
        // A chat nobody wrote in is not history.
        chats: chats
          .filter((c) => c.eventCount > 0)
          .map((c) => ({
            id: c.id,
            name: c.name,
            updatedAt: c.updatedAt.toISOString(),
          })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "database" }, { status: 503 });
  }
}
