"use client";

import { PlusIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import type { Insights } from "@/lib/insights";

/** "Connectors +" in the message box, linking to /home/connections. */
export function Connectors({ github }: { github?: Insights["github"] }) {
  // The recommended apps (Sentry, Slack, Vercel) cannot be connected yet. Quick Demo Mode runs
  // them in test mode, and nothing is claimed until the state is known.
  const missing = github !== undefined && github !== "demo";

  return (
    <Link
      href="/home/connections"
      className="focusable flex h-8 items-center gap-2 rounded-full border border-ink/25 bg-neutral-100 px-3 text-[13px] font-medium text-ink hover:border-ink/40"
    >
      Connectors
      {missing ? (
        <TriangleAlertIcon
          role="img"
          aria-label="Recommended apps are not connected"
          className="size-4 text-amber-500"
        />
      ) : (
        <PlusIcon aria-hidden="true" className="size-4" />
      )}
    </Link>
  );
}
