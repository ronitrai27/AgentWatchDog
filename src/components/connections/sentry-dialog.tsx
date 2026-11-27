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
  checkSentryConnection,
  connectSentry,
  disconnectSentry,
} from "@/app/(app)/home/actions";
import type { SentryCheck, SentryConnection } from "@/lib/sentry-connection";

/** What Rox really does with Sentry today. */
export const SENTRY_CAPABILITIES = [
  "Wakes on a new issue, an error spike or a regression in the project you choose, for the triggers on in Settings > Workflow.",
  "Reads the issue's latest event: the exception, the line in your code where it broke, the release and the service.",
  "One run per issue: a burst of alerts for the same issue never starts a second run.",
];

export function SentryDialog({
  connection,
  onClose,
}: {
  connection: SentryConnection | null;
  onClose: () => void;
}) {
  const [check, setCheck] = useState<SentryCheck | null>(null);
  const [project, setProject] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [checking, startCheck] = useTransition();
  const [saving, startSave] = useTransition();

  const runCheck = () =>
    startCheck(async () => {
      setError(null);
      const r = await checkSentryConnection();
      if (!r.ok) return setError(r.error);
      setCheck(r.check);
      setProject(
        (prev) =>
          prev ||
          r.check.projects.find((p) => p.id === connection?.projectId)?.id ||
          r.check.projects[0]?.id ||
          "",
      );
    });

  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on open
  useEffect(runCheck, []);

  const confirm = () =>
    startSave(async () => {
      setError(null);
      const r = await connectSentry(project);
      if (!r.ok) return setError(r.error);
      onClose();
    });

  const disconnect = () =>
    startSave(async () => {
      const r = await disconnectSentry();
      if (!r.ok) return setError(r.error);
      onClose();
    });

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
        aria-labelledby="sentry-dialog-title"
        className="relative z-10 w-full max-w-md rounded-xl border border-ink/25 bg-white p-6 shadow-xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded bg-ink">
              <Image
                src="/sentry.svg"
                alt=""
                width={44}
                height={44}
                unoptimized
                className="size-[56%] object-contain"
              />
            </span>
            <div>
              <h3
                id="sentry-dialog-title"
                className="font-rox text-[17px] font-semibold text-ink"
              >
                {connection ? "Sentry is connected" : "Connect Sentry"}
              </h3>
              <p className="text-[12px] text-ink-muted">
                {connection
                  ? `${connection.org} · ${connection.project}`
                  : "Uses the Sentry token saved on the server"}
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
            What Rox does with Sentry
          </p>
          <ul className="mt-2 space-y-1.5 text-[13px] text-ink">
            {SENTRY_CAPABILITIES.map((c) => (
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
              Checking the Sentry token…
            </p>
          )}
          {check && (
            <ul className="space-y-1">
              <li className="flex items-center gap-2">
                {check.ready ? (
                  <CheckCircle2Icon className="size-3.5 text-[#2f7d4f]" />
                ) : (
                  <CircleAlertIcon className="size-3.5 text-red-700" />
                )}
                <span className="text-ink">
                  {check.ready
                    ? `Token works for ${check.org}`
                    : "Token (SENTRY_AUTH_TOKEN, SENTRY_ORG)"}
                </span>
              </li>
              <li className="flex items-center gap-2">
                {check.webhooks ? (
                  <CheckCircle2Icon className="size-3.5 text-[#2f7d4f]" />
                ) : (
                  <CircleAlertIcon className="size-3.5 text-red-700" />
                )}
                <span className="text-ink">
                  Webhook secret (SENTRY_CLIENT_SECRET)
                </span>
                <span className="text-ink-muted">
                  {check.webhooks ? "found" : "missing: events cannot wake Rox"}
                </span>
              </li>
            </ul>
          )}
          {check?.ready && check.projects.length > 0 && (
            <label className="mt-4 block">
              <span className="text-[12px] font-semibold text-ink">
                Wake Rox for errors in
              </span>
              <select
                value={project}
                onChange={(e) => setProject(e.target.value)}
                className="focusable mt-1 w-full rounded-md border border-ink/25 bg-white px-2.5 py-1.5 text-[13px] text-ink"
              >
                {check.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.slug}
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
            {check && !check.ready && (
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
                !project ||
                saving ||
                checking ||
                connection?.projectId === project
              }
              onClick={confirm}
              className="btn btn-primary"
            >
              {saving
                ? "Saving…"
                : connection
                  ? "Save project"
                  : "Confirm and connect"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
