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
  checkBetterStackConnection,
  connectBetterStack,
  disconnectBetterStack,
} from "@/app/(app)/home/actions";
import type {
  BetterStackCheck,
  BetterStackConnection,
} from "@/lib/betterstack-connection";

/** What Rox really does with Better Stack today. */
export const BETTERSTACK_CAPABILITIES = [
  "Wakes when the heartbeat or monitor you choose goes down, if “Monitor incident started” is on in Settings > Workflow.",
  "Reads each incident back from Better Stack's API before acting on it, so a forged webhook cannot wake Rox.",
  "Registers its own webhook in your Better Stack account when you connect. Nothing else in Better Stack is changed.",
  "Answers your questions in chat through Better Stack's MCP server with the same token (coming next: the chat side is not built yet).",
];

const keyOf = (kind: string, id: string) => `${kind}:${id}`;

export function BetterStackDialog({
  connection,
  onClose,
}: {
  connection: BetterStackConnection | null;
  onClose: () => void;
}) {
  const [check, setCheck] = useState<BetterStackCheck | null>(null);
  const [picked, setPicked] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [checking, startCheck] = useTransition();
  const [saving, startSave] = useTransition();

  const runCheck = () =>
    startCheck(async () => {
      setError(null);
      const r = await checkBetterStackConnection();
      if (!r.ok) return setError(r.error);
      setCheck(r.check);
      const first = r.check.sources[0];
      setPicked(
        (prev) =>
          prev ||
          (connection ? keyOf(connection.kind, connection.id) : "") ||
          (first ? keyOf(first.kind, first.id) : ""),
      );
    });

  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on open
  useEffect(runCheck, []);

  const confirm = () =>
    startSave(async () => {
      setError(null);
      const [kind, id] = picked.split(":") as ["heartbeat" | "monitor", string];
      const r = await connectBetterStack(kind, id);
      if (!r.ok) return setError(r.error);
      onClose();
    });

  const disconnect = () =>
    startSave(async () => {
      const r = await disconnectBetterStack();
      if (!r.ok) return setError(r.error);
      onClose();
    });

  const heartbeats = check?.sources.filter((s) => s.kind === "heartbeat") ?? [];
  const monitors = check?.sources.filter((s) => s.kind === "monitor") ?? [];
  const canConnect =
    check?.ready && check.secret && Boolean(check.webhookUrl) && picked;

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
        aria-labelledby="betterstack-dialog-title"
        className="relative z-10 w-full max-w-md rounded-xl border border-ink/25 bg-white p-6 shadow-xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center overflow-hidden rounded border border-ink/20 bg-white">
              <Image
                src="/beter-stack.svg"
                alt=""
                width={44}
                height={44}
                unoptimized
                className="size-full object-cover"
              />
            </span>
            <div>
              <h3
                id="betterstack-dialog-title"
                className="font-rox text-[17px] font-semibold text-ink"
              >
                {connection
                  ? "Better Stack is connected"
                  : "Connect Better Stack"}
              </h3>
              <p className="text-[12px] text-ink-muted">
                {connection
                  ? `${connection.kind === "heartbeat" ? "Heartbeat" : "Monitor"} · ${connection.name}`
                  : "Uses the Better Stack token saved on the server"}
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
            What Rox does with Better Stack
          </p>
          <ul className="mt-2 space-y-1.5 text-[13px] text-ink">
            {BETTERSTACK_CAPABILITIES.map((c) => (
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
              Checking the Better Stack token…
            </p>
          )}
          {check && (
            <ul className="space-y-1">
              {[
                {
                  ok: check.ready,
                  label: check.ready
                    ? "Token works (BETTERSTACK_API_TOKEN)"
                    : "Token (BETTERSTACK_API_TOKEN)",
                  note: "",
                },
                {
                  ok: Boolean(check.mcp?.ok),
                  label: "MCP server (for questions in chat)",
                  note: check.mcp?.ok
                    ? `${check.mcp.tools} tools`
                    : (check.mcp?.error ?? "not checked"),
                },
                {
                  ok: check.secret,
                  label: "Webhook secret (BETTERSTACK_WEBHOOK_SECRET)",
                  note: check.secret ? "found" : "missing",
                },
                {
                  ok: Boolean(check.webhookUrl),
                  label: "Webhook address (BETTERSTACK_WEBHOOK_URL)",
                  note: check.webhookUrl ? "found" : "missing",
                },
              ].map((row) => (
                <li key={row.label} className="flex items-center gap-2">
                  {row.ok ? (
                    <CheckCircle2Icon className="size-3.5 text-[#2f7d4f]" />
                  ) : (
                    <CircleAlertIcon className="size-3.5 text-red-700" />
                  )}
                  <span className="text-ink">{row.label}</span>
                  {row.note && (
                    <span className="text-ink-muted">{row.note}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {check?.ready && check.sources.length > 0 && (
            <label className="mt-4 block">
              <span className="text-[12px] font-semibold text-ink">
                Wake Rox when this goes down
              </span>
              <select
                value={picked}
                onChange={(e) => setPicked(e.target.value)}
                className="focusable mt-1 w-full rounded-md border border-ink/25 bg-white px-2.5 py-1.5 text-[13px] text-ink"
              >
                {heartbeats.length > 0 && (
                  <optgroup label="Heartbeats">
                    {heartbeats.map((s) => (
                      <option
                        key={keyOf(s.kind, s.id)}
                        value={keyOf(s.kind, s.id)}
                      >
                        {s.name} ({s.detail})
                      </option>
                    ))}
                  </optgroup>
                )}
                {monitors.length > 0 && (
                  <optgroup label="Monitors">
                    {monitors.map((s) => (
                      <option
                        key={keyOf(s.kind, s.id)}
                        value={keyOf(s.kind, s.id)}
                      >
                        {s.name}
                      </option>
                    ))}
                  </optgroup>
                )}
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
            {check && !canConnect && (
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
                !canConnect ||
                saving ||
                checking ||
                (connection !== null &&
                  keyOf(connection.kind, connection.id) === picked)
              }
              onClick={confirm}
              className="btn btn-primary"
            >
              {saving ? "Saving…" : connection ? "Save" : "Confirm and connect"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
