import { NextResponse } from "next/server";
import { reportTarget } from "@/lib/report-connections";
import { killPipelineRun } from "@/lib/rox-runs";
import { getRun, markKilled } from "@/lib/runs";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The kill switch. Ends the run now: it is marked cancelled and Temporal terminates it at once,
 * with no pause and no wait for a step, worker or agent. The worker's cleanup then kills the
 * sandbox and writes each thing it removed into the run's trace.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  const { id } = await context.params;
  const run = await getRun(session.uid, id).catch(() => null);
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (run.finishedAt)
    return NextResponse.json({ error: "already_finished" }, { status: 409 });

  const why = "kill switch pressed in Rox";
  await markKilled(
    session.uid,
    run.id,
    "Kill switch pressed: run terminated, nothing waited for",
  );
  try {
    await killPipelineRun({
      workflowId: run.workflowId,
      runId: run.id,
      repo: run.repo,
      pr: run.pr,
      report: await reportTarget(session.uid).catch(() => null),
      why,
    });
  } catch (error) {
    console.error(
      `[runs] kill of ${run.id} could not reach Temporal: ${error instanceof Error ? error.message : error}`,
    );
    return NextResponse.json(
      {
        ok: false,
        error:
          "The run is marked cancelled, but Temporal could not be reached to terminate it.",
      },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true });
}
