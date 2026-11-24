import { NextResponse } from "next/server";
import { getInsights } from "@/lib/insights";
import { getSession } from "@/lib/session";

/** What the empty Home page shows about the project and its connections. */
export async function GET() {
  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  try {
    return NextResponse.json(
      await getInsights(session.uid, session.mode === "demo"),
      { headers: { "Cache-Control": "private, max-age=60" } },
    );
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
