import { redirect } from "next/navigation";
import { Recommended } from "@/components/setup/recommended";
import { SetupGuide } from "@/components/setup/setup-guide";
import { TestMode } from "@/components/setup/test-mode";
import { WelcomeToast } from "@/components/welcome-toast";
import { getSession } from "@/lib/session";
import { getSetup } from "@/lib/setup";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const session = await getSession();
  if (!session) redirect("/auth");

  const isJudge = session.mode === "demo";
  // Quick Judge Mode users are all called "User".
  const displayName = isJudge ? "User" : (session.name ?? session.login);
  const justSignedIn = (await searchParams).welcome === "1";
  const setup = await getSetup(session.uid).catch(() => null);

  return (
    <div className="mx-auto w-full max-w-[720px] pb-16">
      {justSignedIn && <WelcomeToast name={displayName} />}
      {setup ? (
        <>
          <SetupGuide initial={setup} isJudge={isJudge} login={session.login} />
          <Recommended isJudge={isJudge} />
          {isJudge && <TestMode />}
        </>
      ) : (
        <p className="text-[15px] text-ink-soft">
          Rox could not reach its database. Start it, then reload this page.
        </p>
      )}
    </div>
  );
}
