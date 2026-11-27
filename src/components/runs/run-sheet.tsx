"use client";

import {
  ActivityIcon,
  ArrowLeftIcon,
  BotIcon,
  BoxIcon,
  CheckIcon,
  CircleDashedIcon,
  CopyIcon,
  ExternalLinkIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  ScaleIcon,
  SearchIcon,
  ShieldIcon,
  SparklesIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Brand, type BrandId } from "@/components/setup/brand";
import type { RunEventView, RunView } from "@/lib/runs";

export type SheetApp = {
  id: BrandId;
  name: string;
  connected: boolean;
  detail: string;
};

const WIDTH = 460;
const POLL_MS = 4000;

// ---------- small helpers ----------

const money = (usd: number) =>
  usd === 0
    ? "$0.00"
    : usd < 0.01
      ? `$${usd.toFixed(4)}`
      : `$${usd.toFixed(2)}`;

const tokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1)}k`
      : String(n);

function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const TRIGGERS: Record<string, string> = {
  "github:pr_main": "PR opened against main",
  "github:failed_ci": "Failed GitHub Actions CI",
  "sentry:new_issue": "Sentry new issue",
  "sentry:error_spike": "Sentry error spike",
  "sentry:regression": "Sentry regression",
};

function invoked(run: RunView) {
  const how =
    run.invokedBy === "webhook"
      ? "Webhook"
      : run.invokedBy === "chat"
        ? "Asked in chat"
        : "Started by hand";
  const what = run.trigger
    ? (TRIGGERS[run.trigger] ?? run.trigger)
    : run.source;
  return `${how} · ${what}`;
}

const STATUS: Record<RunView["status"], { label: string; cls: string }> = {
  running: { label: "Running", cls: "bg-sky-50 text-sky-800 border-sky-200" },
  paused: {
    label: "Paused",
    cls: "bg-amber-50 text-amber-800 border-amber-200",
  },
  succeeded: {
    label: "Finished",
    cls: "bg-green-50 text-green-800 border-green-200",
  },
  failed: { label: "Failed", cls: "bg-red-50 text-red-800 border-red-200" },
  cancelled: {
    label: "Cancelled",
    cls: "bg-neutral-100 text-neutral-700 border-neutral-200",
  },
  aborted: {
    label: "Aborted",
    cls: "bg-neutral-100 text-neutral-700 border-neutral-200",
  },
};

const OUTCOME: Record<string, string> = {
  fixed: "Fixed",
  nothing_to_fix: "Nothing to fix",
  gave_up: "Gave up",
  infra: "Stopped: infrastructure",
};

/** Who did this step: the agent, the decision model, a check or the sandbox. */
function actorOf(e: RunEventView): { label: string; icon: ReactNode } {
  const s = e.step;
  const icon = (n: ReactNode) => n;
  if (e.kind.startsWith("decision.") || s === "scan" || s === "route")
    return { label: "Decision model", icon: icon(<ScaleIcon />) };
  if (s === "investigate")
    return { label: "Investigator", icon: <SearchIcon /> };
  if (s === "fix") return { label: "Engineer", icon: <WrenchIcon /> };
  if (s === "judge") return { label: "Judge", icon: <ScaleIcon /> };
  if (s === "verify") return { label: "Verifier", icon: <CheckIcon /> };
  if (s === "publish")
    return {
      label: "Pull request",
      icon: e.kind === "pr.merged" ? <GitMergeIcon /> : <GitPullRequestIcon />,
    };
  if (s.startsWith("hunt"))
    return { label: "Security hunt", icon: <ShieldIcon /> };
  if (s === "agent2" || s === "agent")
    return { label: "Agent", icon: <BotIcon /> };
  if (s === "prepare" || s === "install")
    return { label: "Sandbox", icon: <BoxIcon /> };
  if (s === "run") return { label: "Run", icon: <ActivityIcon /> };
  if (s === "triage" || s === "report")
    return { label: s[0].toUpperCase() + s.slice(1), icon: <SparklesIcon /> };
  return { label: "Check", icon: <TerminalIcon /> };
}

const DOT: Record<string, string> = {
  pass: "bg-green-600",
  fail: "bg-red-600",
  error: "bg-red-600",
  running: "bg-sky-500 animate-pulse",
  cancelled: "bg-neutral-400",
  skipped: "bg-neutral-300",
};

// ---------- data ----------

function useOverview() {
  const [data, setData] = useState<{
    active: RunView | null;
    recent: RunView[];
  }>({
    active: null,
    recent: [],
  });
  useEffect(() => {
    let gone = false;
    const load = () =>
      fetch("/api/runs", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d && !gone) setData(d);
        })
        .catch(() => {});
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      gone = true;
      clearInterval(t);
    };
  }, []);
  return data;
}

/** One run, live: its row and every event, over SSE. Reconnects where it left off. */
function useRunStream(id: string | null) {
  const [run, setRun] = useState<RunView | null>(null);
  const [events, setEvents] = useState<RunEventView[]>([]);
  useEffect(() => {
    setRun(null);
    setEvents([]);
    if (!id) return;
    let last = 0;
    let ended = false;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      source = new EventSource(
        `/api/runs/${encodeURIComponent(id)}/stream?after=${last}`,
      );
      source.addEventListener("run", (m) =>
        setRun(JSON.parse((m as MessageEvent).data)),
      );
      source.addEventListener("event", (m) => {
        const e = JSON.parse((m as MessageEvent).data) as RunEventView;
        if (e.seq <= last) return;
        last = e.seq;
        setEvents((prev) => [...prev, e]);
      });
      source.addEventListener("end", () => {
        ended = true;
        source?.close();
      });
      source.onerror = () => {
        source?.close();
        if (!ended) retry = setTimeout(open, 2000);
      };
    };
    open();
    return () => {
      ended = true;
      source?.close();
      clearTimeout(retry);
    };
  }, [id]);
  return { run, events };
}

/** Ticks every second while the run is going, so the duration moves. */
function useNow(live: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  return now;
}

// ---------- the sheet ----------

export function RunSheet({ apps }: { apps: SheetApp[] }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const { active, recent } = useOverview();
  const shown = picked ?? active?.id ?? null;
  const running = Boolean(active);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="run-sheet"
        style={{ right: open ? WIDTH : 0 }}
        className={`focusable fixed top-20 z-50 flex flex-col items-center gap-2 rounded-l-lg border border-r-0 px-1.5 py-3 text-[12px] font-semibold shadow-sm transition-[right,background-color] duration-300 ease-out ${
          running
            ? "border-green-800/40 bg-green-900 text-white hover:bg-green-800"
            : "border-ink/20 bg-white text-ink hover:bg-paper"
        }`}
      >
        {open ? (
          <PanelRightCloseIcon className="size-4" aria-hidden="true" />
        ) : (
          <PanelRightOpenIcon className="size-4" aria-hidden="true" />
        )}
        <span className="[writing-mode:vertical-rl] rotate-180 tracking-wide">
          {running ? "Running" : "No runs"}
        </span>
        {running && (
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-green-300 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-green-300" />
          </span>
        )}
      </button>

      <aside
        id="run-sheet"
        aria-label="Pipeline run"
        aria-hidden={!open}
        style={{ width: WIDTH }}
        className={`fixed inset-y-0 right-0 z-40 flex max-w-full flex-col border-l border-ink/20 bg-white shadow-2xl transition-transform duration-300 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-ink/15 px-5">
          <div className="flex items-center gap-2">
            {picked && (
              <button
                type="button"
                onClick={() => setPicked(null)}
                aria-label="Back"
                className="focusable grid size-7 place-items-center rounded-md text-ink/70 hover:bg-ink/8"
              >
                <ArrowLeftIcon className="size-4" />
              </button>
            )}
            <h2 className="font-rox text-[15px] font-semibold text-ink">
              {shown ? "Pipeline run" : "Pipeline"}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="focusable grid size-7 place-items-center rounded-md text-ink/60 hover:bg-ink/8 hover:text-ink"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        {open &&
          (shown ? (
            <RunDetail id={shown} />
          ) : (
            <Empty apps={apps} recent={recent} onPick={setPicked} />
          ))}
      </aside>
    </>
  );
}

function RunDetail({ id }: { id: string }) {
  const { run, events } = useRunStream(id);
  const [all, setAll] = useState(false);
  const live = run ? !run.finishedAt : false;
  const now = useNow(live);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const visible = useMemo(
    () =>
      all
        ? events
        : events.filter(
            (e) => e.kind !== "model.call" && e.kind !== "tool.call",
          ),
    [events, all],
  );

  // Follow new events, unless the reader scrolled up.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on each new event
  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  if (!run)
    return (
      <div className="grid flex-1 place-items-center text-[13px] text-ink/60">
        Loading the run…
      </div>
    );

  const ms = run.durationMs ?? now - new Date(run.startedAt).getTime();
  const lastStep = [...events]
    .reverse()
    .find((e) => e.kind !== "model.call" && e.kind !== "tool.call");
  const status = STATUS[run.status];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Summary card */}
      <div className="shrink-0 border-b border-ink/15 px-5 py-4">
        <div className="rounded-xl border border-ink/15 bg-paper/50 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p
                className="truncate text-[14px] font-semibold text-ink"
                title={run.title ?? undefined}
              >
                {run.title ?? run.repo ?? "Pipeline run"}
              </p>
              <p className="mt-0.5 truncate text-[12px] text-ink/60">
                {run.repo}
                {run.pr ? ` · PR #${run.pr}` : ""}
              </p>
            </div>
            <span
              className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${status.cls}`}
            >
              {live && (
                <span className="mr-1 inline-block size-1.5 animate-pulse rounded-full bg-current align-middle" />
              )}
              {status.label}
            </span>
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
            <Meta label="Run">
              <span className="font-mono">{run.id.slice(0, 8)}</span>
              <button
                type="button"
                aria-label="Copy run id"
                onClick={() => navigator.clipboard?.writeText(run.id)}
                className="ml-1 text-ink/50 hover:text-ink"
              >
                <CopyIcon className="inline size-3" />
              </button>
            </Meta>
            <Meta label="Started">
              {new Date(run.startedAt).toLocaleString([], {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </Meta>
            <Meta label="Invoked" wide>
              {invoked(run)}
            </Meta>
            {run.model && <Meta label="Model">{run.model}</Meta>}
            {run.prAction && (
              <Meta label="PR action">
                {run.prAction === "merge_pr" ? "Merge PR" : "Open PR"}
              </Meta>
            )}
          </dl>
        </div>

        <div className="mt-3 grid grid-cols-4 gap-2">
          <Stat
            label="Cost"
            value={money(run.costUsd)}
            hint={run.dayBudgetUsd ? `of $${run.dayBudgetUsd}/day` : undefined}
          />
          <Stat label="Duration" value={duration(ms)} />
          <Stat
            label="Tokens"
            value={tokens(run.tokensIn + run.tokensOut)}
            hint={`${run.modelCalls} calls`}
          />
          <Stat label="Events" value={String(run.lastSeq)} />
        </div>

        {lastStep && live && (
          <p className="mt-3 flex items-center gap-2 truncate text-[12px] text-ink/70">
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-sky-500" />
            <span className="font-medium text-ink">
              {actorOf(lastStep).label}:
            </span>
            <span className="truncate">{lastStep.title}</span>
          </p>
        )}
        {!live && (run.outcome || run.reason || run.prUrl) && (
          <div className="mt-3 space-y-1 text-[12px] text-ink/75">
            {run.outcome && (
              <p>
                <span className="font-medium text-ink">Outcome:</span>{" "}
                {OUTCOME[run.outcome] ?? run.outcome}
              </p>
            )}
            {run.reason && <p className="line-clamp-2">{run.reason}</p>}
            {run.prUrl && (
              <a
                href={run.prUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium text-green-800 underline underline-offset-2"
              >
                {run.prMergedAt ? "Merged pull request" : "Pull request"}
                <ExternalLinkIcon className="size-3" />
              </a>
            )}
          </div>
        )}
      </div>

      {/* Timeline */}
      <div className="flex shrink-0 items-center justify-between px-5 pt-3 pb-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ink/55">
          Progress
        </p>
        <div className="flex rounded-md border border-ink/15 p-0.5 text-[11px]">
          {(["Key steps", "Everything"] as const).map((label, i) => (
            <button
              key={label}
              type="button"
              onClick={() => setAll(i === 1)}
              className={`rounded px-2 py-0.5 ${all === (i === 1) ? "bg-ink text-white" : "text-ink/70 hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-5 pb-6"
      >
        {visible.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-ink/55">
            Waiting for the first step…
          </p>
        ) : (
          <ol className="relative">
            {visible.map((e, i) => (
              <EventRow key={e.seq} e={e} last={i === visible.length - 1} />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function EventRow({ e, last }: { e: RunEventView; last: boolean }) {
  const actor = actorOf(e);
  const compact = e.kind === "model.call" || e.kind === "tool.call";
  const d = e.data ?? {};
  const detail =
    e.kind === "model.call"
      ? `${tokens(Number(d.in ?? 0))} in · ${tokens(Number(d.out ?? 0))} out · ${money(Number(d.usd ?? 0))}`
      : typeof d.summary === "string"
        ? d.summary
        : typeof d.reason === "string"
          ? d.reason
          : null;

  return (
    <li className="relative flex gap-3 pb-3">
      {!last && (
        <span
          className="absolute top-4 bottom-0 left-[9px] w-px bg-ink/12"
          aria-hidden="true"
        />
      )}
      <span
        className={`relative z-10 mt-0.5 grid size-[19px] shrink-0 place-items-center rounded-full border border-ink/15 bg-white text-ink/70 [&_svg]:size-2.5 ${compact ? "scale-90 opacity-70" : ""}`}
      >
        {e.status ? (
          <span
            className={`size-2 rounded-full ${DOT[e.status] ?? "bg-ink/40"}`}
          />
        ) : (
          actor.icon
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p
            className={`min-w-0 text-[12px] ${compact ? "text-ink/60" : "text-ink"}`}
          >
            <span
              className={`mr-1.5 font-semibold ${compact ? "text-ink/70" : "text-ink"}`}
            >
              {e.kind === "model.call"
                ? "Model"
                : e.kind === "tool.call"
                  ? "Tool"
                  : actor.label}
            </span>
            <span className={compact ? "font-mono text-[11px]" : ""}>
              {e.kind === "model.call"
                ? String(d.model ?? "")
                : e.title.slice(0, compact ? 90 : 200)}
            </span>
          </p>
          <span className="shrink-0 text-[10.5px] tabular-nums text-ink/45">
            {e.ms ? `${duration(e.ms)} · ` : ""}
            {clock(e.at)}
          </span>
        </div>
        {detail && (
          <p
            className={`mt-0.5 line-clamp-2 text-[11.5px] ${compact ? "text-ink/50" : "text-ink/60"}`}
          >
            {detail}
          </p>
        )}
        {e.attempt && e.attempt > 1 && (
          <p className="mt-0.5 text-[11px] text-amber-700">
            Retried after a crash (attempt {e.attempt})
          </p>
        )}
      </div>
    </li>
  );
}

function Meta({
  label,
  wide,
  children,
}: {
  label: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`min-w-0 ${wide ? "col-span-2" : ""}`}>
      <dt className="text-[10.5px] uppercase tracking-wider text-ink/50">
        {label}
      </dt>
      <dd className="truncate text-ink">{children}</dd>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-ink/12 px-2.5 py-2">
      <p className="text-[10.5px] text-ink/55">{label}</p>
      <p className="text-[14px] font-semibold tabular-nums text-ink">{value}</p>
      {hint && <p className="truncate text-[10px] text-ink/45">{hint}</p>}
    </div>
  );
}

// ---------- nothing running ----------

function Empty({
  apps,
  recent,
  onPick,
}: {
  apps: SheetApp[];
  recent: RunView[];
  onPick: (id: string) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
      <div className="flex flex-col items-center text-center">
        <IdleIllustration />
        <p className="mt-4 font-rox text-[16px] font-semibold text-ink">
          Nothing is running right now
        </p>
        <p className="mt-1 max-w-xs text-[12.5px] text-ink/60">
          Rox starts on its own when a trigger fires: a pull request, a failed
          CI run or a Sentry error. Its steps show here live.
        </p>
      </div>

      <section className="mt-7">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ink/55">
          Connected apps
        </p>
        <ul className="mt-2 divide-y divide-ink/10 rounded-xl border border-ink/15">
          {apps.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-3 py-2.5">
              <Brand id={a.id} size={20} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-ink">{a.name}</p>
                <p className="truncate text-[11.5px] text-ink/55">{a.detail}</p>
              </div>
              {a.connected ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-800">
                  <CheckIcon className="size-3" />
                  Connected
                </span>
              ) : (
                <Link
                  href="/home/connections"
                  className="text-[11.5px] font-medium text-ink underline underline-offset-2"
                >
                  Connect
                </Link>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-5 rounded-xl border border-dashed border-ink/25 bg-paper/50 p-4">
        <p className="text-[13px] font-medium text-ink">
          Configure more trigger points
        </p>
        <p className="mt-0.5 text-[12px] text-ink/60">
          Choose which events wake Rox, its model, day budget, time limit and
          whether it merges.
        </p>
        <Link
          href="/home/settings?tab=workflow"
          className="btn btn-secondary mt-3 inline-flex"
        >
          Open settings
        </Link>
      </section>

      {recent.length > 0 && (
        <section className="mt-6">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink/55">
            Recent runs
          </p>
          <ul className="mt-2 space-y-1.5">
            {recent.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onPick(r.id)}
                  className="focusable flex w-full items-center gap-3 rounded-lg border border-ink/12 px-3 py-2 text-left hover:bg-paper"
                >
                  <CircleDashedIcon className="size-3.5 shrink-0 text-ink/45" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12.5px] font-medium text-ink">
                      {r.title ?? r.repo ?? r.id.slice(0, 8)}
                    </p>
                    <p className="truncate text-[11px] text-ink/55">
                      {invoked(r)} ·{" "}
                      {new Date(r.startedAt).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10.5px] font-semibold ${STATUS[r.status].cls}`}
                  >
                    {STATUS[r.status].label}
                  </span>
                  <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-ink/55">
                    {money(r.costUsd)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** A pipeline node at rest: a card with its toolbar, wired to nothing. */
function IdleIllustration() {
  return (
    <svg
      viewBox="0 0 320 170"
      className="w-full max-w-[300px]"
      role="img"
      aria-label="An idle pipeline step"
    >
      <g
        fill="none"
        stroke="currentColor"
        className="text-ink/25"
        strokeWidth="1.5"
      >
        <path d="M10 92h58" />
        <path d="M252 72h26a8 8 0 0 1 8 8v-20a8 8 0 0 1 8-8h16" />
        <path d="M252 104h26a8 8 0 0 0 8-8v30a8 8 0 0 0 8 8h16" />
      </g>
      <path d="M118 34h84l10 16H108z" className="fill-ink/10" />
      <g
        className="text-ink/45"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M127 39.5v6l5-3z" />
        <circle cx="144" cy="42.5" r="3" />
        <rect x="155" y="41" width="6" height="5" rx="1" />
        <path d="M156.5 41v-1.5a1.5 1.5 0 0 1 3 0V41" />
        <rect x="170" y="39.5" width="5" height="5" rx="1" />
        <rect x="172" y="41.5" width="5" height="5" rx="1" />
        <path d="M184 40h7M185 40l.6 6h4.8l.6-6" />
      </g>
      <rect
        x="68"
        y="50"
        width="184"
        height="98"
        rx="14"
        className="fill-white stroke-ink/20"
        strokeWidth="1.5"
      />
      <rect
        x="62"
        y="80"
        width="8"
        height="24"
        rx="3"
        className="fill-ink/12"
      />
      <rect
        x="250"
        y="62"
        width="8"
        height="18"
        rx="3"
        className="fill-ink/12"
      />
      <rect
        x="250"
        y="96"
        width="8"
        height="18"
        rx="3"
        className="fill-ink/12"
      />
      <rect
        x="84"
        y="64"
        width="72"
        height="9"
        rx="4.5"
        className="fill-ink/12"
      />
      <rect
        x="208"
        y="62"
        width="30"
        height="14"
        rx="5"
        className="fill-ink/8"
      />
      <rect
        x="84"
        y="86"
        width="110"
        height="7"
        rx="3.5"
        className="fill-ink/8"
      />
      <rect
        x="84"
        y="99"
        width="78"
        height="7"
        rx="3.5"
        className="fill-ink/8"
      />
      <rect
        x="84"
        y="116"
        width="154"
        height="20"
        rx="6"
        className="fill-ink/6"
      />
      <rect
        x="214"
        y="120"
        width="18"
        height="12"
        rx="6"
        className="fill-ink/15"
      />
      <circle cx="221" cy="126" r="4" className="fill-white" />
    </svg>
  );
}
