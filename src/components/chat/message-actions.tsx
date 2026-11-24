"use client";

import {
  CheckIcon,
  CopyIcon,
  PencilIcon,
  RotateCcwIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

function ActionButton({
  label,
  children,
  ...props
}: {
  label: string;
  children: React.ReactNode;
} & Omit<React.ComponentProps<typeof Button>, "children" | "aria-label">) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            {...props}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Writes the text to the clipboard, then shows a check for two seconds. */
export function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <>
      <ActionButton
        label={copied ? "Copied" : "Copy"}
        onClick={() => {
          navigator.clipboard
            .writeText(text)
            .then(() => setCopied(true))
            .catch(() => {});
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </ActionButton>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </>
  );
}

export type Rating = "good" | "bad" | null;

/** Good and bad response are toggles: pressing the active one clears it. */
export function RatingActions({
  value,
  onChange,
}: {
  value: Rating;
  onChange: (next: Rating) => void;
}) {
  return (
    <>
      <ActionButton
        label="Good response"
        aria-pressed={value === "good"}
        onClick={() => onChange(value === "good" ? null : "good")}
        className={value === "good" ? "bg-muted text-foreground" : undefined}
      >
        <ThumbsUpIcon />
      </ActionButton>
      <ActionButton
        label="Bad response"
        aria-pressed={value === "bad"}
        onClick={() => onChange(value === "bad" ? null : "bad")}
        className={value === "bad" ? "bg-muted text-foreground" : undefined}
      >
        <ThumbsDownIcon />
      </ActionButton>
    </>
  );
}

export function RetryAction({ onRetry }: { onRetry: () => void }) {
  return (
    <ActionButton label="Retry" onClick={onRetry}>
      <RotateCcwIcon />
    </ActionButton>
  );
}

export function EditAction({ onEdit }: { onEdit: () => void }) {
  return (
    <ActionButton label="Edit" onClick={onEdit}>
      <PencilIcon />
    </ActionButton>
  );
}
