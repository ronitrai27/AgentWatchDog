import { NextResponse } from "next/server";
import { listRuns, runsOverview } from "@/lib/runs";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The run sheet's button: is a pipeline run going, and the last few runs.
 * With ?all=1, every run (the Runs page).
 */
export async function GET(request: Request) {
  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  try {
    if (new URL(request.url).searchParams.get("all"))
      return NextResponse.json({ runs: await listRuns(session.uid) });
    return NextResponse.json(await runsOverview(session.uid));
  } catch {
    return NextResponse.json({ error: "database" }, { status: 503 });
  }
}
