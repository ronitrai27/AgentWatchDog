"use client";

import { Settings2Icon } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { Composer } from "@/components/chat/composer";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Insights } from "@/lib/insights";
import type { SetupState } from "@/lib/models";
import { Connectors } from "./connectors";
import {
  AlertsVector,
  CommitsVector,
  DeploysVector,
  ErrorsVector,
  IdleVector,
  PullsVector,
  SecurityVector,
} from "./vectors";

const PAGE = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
};
const RISE = {
  hidden: { opacity: 0, y: 14 },
  shown: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: [0.2, 0.8, 0.2, 1] as const },
  },
};

const LOADING = ["Loading recent incidents...", "Checking environments..."];

/** One line about the latest event. Clicking it puts it in the message box. */
function Brief({ onPick }: { onPick: (text: string) => void }) {
  const [line, setLine] = useState<string | null>(null);
  const [step, setStep] = useState(0);

  useEffect(() => {
    const stop = new AbortController();
    fetch("/api/brief", { signal: stop.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((body: { line: string }) => setLine(body.line))
      .catch(() => !stop.signal.aborted && setLine(""));
    return () => stop.abort();
  }, []);

  useEffect(() => {
    if (line !== null) return;
    const timer = setInterval(() => setStep((s) => s + 1), 1400);
    return () => clearInterval(timer);
  }, [line]);

  const text =
    line === null
      ? LOADING[step % LOADING.length]
      : line || "No recent events to report.";
  return (
    <motion.div
      key={text}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      aria-live="polite"
      className="mt-2 h-7 max-w-full"
    >
      {line ? (
        <button
          type="button"
          title={line}
          onClick={() => onPick(line)}
          className="focusable block max-w-full truncate rounded text-[15px] text-ink-soft underline-offset-4 hover:text-ink hover:underline"
        >
          {text}
        </button>
      ) : (
        <p className="truncate text-[15px] text-ink-soft">{text}</p>
      )}
    </motion.div>
  );
}

function Box({
  title,
  text,
  demo = false,
  children,
}: {
  title: string;
  text: string;
  demo?: boolean;
  children: ReactNode;
}) {
  return (
    <motion.li
      variants={RISE}
      className="flex min-w-0 list-none items-center gap-3"
    >
      {children}
      <div className="min-w-0">
        <h3 className="flex items-center gap-1.5 font-rox text-[13px] font-medium text-ink">
          {title}
          {demo && (
            <span className="rounded-full bg-ink/7 px-1.5 text-[10px] leading-4 text-ink">
              Demo
            </span>
          )}
        </h3>
        <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-ink-soft">
          {text}
        </p>
      </div>
    </motion.li>
  );
}

/** Why a repository box has nothing to show. */
function reason(insights: Insights | null, failed: boolean): string {
  if (failed) return "Could not load this. Reload the page to try again.";
  if (!insights) return "Reading from GitHub…";
  switch (insights.github) {
    case "demo":
      return "The bundled demo app has no GitHub data.";
    case "expired":
      return "GitHub access expired. Reconnect it under Connectors.";
    case "none":
      return "No GitHub repository is linked yet.";
    case "unreachable":
      return "GitHub did not answer. Reload to try again.";
    default:
      return "GitHub did not return this.";
  }
}

const plus = (capped: boolean) => (capped ? "+" : "");

export function EmptyHome({
  setup,
  name,
  busy,
  problem,
  onSend,
}: {
  setup: SetupState;
  name: string;
  busy: boolean;
  problem: string | null;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [focus, setFocus] = useState(1);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const stop = new AbortController();
    fetch("/api/insights", { signal: stop.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then(setInsights)
      .catch(() => !stop.signal.aborted && setFailed(true));
    return () => stop.abort();
  }, []);

  const why = reason(insights, failed);
  const idle = <IdleVector busy={!insights && !failed} />;
  const { activity, pulls, security } = insights ?? {};
  const passed = security?.filter((c) => c.ok).length ?? 0;
  const missing = security?.filter((c) => !c.ok).map((c) => c.label) ?? [];
  const repo = setup.repo?.split("/").pop() ?? "none";

  return (
    <TooltipProvider>
      <motion.section
        aria-label="Home"
        variants={PAGE}
        initial="hidden"
        animate="shown"
        className="-mt-8 sm:-mt-12 -mb-24 sm:-mb-28 flex h-[calc(100svh-3.5rem)] min-h-[34rem] flex-col pb-5"
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-width:none]">
          <motion.div variants={PAGE} className="my-auto py-8">
            <div className="flex flex-col items-center text-center">
              <motion.h2
                variants={RISE}
                className="font-rox text-[36px] font-semibold leading-tight tracking-tight text-ink"
              >
                Welcome, {name}!
              </motion.h2>
              <motion.div variants={RISE} className="max-w-full">
                <Brief
                  onPick={(line) => {
                    setDraft(line);
                    setFocus((n) => n + 1);
                  }}
                />
              </motion.div>
            </div>

            <motion.div
              variants={RISE}
              className="mx-auto mt-12 flex max-w-[760px] items-baseline justify-between gap-6"
            >
              <h3 className="font-rox text-[14px] font-medium text-ink">
                Quick Insights
              </h3>
              <p
                className="max-w-[45%] truncate text-[12px] text-ink-soft"
                title={setup.repo ?? undefined}
              >
                For Repo - {repo}
              </p>
            </motion.div>

            <motion.ul
              variants={PAGE}
              aria-label="Quick Insights"
              className="mx-auto mt-4 grid max-w-[760px] gap-x-6 gap-y-5 p-0 sm:grid-cols-2 lg:grid-cols-3"
            >
              <Box
                title="Commits"
                text={
                  activity
                    ? `${activity.total}${plus(activity.capped)} in the last 14 days`
                    : why
                }
              >
                {activity ? <CommitsVector perDay={activity.perDay} /> : idle}
              </Box>
              <Box
                title="Security basics"
                text={
                  security
                    ? missing.length
                      ? `${passed} of ${security.length} in place. Missing ${missing[0]}`
                      : "All in place"
                    : why
                }
              >
                {security ? (
                  <SecurityVector oks={security.map((c) => c.ok)} />
                ) : (
                  idle
                )}
              </Box>
              <Box
                title="Pull requests"
                text={
                  pulls
                    ? `${pulls.total}${plus(pulls.capped)} total: ${pulls.open} open, ${pulls.merged} merged, ${pulls.closed} closed`
                    : why
                }
              >
                {pulls ? (
                  <PullsVector
                    open={pulls.open}
                    merged={pulls.merged}
                    closed={pulls.closed}
                  />
                ) : (
                  idle
                )}
              </Box>
              <Box demo title="Errors" text="Sample. Connect Sentry">
                <ErrorsVector />
              </Box>
              <Box demo title="Deploys" text="Sample. Connect Vercel">
                <DeploysVector />
              </Box>
              <Box demo title="Alerts" text="Sample. Connect Slack">
                <AlertsVector />
              </Box>
            </motion.ul>
          </motion.div>
        </div>

        <motion.div
          variants={RISE}
          className="mx-auto w-full max-w-[760px] shrink-0 pt-3"
        >
          {problem && (
            <p role="alert" className="mb-2 px-2 text-[13px] text-destructive">
              {problem}
            </p>
          )}
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={() => onSend(draft.trim())}
            onStop={() => {}}
            running={false}
            disabled={busy}
            placeholder="Ask Rox anything about your project"
            modelId={setup.orchestrator}
            helperId={setup.subagent}
            focusSignal={focus}
            leading={
              <>
                <Connectors github={insights?.github} />
                <Link
                  href="/home/settings?tab=agent"
                  className="focusable flex h-8 items-center gap-2 rounded-full border border-ink/15 bg-white px-3 text-[13px] font-medium text-ink hover:border-ink/35"
                >
                  Config
                  <Settings2Icon aria-hidden="true" className="size-4" />
                </Link>
              </>
            }
          />
        </motion.div>
      </motion.section>
    </TooltipProvider>
  );
}
