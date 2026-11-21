import { redirect } from "next/navigation";
import { AppShell, type ShellUser } from "@/components/app-shell";
import { getSession } from "@/lib/session";

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

  return (
    <AppShell user={user} title="Home">
      {children}
    </AppShell>
  );
}
