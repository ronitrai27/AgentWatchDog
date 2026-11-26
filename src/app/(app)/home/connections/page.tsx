import { redirect } from "next/navigation";
import { ConnectionsView } from "@/components/connections/connections-view";
import { getReportConnections } from "@/lib/report-connections";
import { getSession } from "@/lib/session";
import { getSetup } from "@/lib/setup";

export default async function ConnectionsPage() {
  const session = await getSession();
  if (!session) redirect("/auth");

  const [setup, reports] = await Promise.all([
    getSetup(session.uid).catch(() => null),
    getReportConnections(session.uid).catch(() => null),
  ]);

  return (
    <ConnectionsView
      repo={setup?.repo ?? null}
      slack={reports?.connections.find((c) => c.provider === "slack") ?? null}
      reportTo={reports?.reportTo ?? null}
    />
  );
}
