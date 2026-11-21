import { redirect } from "next/navigation";
import { SetupGuide, TestModePanel } from "@/components/home-guide";
import { WelcomeToast } from "@/components/welcome-toast";
import { getSession } from "@/lib/session";

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

  return (
    <div className="mx-auto w-full max-w-4xl pb-16">
      {justSignedIn && <WelcomeToast name={displayName} />}

      <h1 className="font-serif text-3xl font-semibold tracking-tight text-ink">
        {isJudge ? "Welcome to the Rox demo" : `Welcome, ${displayName}`}
      </h1>
      <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-soft">
        {isJudge
          ? "See Rox investigate, fix and verify a bug without connecting anything. Everything that would normally need your accounts is shown in test mode."
          : "Rox is your on-call engineer. Finish the steps below and incidents will be investigated, fixed and verified for you to merge."}
      </p>

      <div className="mt-8">
        <SetupGuide
          isJudge={isJudge}
          installations={session.installations.length}
        />
      </div>

      {isJudge && <TestModePanel />}
    </div>
  );
}
