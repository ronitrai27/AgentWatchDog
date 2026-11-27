import { NextResponse } from "next/server";
import { runsOverview } from "@/lib/runs";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** The run sheet's button: is a pipeline run going, and the last few runs. */
export async function GET() {
  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  try {
    return NextResponse.json(await runsOverview(session.uid));
  } catch {
    return NextResponse.json({ error: "database" }, { status: 503 });
  }
}
