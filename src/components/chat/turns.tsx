"use client";

import { useState } from "react";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  Message,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "@/components/ui/message";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Trace, TraceLine, TraceTitle } from "@/components/ui/trace";
import {
  type ChatTurn,
  connectionsFrom,
  formatDuration,
  runsFrom,
} from "@/lib/chat-model";
import { ConnectorsCard } from "./connectors-card";
import { Markdown } from "./markdown";
import {
  CopyAction,
  EditAction,
  type Rating,
  RatingActions,
  RetryAction,
} from "./message-actions";
import { Plan } from "./plan";
import { PlanQueue } from "./plan-queue";
import { RunRefs } from "./run-refs";
import { Thinking } from "./thinking";
import { ToolSteps } from "./tool-steps";

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const fullFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

function Time({ iso }: { iso: string }) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<time dateTime={iso} className="px-1 tabular-nums" />}
      >
        {timeFormat.format(date)}
      </TooltipTrigger>
      <TooltipContent>{fullFormat.format(date)}</TooltipContent>
    </Tooltip>
  );
}

/** The person's message: a bubble on the right, with Copy and Edit under it. */
export function UserTurn({
  text,
  at,
  pending,
  onEdit,
}: {
  text: string;
  at: string;
  pending: boolean;
  onEdit: (text: string) => void;
}) {
  return (
    <Message align="end">
      <MessageContent>
        <Bubble variant="outline" align="end">
          <BubbleContent className="whitespace-pre-wrap text-[15px]">
            {text}
          </BubbleContent>
        </Bubble>
        {!pending && (
          <MessageFooter className="gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/message:opacity-100 pointer-coarse:opacity-100">
            <Time iso={at} />
            <CopyAction text={text} />
            <EditAction onEdit={() => onEdit(text)} />
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  );
}

/** How long the turn took, from its first event to its last. */
function turnSeconds(turn: ChatTurn): number | null {
  if (!turn.startedAt || !turn.endedAt) return null;
  const ms = Date.parse(turn.endedAt) - Date.parse(turn.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Rox's reply: thinking, the plan, the tool steps, the words, and what to do next. */
export function AssistantTurn({
  turn,
  onRetry,
}: {
  turn: ChatTurn;
  /** Runs the turn again. */
  onRetry?: () => void;
}) {
  const [rating, setRating] = useState<Rating>(null);
  const running = turn.status === "running";
  const connections = connectionsFrom(turn);
  const runs = runsFrom(turn);
  const answer = turn.blocks
    .filter((b) => b.kind === "text")
    .map((b) => (b.kind === "text" ? b.text : ""))
    .join("\n\n");

  const lastBlock = turn.blocks[turn.blocks.length - 1];
  const showWaiting =
    running &&
    !(lastBlock?.kind === "thinking" && lastBlock.live) &&
    !(lastBlock?.kind === "text" && lastBlock.live) &&
    !(
      lastBlock?.kind === "steps" &&
      lastBlock.steps.some((s) => s.status === "running")
    );

  return (
    <Message>
      <MessageContent>
        <MessageHeader className="px-0 text-[16px] font-semibold text-foreground">
          Rox
        </MessageHeader>

        {turn.blocks.map((block, index) => {
          const key = `${turn.key}-${index}-${block.kind}`;
          switch (block.kind) {
            case "thinking":
              return (
                <Thinking
                  key={key}
                  text={block.text}
                  live={block.live}
                  durationMs={block.durationMs}
                />
              );
            case "plan":
              return block.view === "plan" ? (
                <Plan
                  key={key}
                  title={block.title}
                  items={block.items}
                  running={running}
                />
              ) : (
                <PlanQueue key={key} items={block.items} running={running} />
              );
            case "steps":
              return <ToolSteps key={key} steps={block.steps} />;
            case "text":
              return (
                <Bubble key={key} variant="ghost">
                  <BubbleContent>
                    <Markdown text={block.text} />
                  </BubbleContent>
                </Bubble>
              );
            case "error":
              return (
                <div
                  key={key}
                  role="alert"
                  className="flex max-w-prose flex-col gap-1 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-[13px] text-destructive"
                >
                  <p className="font-medium">{block.message}</p>
                  {block.hint && <p>What to try: {block.hint}</p>}
                  {onRetry && (
                    <div className="pt-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={onRetry}
                      >
                        Try again
                      </Button>
                    </div>
                  )}
                </div>
              );
            case "stopped":
              return (
                <p key={key} className="text-[13px] text-ink-soft">
                  Stopped.
                </p>
              );
            default:
              return null;
          }
        })}

        {showWaiting && (
          <Trace>
            <TraceLine status="running">
              <TraceTitle>
                {turn.blocks.length === 0 ? "Thinking…" : "Working…"}
              </TraceTitle>
            </TraceLine>
          </Trace>
        )}

        {runs.length > 0 && <RunRefs runs={runs} />}

        {connections && !running && (
          <div className="flex w-full min-w-0 flex-col gap-2">
            <p className="text-[13px] font-medium">Apps Rox can work with</p>
            <ConnectorsCard connections={connections} />
          </div>
        )}

        {!running && answer && (
          <MessageFooter className="gap-0.5 px-0">
            <CopyAction text={answer} />
            <RatingActions value={rating} onChange={setRating} />
            {onRetry && <RetryAction onRetry={onRetry} />}
            {turnSeconds(turn) !== null && (
              <Tooltip>
                <TooltipTrigger
                  render={<span className="px-1.5 tabular-nums" />}
                >
                  {formatDuration(turnSeconds(turn))}
                </TooltipTrigger>
                <TooltipContent>Time Rox took to run this turn</TooltipContent>
              </Tooltip>
            )}
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  );
}
