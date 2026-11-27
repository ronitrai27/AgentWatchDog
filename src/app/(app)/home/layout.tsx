import "../../app.css";
import { redirect } from "next/navigation";
import { AppShell, type ShellUser } from "@/components/app-shell";
import type { SheetApp } from "@/components/runs/run-sheet";
import { isSetUp } from "@/lib/models";
import { getReportConnections } from "@/lib/report-connections";
import { getSentryConnection } from "@/lib/sentry-connection";
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
  const [setup, reports, sentry] = await Promise.all([
    getSetup(session.uid).catch(() => null),
    getReportConnections(session.uid).catch(() => null),
    getSentryConnection(session.uid).catch(() => null),
  ]);
  const slack = reports?.connections.find((c) => c.provider === "slack");
  // What the run sheet lists when nothing runs: read from the database, like the Connections page.
  const apps: SheetApp[] = [
    {
      id: "github",
      name: "GitHub",
      connected: Boolean(setup?.repo),
      detail: setup?.repo ?? "No repository chosen",
    },
    {
      id: "slack",
      name: "Slack",
      connected: Boolean(slack),
      detail: slack
        ? `#${slack.channelName ?? slack.channelId} gets the reports`
        : "Reports after every run",
    },
    {
      id: "sentry",
      name: "Sentry",
      connected: Boolean(sentry),
      detail: sentry
        ? `${sentry.project} wakes Rox`
        : "Wakes Rox on new errors",
    },
  ];

  return (
    <AppShell
      user={user}
      repo={setup?.repo ?? null}
      isSetUp={setup !== null && isSetUp(setup, isJudge)}
      apps={apps}
    >
      {children}
    </AppShell>
  );
}
