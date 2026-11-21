"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { UserAvatar } from "./user-avatar";

export type ShellUser = {
  name: string;
  /** Email if we have one, otherwise a short description of the account. */
  detail: string;
  avatar: string | null;
  /** Quick Judge Mode session: no accounts connected, integrations in test mode. */
  isJudge: boolean;
};

/**
 * Shown for real GitHub sessions. A fixed label, not a switch: it only tells
 * you that this session runs against your own accounts.
 */
function DemoModeOffBadge() {
  return (
    <div className="border-b border-ink/15 p-3">
      <div className="flex items-center gap-2.5 rounded-md border border-ink/20 bg-ink/5 px-3 py-2 text-sm font-medium text-muted">
        <span className="inline-flex size-2.5 rounded-full bg-ink/30" />
        Quick Demo Mode: Off
      </div>
    </div>
  );
}

/** The "Quick Demo Mode: On" badge. Click it to see what the mode means. */
function DemoModeBadge() {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-ink/15 p-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-md border border-[#2f7d4f]/50 bg-[#2f7d4f]/10 px-3 py-2 text-left text-sm font-medium text-black transition-colors hover:bg-[#2f7d4f]/15"
      >
        <span className="relative flex size-2.5"></span>
        Quick Demo Mode: On
      </button>
      {open && (
        <p className="mt-2 text-xs leading-relaxed text-ink-soft">
          Rox runs on a bundled demo app in a local sandbox. GitHub, Linear,
          Slack and the alert source are shown in test mode, so nothing connects
          to your accounts and no credentials are needed.
        </p>
      )}
    </div>
  );
}

type Item = { label: string; href: string; icon: ReactNode; soon?: boolean };

const icon = (path: string) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="size-4 shrink-0"
    aria-hidden="true"
  >
    <path d={path} />
  </svg>
);

const NAV: Item[] = [
  {
    label: "Home",
    href: "/home",
    icon: icon("M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"),
  },
  {
    label: "Runs",
    href: "/home/runs",
    icon: icon("M3 12h4l3-8 4 16 3-8h4"),
    soon: true,
  },
  {
    label: "Approvals",
    href: "/home/approvals",
    icon: icon("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12l3 3 5-6"),
    soon: true,
  },
  {
    label: "Connections",
    href: "/home/connections",
    icon: icon(
      "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
    ),
    soon: true,
  },
  {
    label: "Audit log",
    href: "/home/audit",
    icon: icon("M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"),
    soon: true,
  },
];

function Sidebar({
  user,
  onNavigate,
}: {
  user: ShellUser;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2.5 border-b border-ink/15 px-4">
        <Image
          src="/brand/rox-logo.png"
          alt=""
          width={28}
          height={28}
          className="rounded-md"
        />
        <span className="font-serif text-xl font-semibold tracking-tight text-ink">
          rox
        </span>
      </div>

      {user.isJudge ? <DemoModeBadge /> : <DemoModeOffBadge />}

      <nav aria-label="Main" className="flex-1 space-y-0.5 overflow-y-auto p-3">
        {NAV.map((item) =>
          item.soon ? (
            <span
              key={item.label}
              aria-disabled="true"
              className="flex cursor-not-allowed items-center gap-3 rounded-md px-3 py-2 text-sm text-muted"
            >
              {item.icon}
              {item.label}
              <span className="ml-auto rounded bg-ink/6 px-1.5 text-[10px] leading-5 text-muted">
                Soon
              </span>
            </span>
          ) : (
            <Link
              key={item.label}
              href={item.href}
              onClick={onNavigate}
              aria-current={pathname === item.href ? "page" : undefined}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                pathname === item.href
                  ? "bg-ink text-paper"
                  : "text-ink hover:bg-ink/6"
              }`}
            >
              {item.icon}
              {item.label}
            </Link>
          ),
        )}
      </nav>

      <div className="flex items-center gap-3 border-t border-ink/15 p-4">
        <UserAvatar src={user.avatar} name={user.name} size={36} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{user.name}</p>
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
  title,
  children,
}: {
  user: ShellUser;
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-svh bg-paper md:flex">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-svh w-64 shrink-0 border-r border-ink/15 bg-white/60 md:block">
        <Sidebar user={user} />
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
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-ink/15 bg-paper shadow-xl">
            <Sidebar user={user} onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-ink/15 bg-paper/90 px-4 backdrop-blur sm:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Open menu"
              onClick={() => setOpen(true)}
              className="grid size-8 place-items-center rounded-md border border-ink/30 text-ink md:hidden"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                className="size-4"
                aria-hidden="true"
              >
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
            <h1 className="text-sm font-medium text-ink">{title}</h1>
          </div>

          <div className="flex items-center gap-2">
            {user.isJudge ? (
              <form action="/api/auth/logout" method="post">
                <input type="hidden" name="reason" value="real" />
                <button
                  type="submit"
                  className="flex items-center gap-2 bg-[#2f7d4f] px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
                >
                  Try live
                  <span className="hidden sm:inline">in the real world</span>
                  <span aria-hidden="true">→</span>
                </button>
              </form>
            ) : (
              <form action="/api/auth/logout" method="post">
                <input type="hidden" name="reason" value="judge" />
                <button
                  type="submit"
                  className="flex items-center gap-2 bg-ink px-3 py-1.5 text-sm font-medium text-paper transition-opacity hover:opacity-90"
                >
                  Try
                  <span className="hidden sm:inline">Quick Judge Mode</span>
                  <span className="sm:hidden">Judge Mode</span>
                  <span aria-hidden="true">→</span>
                </button>
              </form>
            )}
            <form action="/api/auth/logout" method="post">
              <button
                type="submit"
                className="flex items-center gap-2 border border-ink/40 px-3 py-1.5 text-sm text-ink transition-colors hover:bg-ink/5"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="size-4"
                  aria-hidden="true"
                >
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
                </svg>
                Logout
              </button>
            </form>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
