"use client";

import { CheckIcon, CircleDashedIcon, LoaderCircleIcon } from "lucide-react";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import type { PlanItem } from "@/lib/chat-model";

function Section({
  title,
  items,
  defaultOpen,
}: {
  title: string;
  items: PlanItem[];
  defaultOpen: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <TraceCollapsible defaultOpen={defaultOpen}>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceTitle>{title}</TraceTitle>
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
                <CheckIcon />
              ) : item.status === "doing" ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : (
                <CircleDashedIcon />
              )}
            </TraceIcon>
            <TraceTitle>{item.text}</TraceTitle>
          </TraceLine>
        ))}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** Rox's own to-do list as a queue: "3 to do", "2 completed". Built with Trace. */
export function PlanQueue({
  items: all,
  running,
}: {
  items: PlanItem[];
  running: boolean;
}) {
  // Nothing is in progress once Rox has stopped working.
  const items = running
    ? all
    : all.map((i) =>
        i.status === "doing" ? { ...i, status: "todo" as const } : i,
      );
  const open = items.filter((i) => i.status !== "done");
  const done = items.filter((i) => i.status === "done");
  return (
    <Trace aria-label="Rox's plan">
      <Section
        title={`${open.length} ${running ? "to do" : "not finished"}`}
        items={open}
        defaultOpen
      />
      <Section
        title={`${done.length} completed`}
        items={done}
        defaultOpen={false}
      />
    </Trace>
  );
}
