"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useId, useState } from "react";
import { Brand } from "./setup/brand";
import { UserAvatar } from "./user-avatar";

export type ShellUser = {
  name: string;
  /** Email if we have one, otherwise a short description of the account. */
  detail: string;
  avatar: string | null;
  /** Quick Judge Mode session: no accounts connected, integrations in test mode. */
  isJudge: boolean;
};

const glyph = (path: string, size = "size-4") => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`${size} shrink-0`}
    aria-hidden="true"
  >
    <path d={path} />
  </svg>
);

/**
 * Says which mode this session is in. It opens a short explanation; switching
 * mode is the button in the page header, because it signs you out.
 */
function ModeButton({ isJudge }: { isJudge: boolean }) {
  const id = useId();
  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        data-on={isJudge}
        className="mode-button focusable flex h-9 w-full items-center gap-2 px-3 text-[13px] font-medium"
      >
        Quick Demo Mode
        <span className="ml-auto">{isJudge ? "On" : "Off"}</span>
        <span className="opacity-70">
          {glyph("M8 9.5 12 5.5l4 4M8 14.5l4 4 4-4", "size-3.5")}
        </span>
      </button>
      <div
        id={id}
        popover="auto"
        className="menu left-2 top-[56px] w-[224px] p-3 text-[13px] leading-relaxed text-ink-soft"
      >
        {isJudge
          ? "Rox works on its bundled demo app in a local sandbox. GitHub, Linear, Slack and alerts run in test mode, so nothing connects to your accounts."
          : "You are using your own accounts. To try Rox on its demo app instead, use Try Quick Judge Mode at the top of the page."}
      </div>
    </>
  );
}

function ConnectedRepo({ repo }: { repo: string | null }) {
  return (
    <div
      data-connected={repo !== null}
      className={`repo-box flex items-center gap-3 px-3 py-3 ${repo ? "text-white" : "text-ink"}`}
    >
      <Brand id="github" size={30} />
      <div className="min-w-0">
        <p className={`text-xs ${repo ? "text-white/75" : "text-ink-soft"}`}>
          Repo connected
        </p>
        <p
          className="truncate text-[13px] font-semibold"
          title={repo ?? undefined}
        >
          {repo ?? "None selected"}
        </p>
      </div>
    </div>
  );
}

type Item = { label: string; href: string; icon: ReactNode; soon?: boolean };

const NAV: Item[] = [
  {
    label: "Home",
    href: "/home",
    icon: glyph("M4 10.5 12 4l8 6.5V20h-5.5v-5.5h-5V20H4z"),
  },
  {
    label: "Runs",
    href: "/home/runs",
    icon: glyph("M3 12h4l3-8 4 16 3-8h4"),
    soon: true,
  },
  {
    label: "Approvals",
    href: "/home/approvals",
    icon: glyph("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12l3 3 5-6"),
    soon: true,
  },
  {
    label: "Connections",
    href: "/home/connections",
    icon: glyph(
      "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
    ),
    soon: true,
  },
  {
    label: "Audit log",
    href: "/home/audit",
    icon: glyph("M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"),
    soon: true,
  },
];

function Sidebar({
  user,
  repo,
  onNavigate,
}: {
  user: ShellUser;
  repo: string | null;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center border-b border-ink/10 px-2">
        <ModeButton isJudge={user.isJudge} />
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        <ConnectedRepo repo={repo} />

        <nav aria-label="Main" className="mt-3 space-y-px">
          {NAV.map((item) =>
            item.soon ? (
              <span
                key={item.label}
                aria-disabled="true"
                className="flex h-8 cursor-not-allowed items-center gap-2.5 rounded-md px-2 text-[13px] text-muted"
              >
                {item.icon}
                {item.label}
                <span className="ml-auto text-xs">Soon</span>
              </span>
            ) : (
              <Link
                key={item.label}
                href={item.href}
                onClick={onNavigate}
                aria-current={pathname === item.href ? "page" : undefined}
                className={`flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] font-medium text-ink transition-colors ${
                  pathname === item.href ? "bg-ink/8" : "hover:bg-ink/6"
                }`}
              >
                {item.icon}
                {item.label}
              </Link>
            ),
          )}
        </nav>
      </div>

      <div className="flex items-center gap-2.5 border-t border-ink/10 px-4 py-3">
        <UserAvatar src={user.avatar} name={user.name} size={28} />
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-ink">
            {user.name}
          </p>
          <p className="truncate text-xs text-muted" title={user.detail}>
            {user.detail}
          </p>
        </div>
      </div>
    </div>
  );
}

export function AppShell({
  user,
  repo,
  title,
  children,
}: {
  user: ShellUser;
  repo: string | null;
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-svh bg-paper md:flex">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-svh w-60 shrink-0 border-r border-ink/10 bg-white/50 md:block">
        <Sidebar user={user} repo={repo} />
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-ink/40"
          />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-ink/10 bg-paper shadow-xl">
            <Sidebar
              user={user}
              repo={repo}
              onNavigate={() => setOpen(false)}
            />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-ink/10 bg-paper/90 px-4 backdrop-blur sm:px-5">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              aria-label="Open menu"
              onClick={() => setOpen(true)}
              className="btn btn-quiet w-8 px-0 md:hidden"
            >
              {glyph("M4 7h16M4 12h16M4 17h16")}
            </button>
            <h1 className="text-[13px] font-medium text-ink">{title}</h1>
          </div>

          <div className="flex items-center gap-2">
            <form action="/api/auth/logout" method="post">
              <input
                type="hidden"
                name="reason"
                value={user.isJudge ? "real" : "judge"}
              />
              <button type="submit" className="btn btn-primary">
                {user.isJudge ? (
                  <>
                    Try live
                    <span className="hidden sm:inline">in the real world</span>
                  </>
                ) : (
                  <>
                    Try <span className="hidden sm:inline">Quick</span> Judge
                    Mode
                  </>
                )}
              </button>
            </form>
            <form action="/api/auth/logout" method="post">
              <button type="submit" className="btn btn-danger">
                Log out
              </button>
            </form>
          </div>
        </header>

        <main className="flex-1 px-4 py-8 sm:px-6 sm:py-12">{children}</main>
      </div>
    </div>
  );
}
