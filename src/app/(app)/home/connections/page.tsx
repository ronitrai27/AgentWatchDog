import { redirect } from "next/navigation";
import { ConnectionsView } from "@/components/connections/connections-view";
import { getSession } from "@/lib/session";
import { getSetup } from "@/lib/setup";

export default async function ConnectionsPage() {
  const session = await getSession();
  if (!session) redirect("/auth");

  const setup = await getSetup(session.uid).catch(() => null);

  return <ConnectionsView repo={setup?.repo ?? null} />;
}
