import { NextResponse } from "next/server";
import { getInsights, INSIGHTS_TTL_MS } from "@/lib/insights";
import { getSession } from "@/lib/session";

const MAX_AGE_SECONDS = Math.floor(INSIGHTS_TTL_MS / 1000);

/** What the empty Home page shows about the project and its connections. */
export async function GET() {
  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  try {
    const data = await getInsights(session.uid, session.mode === "demo");
    const cacheable = data.github === "connected" || data.github === "demo";
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": cacheable
          ? `private, max-age=${MAX_AGE_SECONDS}`
          : "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
