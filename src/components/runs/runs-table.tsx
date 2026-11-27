"use client";

import {
  ArrowDownUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  DownloadIcon,
  ExternalLinkIcon,
  GitMergeIcon,
  SearchIcon,
  TerminalIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Brand } from "@/components/setup/brand";
import type { RunView } from "@/lib/runs";
import {
  duration,
  invoked,
  money,
  OUTCOME,
  openRun,
  shownStatus,
  TRIGGERS,
  tokens,
} from "./run-sheet";

const POLL_MS = 5000;
const PAGE_SIZES = [10, 25, 50];

type Tab = "all" | "active" | "succeeded" | "failed" | "stopped";
const TABS: { id: Tab; label: string; match: (r: RunView) => boolean }[] = [
  { id: "all", label: "All runs", match: () => true },
  {
    id: "active",
    label: "Running",
    match: (r) => r.status === "running" || r.status === "paused",
  },
  {
    id: "succeeded",
    label: "Finished",
    match: (r) => r.status === "succeeded" && r.outcome !== "gave_up",
  },
  {
    id: "failed",
    label: "Failed",
    match: (r) => r.status === "failed" || r.outcome === "gave_up",
  },
  {
    id: "stopped",
    label: "Cancelled",
    match: (r) => r.status === "cancelled" || r.status === "aborted",
  },
];

type SortKey = "started" | "cost" | "duration";

const SOURCES = [
  { id: "all", label: "All sources" },
  { id: "github", label: "GitHub" },
  { id: "sentry", label: "Sentry" },
  { id: "cli", label: "Started by hand" },
];

const since = (iso: string) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

const msOf = (r: RunView) =>
  r.durationMs ?? Date.now() - new Date(r.startedAt).getTime();

/** What the run concluded, as a coloured outline badge. */
function outcomeBadge(r: RunView): {
  label: string;
  cls: string;
  note: string;
} {
  if (r.prMergedAt)
    return {
      label: "Merged",
      cls: "border-violet-300 text-violet-700",
      note: "Rox merged its fix",
    };
  if (r.outcome === "fixed")
    return {
      label: "Fixed",
      cls: "border-green-300 text-green-700",
      note: r.prUrl ? "Pull request opened" : "Fix verified",
    };
  if (r.outcome === "nothing_to_fix")
    return {
      label: "Clean",
      cls: "border-green-300 text-green-700",
      note: "Nothing to fix",
    };
  if (r.outcome === "gave_up")
    return {
      label: "Gave up",
      cls: "border-amber-300 text-amber-700",
      note: r.reason ?? "No safe fix found",
    };
  if (r.status === "failed")
    return {
      label: "Error",
      cls: "border-red-300 text-red-700",
      note: r.reason ?? "Rox stopped on an error",
    };
  if (r.status === "cancelled" || r.status === "aborted")
    return {
      label: "Stopped",
      cls: "border-neutral-300 text-neutral-600",
      note: r.reason ?? "Cancelled",
    };
  if (r.status === "running" || r.status === "paused")
    return {
      label: "Working",
      cls: "border-sky-300 text-sky-700",
      note: "In progress",
    };
  return {
    label: OUTCOME[r.outcome ?? ""] ?? "Checked",
    cls: "border-neutral-300 text-neutral-600",
    note: "Checks finished",
  };
}

function SourceMark({ source }: { source: string }) {
  if (source === "github" || source === "sentry")
    return <Brand id={source} size={16} />;
  return <TerminalIcon className="size-4 text-ink/60" />;
}

export function RunsTable({ initial }: { initial: RunView[] }) {
  const [runs, setRuns] = useState(initial);
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: "started",
    desc: true,
  });
  const [size, setSize] = useState(10);
  const [page, setPage] = useState(1);

  // Live: a run that starts or finishes shows without a reload.
  useEffect(() => {
    let gone = false;
    const t = setInterval(() => {
      fetch("/api/runs?all=1", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d?.runs && !gone) setRuns(d.runs);
        })
        .catch(() => {});
    }, POLL_MS);
    return () => {
      gone = true;
      clearInterval(t);
    };
  }, []);

  const counts = useMemo(
    () =>
      Object.fromEntries(
        TABS.map((t) => [t.id, runs.filter(t.match).length]),
      ) as Record<Tab, number>,
    [runs],
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = TABS.find((t) => t.id === tab)?.match ?? (() => true);
    const list = runs.filter(
      (r) =>
        match(r) &&
        (source === "all" ||
          (source === "cli"
            ? r.invokedBy !== "webhook"
            : r.source === source)) &&
        (!q ||
          [r.id, r.title, r.repo, r.trigger, r.pr ? `#${r.pr}` : ""]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(q))),
    );
    const value = (r: RunView) =>
      sort.key === "cost"
        ? r.costUsd
        : sort.key === "duration"
          ? msOf(r)
          : new Date(r.startedAt).getTime();
    return list.sort((a, b) => (value(a) - value(b)) * (sort.desc ? -1 : 1));
  }, [runs, tab, query, source, sort]);

  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(page, pages);
  const shown = rows.slice((current - 1) * size, current * size);
  const maxCost = Math.max(0.0001, ...runs.map((r) => r.costUsd));
  const attention = counts.failed + counts.active;

  const toggleSort = (key: SortKey) =>
    setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }));

  const exportCsv = () => {
    const head = [
      "run_id",
      "started_at",
      "invoked",
      "repo",
      "pr",
      "title",
      "status",
      "outcome",
      "model",
      "cost_usd",
      "duration_ms",
      "tokens",
      "pr_url",
    ];
    const cell = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    const body = rows.map((r) =>
      [
        r.id,
        r.startedAt,
        invoked(r),
        r.repo,
        r.pr,
        r.title,
        r.status,
        r.outcome,
        r.model,
        r.costUsd,
        r.durationMs,
        r.tokensIn + r.tokensOut,
        r.prUrl,
      ]
        .map(cell)
        .join(","),
    );
    const url = URL.createObjectURL(
      new Blob([[head.join(","), ...body].join("\n")], { type: "text/csv" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "rox-runs.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="-my-4 flex min-h-[calc(100svh-5.5rem)] w-full flex-col sm:-my-7">
      <div className="flex shrink-0 flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="font-rox text-[22px] font-semibold text-ink">
            All runs
          </h2>
          <p className="mt-0.5 text-[13px] text-ink/60">
            {runs.length === 0
              ? "No pipeline run yet. One starts when a trigger fires."
              : attention
                ? `${attention} run${attention === 1 ? "" : "s"} need${attention === 1 ? "s" : ""} your attention right now`
                : "Every run Rox made, with its trace and cost"}
          </p>
        </div>
        <button
          type="button"
          onClick={exportCsv}
          disabled={rows.length === 0}
          className="btn btn-primary mr-10"
        >
          <DownloadIcon className="size-4" />
          Export CSV
        </button>
      </div>

      <div className="mt-5 flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-ink/15 bg-white shadow-sm">
        {/* Tabs */}
        <div
          role="tablist"
          className="flex shrink-0 overflow-x-auto border-b border-ink/12 bg-paper/50"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => {
                setTab(t.id);
                setPage(1);
              }}
              className={`flex shrink-0 items-center gap-2 border-r border-ink/10 px-4 py-2.5 text-[13px] font-medium transition-colors ${
                tab === t.id
                  ? "bg-white text-ink"
                  : "text-ink/60 hover:bg-white/60 hover:text-ink"
              }`}
            >
              {t.label}
              <span className="rounded-md bg-ink/8 px-1.5 text-[11px] tabular-nums text-ink/70">
                {counts[t.id]}
              </span>
            </button>
          ))}
        </div>

        {/* Toolbar */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-4 py-3">
          <label className="relative w-full max-w-xs">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink/40" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
              placeholder="Search runs, repos, PRs"
              className="focusable h-9 w-full rounded-lg border border-ink/15 bg-white pr-3 pl-8 text-[13px] text-ink placeholder:text-ink/40"
            />
          </label>
          <div className="flex items-center gap-2">
            <label className="flex h-9 items-center gap-2 rounded-lg border border-ink/15 pl-3 text-[13px] text-ink/60">
              Source:
              <select
                value={source}
                onChange={(e) => {
                  setSource(e.target.value);
                  setPage(1);
                }}
                className="h-full rounded-r-lg bg-paper/60 px-2 font-medium text-ink"
              >
                {SOURCES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() =>
                setSort((s) => ({ key: "started", desc: !s.desc }))
              }
              className="btn btn-secondary h-9"
            >
              <ArrowDownUpIcon className="size-3.5" />
              {sort.key === "started" && !sort.desc ? "Oldest" : "Newest"}
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="flex flex-1 flex-col overflow-x-auto">
          <table className="w-full min-w-[960px] border-collapse text-left">
            <thead>
              <tr className="border-y border-ink/15 bg-paper/60 text-[12.5px] font-semibold text-ink/85">
                <th className="px-4 py-2.5 font-semibold">Run</th>
                <th className="px-4 py-2.5 font-semibold">Trigger</th>
                <th className="px-4 py-2.5 font-semibold">
                  <SortHead
                    label="Duration"
                    on={sort.key === "duration"}
                    onClick={() => toggleSort("duration")}
                  />
                </th>
                <th className="px-4 py-2.5 font-semibold">Status</th>
                <th className="px-4 py-2.5 font-semibold">
                  <SortHead
                    label="Cost"
                    on={sort.key === "cost"}
                    onClick={() => toggleSort("cost")}
                  />
                </th>
                <th className="px-4 py-2.5 font-semibold">Outcome</th>
                <th className="sticky right-0 bg-paper/95 px-4 py-2.5 text-right font-semibold">
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0
                ? null
                : shown.map((r) => {
                    const st = shownStatus(r);
                    const out = outcomeBadge(r);
                    const live =
                      r.status === "running" || r.status === "paused";
                    const share = Math.max(0.03, r.costUsd / maxCost);
                    return (
                      <tr
                        key={r.id}
                        className="group border-b border-ink/8 transition-colors hover:bg-paper/50"
                      >
                        <td className="max-w-[240px] px-4 py-3">
                          <p
                            className="truncate text-[13px] font-semibold text-ink"
                            title={r.title ?? undefined}
                          >
                            {r.title ?? r.repo ?? "Pipeline run"}
                          </p>
                          <p className="mt-0.5 truncate text-[11.5px] text-ink/55">
                            <span className="font-mono">
                              {r.id.slice(0, 8)}
                            </span>
                            {" · "}
                            {since(r.startedAt)}
                          </p>
                        </td>
                        <td className="max-w-[220px] px-4 py-3">
                          <div className="flex items-center gap-2">
                            <SourceMark source={r.source} />
                            <p className="truncate text-[13px] font-medium text-ink">
                              {r.trigger
                                ? (TRIGGERS[r.trigger] ?? r.trigger)
                                : r.source === "cli"
                                  ? "Lab run"
                                  : r.source}
                            </p>
                          </div>
                          <p className="mt-0.5 truncate text-[11.5px] text-ink/55">
                            {r.repo}
                            {r.pr ? ` · PR #${r.pr}` : ""}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-[13px] tabular-nums text-ink">
                            {duration(msOf(r))}
                          </p>
                          <p className="mt-0.5 text-[11.5px] text-ink/55">
                            {r.lastSeq} steps ·{" "}
                            {tokens(r.tokensIn + r.tokensOut)} tokens
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] font-semibold ${st.cls}`}
                          >
                            <span
                              className={`size-1.5 rounded-full bg-current ${live ? "animate-pulse" : ""}`}
                            />
                            {st.label}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="h-1.5 w-20 overflow-hidden rounded-full bg-ink/8">
                              <span
                                className="block h-full rounded-full bg-green-800"
                                style={{ width: `${share * 100}%` }}
                              />
                            </span>
                            <span className="text-[12px] tabular-nums text-ink/70">
                              {money(r.costUsd)}
                            </span>
                          </div>
                          <p className="mt-0.5 truncate text-[11.5px] text-ink/55">
                            {r.model ?? "-"}
                          </p>
                        </td>
                        <td className="max-w-[200px] px-4 py-3">
                          <span
                            className={`inline-flex items-center gap-1 rounded-full border bg-white px-2 py-0.5 text-[11.5px] font-medium ${out.cls}`}
                          >
                            {r.prMergedAt && (
                              <GitMergeIcon className="size-3" />
                            )}
                            {out.label}
                          </span>
                          {r.prUrl ? (
                            <a
                              href={r.prUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-0.5 flex items-center gap-1 truncate text-[11.5px] text-green-800 hover:underline"
                            >
                              {out.note}
                              <ExternalLinkIcon className="size-3 shrink-0" />
                            </a>
                          ) : (
                            <p
                              className="mt-0.5 truncate text-[11.5px] text-ink/55"
                              title={out.note}
                            >
                              {out.note}
                            </p>
                          )}
                        </td>
                        <td className="sticky right-0 bg-white px-4 py-3 text-right transition-colors group-hover:bg-paper">
                          <button
                            type="button"
                            onClick={() => openRun(r.id)}
                            className="focusable inline-flex h-8 items-center gap-1 rounded-lg border border-green-800/40 bg-white px-3 text-[12.5px] font-semibold text-green-900 hover:bg-green-50"
                          >
                            {live ? "Watch" : "View"}
                            <ChevronRightIcon className="size-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
            </tbody>
          </table>
          {shown.length === 0 && (
            <div className="grid flex-1 place-items-center px-4 py-12 text-center text-[13px] text-ink/55">
              <p className="max-w-md">
                {runs.length === 0
                  ? "No runs yet. Open a pull request, fail a CI run or raise a Sentry error and Rox starts on its own."
                  : "No run matches these filters."}
              </p>
            </div>
          )}
        </div>

        {/* Pagination */}
        <div className="mt-auto flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-ink/12 bg-paper/40 px-4 py-2.5 text-[12.5px] text-ink/65">
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous page"
              disabled={current === 1}
              onClick={() => setPage(current - 1)}
              className="grid size-7 place-items-center rounded-md hover:bg-white disabled:opacity-35"
            >
              <ChevronLeftIcon className="size-4" />
            </button>
            {Array.from({ length: pages }, (_, i) => i + 1)
              .filter(
                (n) => n === 1 || n === pages || Math.abs(n - current) <= 1,
              )
              .map((n, i, list) => (
                <span key={n} className="flex items-center">
                  {i > 0 && n - list[i - 1] > 1 && (
                    <span className="px-1 text-ink/40">…</span>
                  )}
                  <button
                    type="button"
                    onClick={() => setPage(n)}
                    aria-current={n === current ? "page" : undefined}
                    className={`grid h-7 min-w-7 place-items-center rounded-md px-1.5 tabular-nums ${
                      n === current
                        ? "border border-ink/15 bg-white font-semibold text-ink"
                        : "hover:bg-white"
                    }`}
                  >
                    {n}
                  </button>
                </span>
              ))}
            <button
              type="button"
              aria-label="Next page"
              disabled={current === pages}
              onClick={() => setPage(current + 1)}
              className="grid size-7 place-items-center rounded-md hover:bg-white disabled:opacity-35"
            >
              <ChevronRightIcon className="size-4" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            Show
            <select
              value={size}
              onChange={(e) => {
                setSize(Number(e.target.value));
                setPage(1);
              }}
              className="h-7 rounded-md border border-ink/15 bg-white px-1.5 text-ink"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            per page
            <span className="ml-2 tabular-nums">
              {rows.length === 0
                ? "0"
                : `${(current - 1) * size + 1}–${Math.min(current * size, rows.length)}`}{" "}
              of {rows.length}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function SortHead({
  label,
  on,
  onClick,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 hover:text-ink ${on ? "text-ink" : ""}`}
    >
      {label}
      <ChevronsUpDownIcon className="size-3" />
    </button>
  );
}
