"use client";

import { openRun } from "@/components/runs/run-sheet";
import { Button } from "@/components/ui/button";
import type { RunRef } from "@/lib/chat-model";

const LABEL: Record<string, string> = {
  running: "Running",
  paused: "Paused",
  pr_opened: "PR opened",
  fixed_no_pr: "Fix verified",
  nothing_to_fix: "Nothing to fix",
  gave_up: "Gave up",
  failed: "Failed",
  stopped_infra: "Stopped",
  cancelled: "Cancelled",
  aborted: "Aborted",
  finished: "Finished",
  succeeded: "Finished",
};

const BAD = new Set(["failed", "gave_up", "aborted", "stopped_infra"]);

/** The runs Rox looked at in this reply, each with a View button that opens it (live) in the run sheet. */
export function RunRefs({ runs }: { runs: RunRef[] }) {
  if (runs.length === 0) return null;
  return (
    <ul className="flex w-full min-w-0 flex-col divide-y divide-ink/10 rounded-lg border border-ink/15 bg-white">
      {runs.map((r) => (
        <li
          key={r.runId}
          className="flex min-w-0 items-center gap-3 px-3 py-2 text-[13px]"
        >
          <span className="relative flex size-2 shrink-0" aria-hidden="true">
            {r.live && (
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-green-400 opacity-75" />
            )}
            <span
              className={`relative inline-flex size-2 rounded-full ${
                r.live
                  ? "bg-green-500"
                  : BAD.has(r.result)
                    ? "bg-destructive"
                    : "bg-ink/30"
              }`}
            />
          </span>
          <span className="min-w-0 flex-1 truncate">
            {r.title ?? (r.pr ? `PR #${r.pr}` : r.runId)}
          </span>
          <span
            className={`shrink-0 ${BAD.has(r.result) ? "text-destructive" : "text-ink-soft"}`}
          >
            {LABEL[r.result] ?? r.result}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => openRun(r.runId)}
          >
            View
          </Button>
        </li>
      ))}
    </ul>
  );
}
