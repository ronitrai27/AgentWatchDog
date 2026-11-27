import { redirect } from "next/navigation";
import { EnvVariables } from "@/components/settings/env-variables";
import { SettingsView } from "@/components/settings/settings-view";
import { Workspace } from "@/components/settings/workspace";
import { getAgentConfig } from "@/lib/agent-config-store";
import { getTriggers } from "@/lib/sentry-connection";
import { getSession } from "@/lib/session";
import { getSetup } from "@/lib/setup";

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect("/auth");
  const [setup, agent, triggers] = await Promise.all([
    getSetup(session.uid).catch(() => null),
    getAgentConfig(session.uid).catch(() => null),
    getTriggers(session.uid).catch(() => null),
  ]);
  if (!setup)
    return (
      <p className="text-[15px] text-ink-soft">
        Rox could not reach its database. Start it, then reload this page.
      </p>
    );

  return (
    <SettingsView
      initial={agent?.config ?? null}
      spentTodayUsd={agent?.spentTodayUsd ?? 0}
      workspace={<Workspace setup={setup} />}
      keys={<EnvVariables setup={setup} />}
      triggers={triggers}
    />
  );
}
