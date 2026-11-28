"use client";

import { CheckIcon, CircleAlertIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
} from "@/components/ui/code-block";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
import { formatDuration, type Step } from "@/lib/chat-model";

function pretty(output: string): string {
  try {
    return JSON.stringify(JSON.parse(output), null, 2);
  } catch {
    return output;
  }
}

function StepRow({ step }: { step: Step }) {
  const status =
    step.status === "running"
      ? "running"
      : step.status === "error"
        ? "error"
        : undefined;
  const Icon =
    step.status === "running"
      ? LoaderCircleIcon
      : step.status === "error"
        ? CircleAlertIcon
        : CheckIcon;
  const took = formatDuration(step.durationMs);
  const canOpen = step.status !== "running";

  const line = (
    <TraceLine status={status}>
      <TraceIcon>
        <Icon
          className={step.status === "running" ? "animate-spin" : undefined}
        />
      </TraceIcon>
      <TraceTitle>{step.title}</TraceTitle>
      {step.status === "error" ? (
        <TraceDescription className="truncate text-destructive/80">
          Failed
        </TraceDescription>
      ) : took ? (
        <Tooltip>
          <TooltipTrigger render={<TraceDescription />}>{took}</TooltipTrigger>
          <TooltipContent>Time this step took</TooltipContent>
        </Tooltip>
      ) : null}
    </TraceLine>
  );

  if (!canOpen) return line;

  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-2 text-[13px]">
        {step.status === "error" ? (
          <div className="flex flex-col gap-1 text-destructive" role="alert">
            <p className="font-medium">{step.error?.message ?? step.summary}</p>
            {step.error?.cause && <p>Cause: {step.error.cause}</p>}
            {step.error?.hint && <p>What to try: {step.error.hint}</p>}
          </div>
        ) : (
          <>
            {step.summary && <p>{step.summary}</p>}
            {step.output && (
              <CodeBlock size="sm">
                <CodeBlockActions>
                  <CodeBlockCopyButton value={pretty(step.output)} />
                </CodeBlockActions>
                <CodeBlockContent className="max-h-64">
                  {pretty(step.output)}
                </CodeBlockContent>
              </CodeBlock>
            )}
          </>
        )}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** "Researched in 4 steps": the tools Rox called, each with its result. Failures are red. */
export function ToolSteps({ steps }: { steps: Step[] }) {
  const running = steps.some((s) => s.status === "running");
  const failed = steps.filter((s) => s.status === "error").length;
  const [open, setOpen] = useState(running);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) setOpen(false);
    wasRunning.current = running;
  }, [running]);
  // A Task: while it runs, the title is the step Rox is on; once done, what it did.
  const current = steps.find((s) => s.status === "running");
  const title = current
    ? `${current.title}…`
    : `Researched in ${steps.length} ${steps.length === 1 ? "step" : "steps"}${
        failed > 0 ? `, ${failed} failed` : ""
      }`;
  const progress = running
    ? `${steps.filter((s) => s.status !== "running").length} of ${steps.length}`
    : null;

  return (
    <Trace>
      <TraceCollapsible open={open} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine
            status={running ? "running" : failed > 0 ? "error" : undefined}
          >
            <TraceTitle>{title}</TraceTitle>
            {progress && <TraceDescription>{progress}</TraceDescription>}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="flex flex-col gap-2">
          {steps.map((step) => (
            <StepRow key={step.callId} step={step} />
          ))}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
