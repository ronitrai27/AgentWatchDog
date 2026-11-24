"use client";

import { PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { Brand, type BrandId } from "@/components/setup/brand";
import type { Insights } from "@/lib/insights";

const APPS: { id: BrandId; name: string }[] = [
  { id: "sentry", name: "Sentry" },
  { id: "slack", name: "Slack" },
  { id: "vercel", name: "Vercel" },
  { id: "linear", name: "Linear" },
];

const GITHUB = {
  connected: "Connected",
  demo: "Test mode",
  unreachable: "Not answering",
  none: "Not linked",
  expired: "Expired",
} as const;

const small =
  "focusable ml-auto rounded-full border border-ink/15 bg-white px-3 py-1 text-xs font-medium text-ink hover:border-ink/35";

/** "Connectors +" in the message box. Only GitHub is real; the others are a demo. */
export function Connectors({ github }: { github?: Insights["github"] }) {
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState<string | null>(null);
  // The recommended apps (Sentry, Slack, Vercel) cannot be connected yet. Quick Demo Mode runs
  // them in test mode, and nothing is claimed until the state is known.
  const missing = github !== undefined && github !== "demo";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: closes the menu with Escape or on leaving
    <div
      className="relative"
      onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
      onBlur={(e) =>
        !e.currentTarget.contains(e.relatedTarget) && setOpen(false)
      }
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="focusable flex h-8 items-center gap-2 rounded-full border border-ink/15 bg-white px-3 text-[13px] font-medium text-ink hover:border-ink/35"
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
      </button>
      {open && (
        <ul className="absolute bottom-10 left-0 z-20 m-0 w-64 list-none rounded-xl border border-ink/15 bg-white p-1.5 text-[13px] text-ink shadow-lg">
          <li className="flex h-10 items-center gap-2.5 px-2">
            <Brand id="github" size={20} />
            GitHub
            {github === "expired" ? (
              <a href="/api/auth/github/install" className={small}>
                Reconnect
              </a>
            ) : (
              <span className="ml-auto text-xs text-ink-soft">
                {github ? GITHUB[github] : "Checking…"}
              </span>
            )}
          </li>
          {APPS.map((app) => (
            <li key={app.id} className="flex h-10 items-center gap-2.5 px-2">
              <Brand id={app.id} size={20} />
              {app.name}
              <button
                type="button"
                className={small}
                onClick={() => setAsked(app.id)}
              >
                {asked === app.id ? "Coming soon" : "Connect"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
