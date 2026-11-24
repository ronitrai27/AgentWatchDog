import { redirect } from "next/navigation";
import { EnvVariables } from "@/components/settings/env-variables";
import { Workspace } from "@/components/settings/workspace";
import { getSession } from "@/lib/session";
import { getSetup } from "@/lib/setup";

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect("/auth");
  const setup = await getSetup(session.uid).catch(() => null);

  return (
    <div className="mx-auto w-full max-w-5xl pb-10">
      <h2 className="font-serif text-[28px] font-semibold leading-tight tracking-tight text-ink">
        Settings
      </h2>
      {setup ? (
        <>
          <Workspace setup={setup} />
          <EnvVariables setup={setup} />
        </>
      ) : (
        <p className="mt-2 text-[15px] text-ink-soft">
          Rox could not reach its database. Start it, then reload this page.
        </p>
      )}
    </div>
  );
}
