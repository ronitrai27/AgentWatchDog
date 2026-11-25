"use client";

import { CheckIcon } from "lucide-react";
import { Brand, type BrandId } from "@/components/setup/brand";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Connection } from "@/lib/chat-model";

const LOGOS = new Set<string>([
  "github",
  "slack",
  "linear",
  "sentry",
  "posthog",
  "vercel",
  "betterstack",
]);

/** The apps worth connecting first. */
const RECOMMENDED = new Set(["slack", "sentry", "vercel"]);

function Chip({ connection: c }: { connection: Connection }) {
  const connected = c.status === "connected";
  const githubInTest = c.id === "github" && c.status === "test_mode";
  const recommended = RECOMMENDED.has(c.id) && !connected;

  return (
    <li className="shrink-0 list-none">
      <Badge
        variant="outline"
        className="h-9 gap-2 border-ink/25 bg-mist-50 pr-1 pl-2.5 text-[13px] font-medium text-foreground"
      >
        {LOGOS.has(c.id) && <Brand id={c.id as BrandId} size={18} />}
        {c.name}
        {recommended && (
          <Badge
            variant="secondary"
            className="h-5 bg-ink/8 px-1.5 text-[11px] font-medium text-ink"
          >
            Recommended
          </Badge>
        )}
        {connected ? (
          <span className="inline-flex h-7 items-center gap-1 rounded-full bg-ink/8 px-2.5 text-xs">
            <CheckIcon className="size-3.5" />
            Connected
          </span>
        ) : githubInTest ? (
          <span className="inline-flex h-7 items-center rounded-full bg-ink/8 px-2.5 text-xs">
            Test mode
          </span>
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-disabled="true"
                  aria-label={`Connect ${c.name} (demo only for now)`}
                  className="h-7 cursor-not-allowed rounded-full bg-white px-3 text-xs"
                />
              }
            >
              Connect
            </TooltipTrigger>
            <TooltipContent>
              {c.gives ? `${c.gives}. ` : ""}Demo only: connecting {c.name} is
              not built yet.
            </TooltipContent>
          </Tooltip>
        )}
      </Badge>
    </li>
  );
}

/** Shown first: GitHub (what Rox is working on) and the three apps worth connecting first. */
const FIRST = ["github", "slack", "sentry", "vercel"];

/**
 * Every app as a badge (logo, name, Connect) in one line that scrolls sideways. Which apps are connected comes from Rox's own connections_list tool.
 * Connecting is a demo for now (only GitHub is real), and the button says so when hovered.
 */
export function ConnectorsCard({ connections }: { connections: Connection[] }) {
  const first = FIRST.map((id) => connections.find((c) => c.id === id)).filter(
    (c): c is Connection => Boolean(c),
  );
  const rest = connections.filter((c) => !FIRST.includes(c.id));

  return (
    <ul
      aria-label="Apps Rox can connect to"
      className="m-0 flex w-full min-w-0 gap-2 overflow-x-scroll p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {[...first, ...rest].map((c) => (
        <Chip key={c.id} connection={c} />
      ))}
    </ul>
  );
}
