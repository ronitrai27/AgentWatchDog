"use client";

import { useEffect, useRef, useState } from "react";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { formatDuration } from "@/lib/chat-model";
import { Markdown } from "./markdown";

/**
 * Rox's reasoning. While it streams the line says "Thinking…" and shimmers, and the text is
 * open so it can be read as it arrives. When it is done the line says "Thought for 5s" and
 * folds away. Built with Trace and TraceCollapsible.
 */
export function Thinking({
  text,
  live,
  durationMs,
}: {
  text: string;
  live: boolean;
  durationMs: number | null;
}) {
  // Count seconds while live, so "Thinking…" can be followed by how long it has been.
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [live]);

  // Open while it streams, fold away when it is done. The person can still open it again.
  const [open, setOpen] = useState(live);
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live) setOpen(false);
    wasLive.current = live;
  }, [live]);

  const title = live
    ? "Thinking…"
    : durationMs === null
      ? "Thought"
      : durationMs < 1000
        ? "Thought briefly"
        : `Thought for ${formatDuration(durationMs)}`;

  return (
    <Trace>
      <TraceCollapsible open={open} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine status={live ? "running" : undefined}>
            <TraceTitle>{title}</TraceTitle>
            {live && seconds > 0 && (
              <span className="shrink-0 tabular-nums text-muted-foreground/70">
                {seconds}s
              </span>
            )}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Markdown text={text} className="text-[14px]" />
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
