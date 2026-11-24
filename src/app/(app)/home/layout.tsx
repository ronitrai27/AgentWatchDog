import "../../app.css";
import { redirect } from "next/navigation";
import { AppShell, type ShellUser } from "@/components/app-shell";
import { isSetUp } from "@/lib/models";
import { getSession } from "@/lib/session";
import { getSetup } from "@/lib/setup";

// Wraps every page under /home with the sidebar and header. proxy.ts already
// blocks signed-out visitors; this checks again so the page never renders for
// them even if the proxy is bypassed.
export default async function HomeLayout({ children }: LayoutProps<"/home">) {
  const session = await getSession();
  if (!session) redirect("/auth");

  const isJudge = session.mode === "demo";
  const user: ShellUser = {
    name: isJudge ? "User" : (session.name ?? session.login),
    detail:
      session.email ?? (isJudge ? "Quick Judge session" : `@${session.login}`),
    avatar: session.avatar,
    isJudge,
  };

  // The shell still renders if the database is down; the page says so.
  const setup = await getSetup(session.uid).catch(() => null);

  return (
    <AppShell
      user={user}
      repo={setup?.repo ?? null}
      isSetUp={setup !== null && isSetUp(setup, isJudge)}
    >
      {children}
    </AppShell>
  );
}
