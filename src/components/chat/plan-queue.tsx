"use client";

import {
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  ListChecksIcon,
  ListTodoIcon,
  type LucideIcon,
} from "lucide-react";
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
  icon: Icon,
  items,
  defaultOpen,
}: {
  title: string;
  icon: LucideIcon;
  items: PlanItem[];
  defaultOpen: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <TraceCollapsible defaultOpen={defaultOpen}>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceIcon>
            <Icon />
          </TraceIcon>
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
  );
}

/**
 * Several separate things the user asked for, as a queue: "3 to do", "1 completed".
 * Built with Trace, one TraceCollapsible per section.
 */
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
        icon={ListTodoIcon}
        items={open}
        defaultOpen
      />
      <Section
        title={`${done.length} completed`}
        icon={ListChecksIcon}
        items={done}
        defaultOpen={false}
      />
    </Trace>
  );
}
