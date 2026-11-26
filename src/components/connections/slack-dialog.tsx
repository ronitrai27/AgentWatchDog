"use client";

import {
  CheckCircle2Icon,
  CircleAlertIcon,
  Loader2Icon,
  XIcon,
} from "lucide-react";
import Image from "next/image";
import { useEffect, useState, useTransition } from "react";
import {
  checkSlackConnection,
  connectSlack,
  disconnectReport,
} from "@/app/(app)/home/actions";
import type { ReportConnection, SlackCheck } from "@/lib/report-connections";

/** What Rox really does in Slack today. Shown on the card and in the dialog. */
export const SLACK_CAPABILITIES = [
  "Posts a report after every pull request it opens: what failed, the root cause, the fix, the checks that passed, and the link.",
  "Says so when it stops without a fix, and why, so no run ends silently.",
  "Posts only in the one channel you choose here; the merge stays a human click on GitHub.",
];

export function SlackDialog({
  connection,
  onClose,
}: {
  connection: ReportConnection | null;
  onClose: () => void;
}) {
  const [check, setCheck] = useState<SlackCheck | null>(null);
  const [channel, setChannel] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [checking, startCheck] = useTransition();
  const [saving, startSave] = useTransition();

  const runCheck = () =>
    startCheck(async () => {
      setError(null);
      const r = await checkSlackConnection();
      if (!r.ok) return setError(r.error);
      setCheck(r.check);
      setChannel(
        (prev) =>
          prev ||
          r.check.channels.find((c) => c.id === connection?.channelId)?.id ||
          r.check.channels[0]?.id ||
          "",
      );
    });

  // Check the tokens as soon as the dialog opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on open
  useEffect(runCheck, []);

  const confirm = () =>
    startSave(async () => {
      setError(null);
      const r = await connectSlack(channel);
      if (!r.ok) return setError(r.error);
      onClose();
    });

  const disconnect = () =>
    startSave(async () => {
      const r = await disconnectReport("slack");
      if (!r.ok) return setError(r.error);
      onClose();
    });

  const missing = check?.keys.filter((k) => k.required && !k.found) ?? [];

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 bg-ink/35"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="slack-dialog-title"
        className="relative z-10 w-full max-w-md rounded-xl border border-ink/25 bg-white p-6 shadow-xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded border border-ink/20 bg-paper">
              <Image
                src="/slack.png"
                alt=""
                width={44}
                height={44}
                unoptimized
                className="size-[56%] object-contain"
              />
            </span>
            <div>
              <h3
                id="slack-dialog-title"
                className="font-rox text-[17px] font-semibold text-ink"
              >
                {connection ? "Slack is connected" : "Connect Slack"}
              </h3>
              <p className="text-[12px] text-ink-muted">
                {connection
                  ? `${connection.workspace ?? "Workspace"} · #${connection.channelName ?? connection.channelId}`
                  : "Uses the Rox bot tokens saved on the server"}
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="focusable grid size-7 place-items-center rounded-md text-ink/60 hover:bg-ink/8 hover:text-ink"
          >
            <XIcon aria-hidden="true" className="size-4" />
          </button>
        </div>

        <div className="mt-4 rounded-lg border border-ink/20 bg-paper p-3.5">
          <p className="text-[11.5px] font-semibold uppercase tracking-wider text-ink-muted">
            What Rox does in Slack
          </p>
          <ul className="mt-2 space-y-1.5 text-[13px] text-ink">
            {SLACK_CAPABILITIES.map((c) => (
              <li key={c} className="flex gap-2">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[#2f7d4f]" />
                {c}
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-4 text-[13px]">
          {checking && !check && (
            <p className="flex items-center gap-2 text-ink-soft">
              <Loader2Icon className="size-4 animate-spin" />
              Checking the Slack tokens…
            </p>
          )}
          {check && (
            <ul className="space-y-1">
              {check.keys
                .filter((k) => k.required || k.found)
                .map((k) => (
                  <li key={k.name} className="flex items-center gap-2">
                    {k.found ? (
                      <CheckCircle2Icon className="size-3.5 text-[#2f7d4f]" />
                    ) : (
                      <CircleAlertIcon className="size-3.5 text-red-700" />
                    )}
                    <span className="text-ink">{k.label}</span>
                    <span className="text-ink-muted">
                      {k.found ? "found" : "missing"}
                    </span>
                  </li>
                ))}
              {check.ready && (
                <li className="flex items-center gap-2">
                  <CheckCircle2Icon className="size-3.5 text-[#2f7d4f]" />
                  <span className="text-ink">
                    Signed in to <b>{check.workspace}</b> as @{check.botUser}
                  </span>
                </li>
              )}
            </ul>
          )}
          {check?.ready && check.channels.length > 0 && (
            <label className="mt-4 block">
              <span className="text-[12px] font-semibold text-ink">
                Post reports in
              </span>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                className="focusable mt-1 w-full rounded-md border border-ink/25 bg-white px-2.5 py-1.5 text-[13px] text-ink"
              >
                {check.channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.isPrivate ? "🔒 " : "#"}
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(error ?? check?.error) && (
            <p className="mt-3 rounded-md border border-red-700/25 bg-red-50 px-3 py-2 text-[12.5px] text-red-800">
              {error ?? check?.error}
            </p>
          )}
          {check &&
            missing.length === 0 &&
            check.ready &&
            check.channels.length > 0 &&
            !connection && (
              <p className="mt-3 text-[12.5px] text-ink-soft">
                Slack tokens found and working. Confirm to connect: Rox will
                send its final report here after every run.
              </p>
            )}
        </div>

        <div className="mt-5 flex items-center justify-between gap-2 border-t border-ink/20 pt-4">
          <div>
            {connection && (
              <button
                type="button"
                disabled={saving}
                onClick={disconnect}
                className="btn btn-secondary"
              >
                Disconnect
              </button>
            )}
          </div>
          <div className="flex gap-2">
            {check && (!check.ready || check.channels.length === 0) && (
              <button
                type="button"
                disabled={checking}
                onClick={runCheck}
                className="btn btn-secondary"
              >
                Check again
              </button>
            )}
            <button
              type="button"
              disabled={
                !check?.ready ||
                !channel ||
                saving ||
                checking ||
                connection?.channelId === channel
              }
              onClick={confirm}
              className="btn btn-primary"
            >
              {saving
                ? "Saving…"
                : connection
                  ? "Save channel"
                  : "Confirm and connect"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
