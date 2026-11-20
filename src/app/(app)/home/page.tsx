import { redirect } from "next/navigation";
import { RoxMark } from "@/components/site-header";
import { WelcomeToast } from "@/components/welcome-toast";
import { getSession } from "@/lib/session";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const session = await getSession();
  if (!session) redirect("/auth");

  // Quick Judge Mode users are all called "User".
  const displayName =
    session.mode === "demo" ? "User" : (session.name ?? session.login);
  const justSignedIn = (await searchParams).welcome === "1";

  return (
    <div className="min-h-svh bg-paper">
      {justSignedIn && <WelcomeToast name={displayName} />}
      <header className="mx-auto flex w-full max-w-4xl items-center justify-between px-4 py-4 sm:px-6">
        <a href="/" className="flex items-center gap-2 text-ink">
          <RoxMark />
          <span className="font-serif text-xl font-semibold tracking-tight">
            rox
          </span>
        </a>
        <div className="flex items-center gap-3 text-sm text-ink">
          {session.avatar && (
            // biome-ignore lint/performance/noImgElement: small remote avatar, no optimisation needed
            <img
              src={session.avatar}
              alt=""
              className="size-7 rounded-full"
              width={28}
              height={28}
            />
          )}
          <span>{displayName}</span>
          <form action="/api/auth/logout" method="post">
            <button
              type="submit"
              className="border border-ink/40 px-3 py-1.5 text-xs transition-colors hover:bg-ink/5"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl px-4 pb-20 sm:px-6" />
    </div>
  );
}
