"use client";

import {
  ArrowLeftRightIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  LayersIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react";
import Image from "next/image";
import { useState } from "react";

type Category = "Observability" | "Deploys & Cloud" | "Workflow";

type Connector = {
  id: string;
  name: string;
  src: string;
  dark?: boolean;
  fill?: boolean;
  recommended?: boolean;
  category: Category;
  description: string;
  scopes: string[];
};

const CONNECTORS: Connector[] = [
  {
    id: "vercel",
    name: "Vercel",
    src: "/vercel.png",
    dark: true,
    recommended: true,
    category: "Deploys & Cloud",
    description:
      "Monitor production and preview deployments, build logs, and edge runtime failures automatically.",
    scopes: ["Deployment webhooks", "Build & function logs", "Preview URLs"],
  },
  {
    id: "slack",
    name: "Slack",
    src: "/slack.png",
    recommended: true,
    category: "Workflow",
    description:
      "Post root-cause summaries to incident channels and request human approval before merging fixes.",
    scopes: [
      "Incident thread updates",
      "Merge approval actions",
      "Alert digests",
    ],
  },
  {
    id: "sentry",
    name: "Sentry",
    src: "/sentry.svg",
    dark: true,
    recommended: true,
    category: "Observability",
    description:
      "Wake Rox on new unhandled exceptions with full stack traces, breadcrumbs, and release context.",
    scopes: ["Issue & regression webhooks", "Stack traces", "Release health"],
  },
  {
    id: "grafana",
    name: "Grafana",
    src: "/grafana.svg",
    recommended: true,
    category: "Observability",
    description:
      "Correlate latency spikes, error-rate burn, and dashboard alerts with recent code changes.",
    scopes: [
      "Alerting webhooks",
      "Panel & PromQL snapshots",
      "SLO annotations",
    ],
  },
  {
    id: "github",
    name: "GitHub",
    src: "/github-dark.svg",
    dark: true,
    category: "Deploys & Cloud",
    description:
      "Read repository code and failing CI checks, then open verified pull requests on an isolated branch.",
    scopes: [
      "Contents & pull requests",
      "Check runs & logs",
      "Push awd/* branches",
    ],
  },
  {
    id: "linear",
    name: "Linear",
    src: "/linear.png",
    dark: true,
    category: "Workflow",
    description:
      "Link incidents to engineering issues, attach reproduction diffs, and sync triage status.",
    scopes: ["Create & link issues", "Status sync", "Incident comments"],
  },
  {
    id: "betterstack",
    name: "Better Stack",
    src: "/beter-stack.svg",
    fill: true,
    category: "Observability",
    description:
      "Trigger investigations when uptime monitors fail, heartbeats miss, or log anomalies spike.",
    scopes: ["Uptime incident webhooks", "Heartbeat checks", "Log tailing"],
  },
  {
    id: "posthog",
    name: "PostHog",
    src: "/posthog.svg",
    category: "Observability",
    description:
      "Detect conversion drops, rage clicks, and client-side error spikes right after a release.",
    scopes: ["Trend & funnel alerts", "Error events", "Feature flag state"],
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    src: "/cloudflare-color.png",
    category: "Deploys & Cloud",
    description:
      "Inspect 5xx origin spikes, Worker exceptions, and WAF anomalies across edge routes.",
    scopes: ["Worker tail logs", "Origin 5xx alerts", "Route & DNS health"],
  },
  {
    id: "aws",
    name: "AWS",
    src: "/aws-color.png",
    dark: true,
    category: "Deploys & Cloud",
    description:
      "Read CloudWatch alarms, container health events, and read-only ECS or Lambda telemetry.",
    scopes: ["CloudWatch alarms", "Log group queries", "Service health"],
  },
  {
    id: "notion",
    name: "Notion",
    src: "/Notion-logo.png",
    category: "Workflow",
    description:
      "Reference service runbooks during diagnosis and draft structured postmortem pages.",
    scopes: ["Read team runbooks", "Draft postmortems", "Architecture docs"],
  },
  {
    id: "plane",
    name: "Plane",
    src: "/plane.jpeg",
    fill: true,
    category: "Workflow",
    description:
      "Track bug items across cycles and attach sandbox verification reports automatically.",
    scopes: ["Work item creation", "Cycle & module tags", "Verification links"],
  },
];

function ConnectorTile({
  src,
  dark,
  fill,
  size = "md",
}: {
  src: string;
  dark?: boolean;
  fill?: boolean;
  size?: "sm" | "md";
}) {
  const box = size === "sm" ? "size-9 rounded" : "size-10 rounded";
  const img = size === "sm" ? 18 : 22;

  return (
    <span
      className={`grid shrink-0 place-items-center overflow-hidden ${box} ${
        dark
          ? "bg-ink"
          : fill
            ? "border border-ink/20 bg-white"
            : "border border-ink/20 bg-paper"
      }`}
    >
      <Image
        src={src}
        alt=""
        width={img * 2}
        height={img * 2}
        unoptimized
        className={
          fill ? "size-full object-cover" : "size-[56%] object-contain"
        }
      />
    </span>
  );
}

export function ConnectionsView({ repo }: { repo: string | null }) {
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => ({
    github: repo !== null,
    sentry: true,
    slack: true,
  }));
  const [inspecting, setInspecting] = useState<Connector | null>(null);

  const toggle = (id: string) =>
    setEnabled((prev) => ({ ...prev, [id]: !prev[id] }));

  const activeCount = Object.values(enabled).filter(Boolean).length;

  return (
    <div className="-mx-4 -my-8 sm:-mx-6 sm:-my-12 flex min-h-[calc(100svh-3.5rem)] flex-col bg-paper/60">
      {/* Page header */}
      <div className="border-b border-ink/20 bg-linear-to-r from-paper to-green-900/40 px-6 py-8 sm:px-12">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="font-rox text-[26px] font-semibold leading-tight tracking-tight text-ink">
              Connections
            </h2>
            <p className="mt-1.5 text-[14px] text-ink">
              Connect observability, deployments, and team tools to Rox.
            </p>
          </div>
        </div>
      </div>

      <div className="w-full flex-1 px-6 py-8 sm:px-12">
        <div className="mt-3 mb-10 grid gap-4 lg:grid-cols-2">
          {/* Collection 1: Incident triggers */}
          <div className="flex items-center justify-between gap-6 overflow-hidden rounded-sm border border-ink/20 bg-white p-6">
            <div className="min-w-0">
              <h3 className="font-rox text-[17px] font-semibold leading-snug text-ink">
                Automated incident triggers
              </h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">
                Wake Rox the moment an exception spikes, a deployment fails, or
                Grafana crosses an alert threshold.
              </p>
              <a
                href="#all-connectors"
                className="focusable mt-4 inline-flex items-center gap-1.5 rounded text-[13px] font-semibold text-ink transition-colors hover:text-green-800"
              >
                View apps
                <ArrowRightIcon aria-hidden="true" className="size-3.5" />
              </a>
            </div>

            {/* Minimal workflow diagram */}
            <div
              aria-hidden="true"
              className="hidden shrink-0 items-center gap-2 sm:flex"
            >
              <div className="grid size-10 place-items-center rounded-sm border border-ink/25 bg-ink text-xs font-bold tracking-tight text-white shadow-2xs">
                ROX
              </div>
              <svg
                aria-hidden="true"
                viewBox="0 0 44 108"
                fill="none"
                className="h-[108px] w-11 text-ink/30"
              >
                <path
                  d="M2 54h14m0 0V18c0-3.3 2.7-6 6-6h18M16 54h24M16 54v36c0 3.3 2.7 6 6 6h18"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
                <path
                  d="m36 8 4 4-4 4m0 34 4 4-4 4m0 34 4 4-4 4"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <div className="flex flex-col gap-2">
                <ConnectorTile src="/sentry.svg" dark size="sm" />
                <ConnectorTile src="/grafana.svg" size="sm" />
                <ConnectorTile src="/vercel.png" dark size="sm" />
              </div>
            </div>
          </div>

          {/* Collection 2: Ship & notify */}
          <div className="flex items-center justify-between gap-6 overflow-hidden rounded-sm border border-ink/20 bg-linear-to-br from-paper via-white to-green-900/15 p-6">
            <div className="min-w-0">
              <h3 className="font-rox text-[17px] font-semibold leading-snug text-ink">
                Ship verified fixes to your team
              </h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">
                Open draft pull requests with sandbox proof, link Linear issues,
                and keep human merge control in Slack.
              </p>
              <a
                href="#all-connectors"
                className="focusable mt-4 inline-flex items-center gap-1.5 rounded text-[13px] font-semibold text-ink transition-colors hover:text-green-800"
              >
                View apps
                <ArrowRightIcon aria-hidden="true" className="size-3.5" />
              </a>
            </div>

            {/* Minimal preview card with floating tile */}
            <div
              aria-hidden="true"
              className="relative hidden shrink-0 pl-6 pt-3 sm:block"
            >
              <div className="absolute left-0 top-0 z-10 rounded-lg border border-ink/20 bg-white p-1 shadow-2xs">
                <ConnectorTile src="/slack.png" size="sm" />
              </div>
              <div className="w-52 rounded-xl border border-ink/20 bg-white p-3 pl-6 shadow-2xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold text-ink">
                    Fix ready · PR #42
                  </span>
                  <CheckCircle2Icon className="size-3.5 text-[#2f7d4f]" />
                </div>
                <div className="mt-2 space-y-1.5">
                  <div className="rounded border border-ink/15 bg-paper px-2 py-1 text-[10.5px] font-medium text-ink">
                    18 / 18 sandbox gates passed
                  </div>
                  <div className="rounded border border-green-800/25 bg-green-800/8 px-2 py-1 text-[10.5px] font-medium text-green-900">
                    Awaiting human merge
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <ul
          aria-label="Connectors"
          className="mt-3 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3"
        >
          {CONNECTORS.map((item) => {
            const isOn = Boolean(enabled[item.id]);
            return (
              <li
                key={item.id}
                className="flex flex-col justify-between rounded border border-ink/20 bg-white transition-colors hover:border-ink/35"
              >
                <div className="p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <ConnectorTile
                        src={item.src}
                        dark={item.dark}
                        fill={item.fill}
                      />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="font-rox text-[15px] font-semibold leading-tight text-ink">
                            {item.name}
                          </h4>
                          {item.recommended && (
                            <span className="inline-flex items-center rounded-full border border-green-800/25 bg-paper px-2 py-0.5 text-[11px] font-medium leading-none text-black">
                              Recommended
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-[11.5px] text-ink-muted">
                          {item.category}
                        </p>
                      </div>
                    </div>

                    {/* Minimal toggle switch */}
                    <button
                      type="button"
                      role="switch"
                      aria-checked={isOn}
                      aria-label={`Enable ${item.name}`}
                      onClick={() => toggle(item.id)}
                      className={`focusable relative h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors ${
                        isOn ? "bg-ink" : "bg-ink/18 hover:bg-ink/28"
                      }`}
                    >
                      <span
                        className={`block size-4 rounded-full bg-white shadow-2xs transition-transform ${
                          isOn ? "translate-x-4" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>

                  <p className="mt-3.5 line-clamp-2 text-[13px] leading-relaxed text-ink-soft">
                    {item.description}
                  </p>
                </div>

                <div className="flex items-center justify-between rounded-b-xl border-t border-ink/18 bg-paper/45 px-5 py-2.5">
                  <button
                    type="button"
                    onClick={() => toggle(item.id)}
                    className={`focusable inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium transition-colors ${
                      isOn
                        ? "border-green-800/30 bg-green-800/10 text-green-900 hover:bg-green-800/16"
                        : "border-ink/25 bg-white text-ink hover:bg-paper"
                    }`}
                  >
                    <ArrowLeftRightIcon
                      aria-hidden="true"
                      className="size-3.5 opacity-75"
                    />
                    {isOn ? "Connected" : "Connections"}
                  </button>

                  <button
                    type="button"
                    aria-label={`Configure ${item.name}`}
                    onClick={() => setInspecting(item)}
                    className="focusable grid size-7 place-items-center rounded-md text-ink/55 transition-colors hover:bg-ink/8 hover:text-ink"
                  >
                    <SettingsIcon aria-hidden="true" className="size-4" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Minimal demo configuration modal when clicking the gear button */}
      {inspecting && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4">
          <button
            type="button"
            aria-label="Close dialog"
            onClick={() => setInspecting(null)}
            className="absolute inset-0 bg-ink/35"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="connector-dialog-title"
            className="relative z-10 w-full max-w-md rounded-xl border border-ink/25 bg-white p-6 shadow-xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <ConnectorTile
                  src={inspecting.src}
                  dark={inspecting.dark}
                  fill={inspecting.fill}
                />
                <div>
                  <div className="flex items-center gap-2">
                    <h3
                      id="connector-dialog-title"
                      className="font-rox text-[17px] font-semibold text-ink"
                    >
                      {inspecting.name}
                    </h3>
                    {inspecting.recommended && (
                      <span className="rounded-full border border-green-800/25 bg-green-800/10 px-2 py-0.5 text-[11px] font-medium text-green-900">
                        Recommended
                      </span>
                    )}
                  </div>
                  <p className="text-[12px] text-ink-muted">
                    {inspecting.category} · Demo preview
                  </p>
                </div>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setInspecting(null)}
                className="focusable grid size-7 place-items-center rounded-md text-ink/60 hover:bg-ink/8 hover:text-ink"
              >
                <XIcon aria-hidden="true" className="size-4" />
              </button>
            </div>

            <p className="mt-4 text-[13px] leading-relaxed text-ink-soft">
              {inspecting.description}
            </p>

            <div className="mt-4 rounded-lg border border-ink/20 bg-paper p-3.5">
              <p className="text-[11.5px] font-semibold uppercase tracking-wider text-ink-muted">
                Capabilities in Rox
              </p>
              <ul className="mt-2 space-y-1.5 text-[13px] text-ink">
                {inspecting.scopes.map((scope) => (
                  <li key={scope} className="flex items-center gap-2">
                    <span className="size-1.5 rounded-full bg-[#2f7d4f]" />
                    {scope}
                  </li>
                ))}
              </ul>
            </div>

            <p className="mt-3 text-[12px] text-ink-muted">
              Live OAuth and webhook credentials are not required in this UI
              preview.
            </p>

            <div className="mt-5 flex items-center justify-end gap-2 border-t border-ink/20 pt-4">
              <button
                type="button"
                onClick={() => setInspecting(null)}
                className="btn btn-secondary"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => {
                  toggle(inspecting.id);
                  setInspecting(null);
                }}
                className="btn btn-primary"
              >
                {enabled[inspecting.id] ? "Disable in demo" : "Enable in demo"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
