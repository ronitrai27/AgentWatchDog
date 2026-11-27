import { redirect } from "next/navigation";
import { RunsTable } from "@/components/runs/runs-table";
import { listRuns } from "@/lib/runs";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
  const session = await getSession();
  if (!session) redirect("/auth");
  const runs = await listRuns(session.uid).catch(() => null);
  if (!runs)
    return (
      <p className="text-[15px] text-ink-soft">
        Rox could not reach its database. Start it, then reload this page.
      </p>
    );
  return <RunsTable initial={runs} />;
}
