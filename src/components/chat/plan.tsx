"use client";

import {
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  RouteIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import type { PlanItem } from "@/lib/chat-model";

/**
 * Rox's plan for one goal, its steps known before it started: "Plan: check PR 12 · 2 of 4 done".
 * Built with Trace and one TraceCollapsible. Open while Rox works, closed once it is done.
 */
export function Plan({
  title,
  items: all,
  running,
}: {
  title: string;
  items: PlanItem[];
  running: boolean;
}) {
  // Nothing is in progress once Rox has stopped working.
  const items = running
    ? all
    : all.map((i) =>
        i.status === "doing" ? { ...i, status: "todo" as const } : i,
      );
  const done = items.filter((i) => i.status === "done").length;
  const finished = done === items.length;
  const [open, setOpen] = useState(!finished);
  const wasFinished = useRef(finished);
  useEffect(() => {
    if (!wasFinished.current && finished) setOpen(false);
    wasFinished.current = finished;
  }, [finished]);

  return (
    <Trace aria-label="Rox's plan">
      <TraceCollapsible open={open} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine status={running && !finished ? "running" : undefined}>
            <TraceIcon>
              <RouteIcon />
            </TraceIcon>
            <TraceTitle>Plan: {title || "this job"}</TraceTitle>
            <TraceDescription>
              {done} of {items.length} done
            </TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="flex flex-col gap-1.5">
          {items.map((item, index) => (
            <TraceLine
              key={`${index}-${item.text}`}
              status={
                item.status === "doing"
                  ? "running"
                  : item.status === "todo"
                    ? "pending"
                    : undefined
              }
            >
              <TraceIcon>
                {item.status === "done" ? (
                  <CircleCheckIcon />
                ) : item.status === "doing" ? (
                  <CircleDotIcon />
                ) : (
                  <CircleIcon />
                )}
              </TraceIcon>
              <TraceTitle>{item.text}</TraceTitle>
            </TraceLine>
          ))}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
