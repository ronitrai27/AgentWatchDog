"use client";

import { AlertTriangleIcon, XIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useState, useTransition } from "react";
import { saveAgentConfig } from "@/app/(app)/home/actions";
import { WorkflowPanel } from "@/components/settings/workflow-panel";
import { Select } from "@/components/setup/select";
import {
  type AgentConfig,
  configProblem,
  MAX_INSTRUCTIONS,
  SCHEDULES,
  type Schedule,
  TONES,
  type Tone,
} from "@/lib/agent-config";

const PR_MERGE_ACTIONS = [
  { value: "open_pr", label: "Open PR", badge: "Recommended" },
  { value: "merge_pr", label: "Merge PR" },
] as const;

type PrMergeAction = (typeof PR_MERGE_ACTIONS)[number]["value"];

const TABS = [
  {
    id: "workspace",
    label: "Workspace",
    hint: "Where Rox works and where it runs code.",
  },
  {
    id: "agent",
    label: "Agent",
    hint: "How Rox talks, what it can spend and what it reports.",
  },
  {
    id: "workflow",
    label: "Workflow",
    hint: "Where Rox reports after a pipeline run and which events invoke it.",
  },
] as const;

type TabId = (typeof TABS)[number]["id"];

function Row({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  const Label = htmlFor ? "label" : "p";
  return (
    <div className="grid items-center gap-x-10 gap-y-3 border-b border-ink/20 py-6 sm:grid-cols-[minmax(0,1fr)_280px]">
      <div>
        <Label
          {...(htmlFor ? { htmlFor } : {})}
          className="block text-[13px] font-medium text-ink"
        >
          {label}
        </Label>
        <p className="mt-0.5 text-[13px] text-ink/60">{hint}</p>
      </div>
      {children}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h4 className="border-b border-ink/20 pt-10 pb-3 font-rox text-[15px] font-semibold text-ink">
        {title}
      </h4>
      {children}
    </section>
  );
}

function NumberField({
  id,
  before,
  after,
  value,
  onChange,
}: {
  id: string;
  before?: string;
  after?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="field flex h-9 items-center gap-1.5 px-3 text-[13px] focus-within:border-ink">
      {before && <span className="text-ink/50">{before}</span>}
      <input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 bg-transparent tabular-nums outline-none"
      />
      {after && <span className="text-ink/50">{after}</span>}
    </div>
  );
}

export function SettingsView({
  initial,
  spentTodayUsd,
  workspace,
  keys,
  triggers,
}: {
  /** Null when the saved config could not be read. */
  initial: AgentConfig | null;
  spentTodayUsd: number;
  workspace: ReactNode;
  keys: ReactNode;
  /** Saved invocation triggers; null when none were saved yet. */
  triggers: string[] | null;
}) {
  const asked = useSearchParams().get("tab");
  const tab = TABS.find((t) => t.id === asked) ?? TABS[0];

  const open = (id: TabId) =>
    window.history.replaceState(null, "", `/home/settings?tab=${id}`);

  return (
    <div className="-mx-4 -my-8 sm:-mx-6 sm:-my-12 flex min-h-[calc(100svh-3.5rem)] flex-col bg-white">
      <div className="border-b border-ink/20 bg-linear-to-r from-paper to-green-900/40 px-6 py-8 sm:px-12">
        <h2 className="font-rox text-[26px] font-semibold leading-tight tracking-tight text-ink">
          Settings
        </h2>
        <p className="mt-1.5 text-[14px] text-ink">
          Manage where Rox works and how it behaves.
        </p>
      </div>

      <div className="flex flex-1 flex-col md:flex-row">
        <nav
          aria-label="Settings"
          className="flex shrink-0 overflow-x-auto border-b border-ink/20 px-4 py-2 md:w-56 md:flex-col md:overflow-visible md:border-r md:border-b-0 md:py-8 md:pr-0 md:pl-12"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-current={t.id === tab.id ? "page" : undefined}
              onClick={() => open(t.id)}
              className={`focusable shrink-0 border-transparent px-3 py-2 text-left text-[13px] md:-mr-px md:border-r-2 md:px-0 ${
                t.id === tab.id
                  ? "font-medium text-ink md:border-ink"
                  : "text-ink/60 hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1">
          <div className="border-b border-ink/20 px-6 py-7 sm:px-12">
            <h3 className="font-rox text-[18px] font-semibold text-ink">
              {tab.label}
            </h3>
            <p className="mt-1 text-[13px] text-ink/60">{tab.hint}</p>
          </div>
          <div className="max-w-[760px] px-6 pb-12 sm:px-12">
            <div hidden={tab.id !== "workspace"}>
              {workspace}
              <Group title="Environment variables">{keys}</Group>
            </div>
            {tab.id === "agent" && !initial && (
              <p className="py-6 text-[13px] text-destructive">
                These settings could not be loaded. Run `pnpm db:migrate`, then
                reload this page.
              </p>
            )}
            {initial && (
              <ConfigForm
                tab={tab.id}
                initial={initial}
                spentTodayUsd={spentTodayUsd}
              />
            )}
            <WorkflowPanel visible={tab.id === "workflow"} saved={triggers} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Stays mounted on every tab, so changes are kept while moving between them. */
function ConfigForm({
  tab,
  initial,
  spentTodayUsd,
}: {
  tab: TabId;
  initial: AgentConfig;
  spentTodayUsd: number;
}) {
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [saved, setSaved] = useState(initial);
  const [config, setConfig] = useState(initial);
  // Kept as typed, so a half-written number is not rewritten under the cursor.
  const [day, setDay] = useState(String(initial.dayBudgetUsd));
  const [minutes, setMinutes] = useState(String(initial.maxMinutes));
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [saving, startSaving] = useTransition();
  // Saved the moment it is chosen (the pipeline reads it when a fix is verified), on top of the
  // last saved config, so other unsaved edits stay unsaved.
  const prAction = config.prAction;
  const setPrAction = (a: PrMergeAction) => {
    change({ prAction: a });
    startSaving(async () => {
      const result = await saveAgentConfig({ ...saved, prAction: a });
      if (result.ok) setSaved((s) => ({ ...s, prAction: a }));
      else change({ prAction: saved.prAction });
      setMessage(
        result.ok
          ? {
              ok: true,
              text: a === "merge_pr" ? "Saved: Merge PR" : "Saved: Open PR",
            }
          : { ok: false, text: result.error },
      );
    });
  };

  useEffect(() => {
    if (!confirmMerge) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmMerge(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmMerge]);

  const number = (text: string) => (text.trim() ? Number(text) : Number.NaN);
  const next: AgentConfig = {
    ...config,
    dayBudgetUsd: number(day),
    maxMinutes: number(minutes),
  };
  const dirty = (Object.keys(saved) as (keyof AgentConfig)[]).some(
    (key) => !Object.is(next[key], saved[key]),
  );
  const change = (part: Partial<AgentConfig>) => {
    setMessage(null);
    setConfig((c) => ({ ...c, ...part }));
  };

  function save() {
    const problem = configProblem(next);
    if (problem) return setMessage({ ok: false, text: problem });
    startSaving(async () => {
      const result = await saveAgentConfig(next);
      if (result.ok) setSaved(next);
      setMessage(
        result.ok
          ? { ok: true, text: "Saved" }
          : { ok: false, text: result.error },
      );
    });
  }

  if (tab !== "agent") return null;
  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Row
          label="PR merge action"
          hint={
            prAction === "open_pr"
              ? "Open a pull request so humans can review and merge."
              : "Automatically merge verified pull requests without human review."
          }
        >
          <Select
            label="PR merge action"
            value={prAction}
            options={PR_MERGE_ACTIONS.map((a) => ({ ...a }))}
            onChange={(value) => {
              const chosen = value as PrMergeAction;
              if (chosen === prAction) return;
              if (chosen === "merge_pr") {
                setConfirmMerge(true);
                return;
              }
              setPrAction("open_pr");
            }}
            placeholder="Choose a PR action"
          />
        </Row>
        <Row label="Tone" hint="How Rox writes to you.">
          <Select
            label="Tone"
            value={config.tone}
            options={TONES.map((t) => ({ value: t.id, label: t.label }))}
            onChange={(tone) => change({ tone: tone as Tone })}
            placeholder="Choose a tone"
          />
        </Row>
        <div className="border-b border-ink/20 py-6">
          <div className="flex items-baseline justify-between gap-4">
            <label
              htmlFor="agent-instructions"
              className="text-[13px] font-medium text-ink"
            >
              Instructions
            </label>
            <span className="text-xs tabular-nums text-ink/50">
              {config.instructions.length}/{MAX_INSTRUCTIONS}
            </span>
          </div>
          <p className="mt-0.5 text-[13px] text-ink/60">
            Extra details Rox should follow. No keys or passwords.
          </p>
          <textarea
            id="agent-instructions"
            rows={6}
            maxLength={MAX_INSTRUCTIONS}
            value={config.instructions}
            onChange={(e) => change({ instructions: e.target.value })}
            placeholder="The payments folder is critical. Always tell me the risk first."
            className="field mt-3 block w-full resize-none px-3 py-2.5 text-[13px] leading-relaxed"
          />
        </div>

        <Group title="Budget">
          <Row
            htmlFor="day-budget"
            label="Max per day"
            hint={`About $${spentTodayUsd.toFixed(2)} used today.`}
          >
            <NumberField
              id="day-budget"
              before="$"
              after="USD"
              value={day}
              onChange={(v) => {
                setMessage(null);
                setDay(v);
              }}
            />
          </Row>
          <Row
            htmlFor="max-minutes"
            label="Max time per run"
            hint="Ends a run that is stuck."
          >
            <NumberField
              id="max-minutes"
              after="minutes"
              value={minutes}
              onChange={(v) => {
                setMessage(null);
                setMinutes(v);
              }}
            />
          </Row>
        </Group>

        <Group title="Reports">
          <Row label="Scheduled report" hint="Sent at 12:00 AM.">
            <Select
              label="Scheduled report"
              value={config.schedule}
              options={SCHEDULES.map((s) => ({ value: s.id, label: s.label }))}
              onChange={(schedule) =>
                change({ schedule: schedule as Schedule })
              }
              placeholder="Choose a schedule"
            />
          </Row>
        </Group>

        <div className="flex items-center justify-end gap-4 pt-6">
          <p
            aria-live="polite"
            className={`text-[13px] ${message?.ok === false ? "text-destructive" : "text-ink/60"}`}
          >
            {message?.text}
          </p>
          <button
            type="submit"
            disabled={saving || !dirty}
            className="btn btn-primary"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>

      {confirmMerge && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4">
          <button
            type="button"
            aria-label="Close dialog"
            onClick={() => setConfirmMerge(false)}
            className="absolute inset-0 bg-ink/35"
          />
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="merge-pr-dialog-title"
            aria-describedby="merge-pr-dialog-desc"
            className="relative z-10 w-full max-w-md rounded-xl border border-ink/25 bg-white p-6 shadow-xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-destructive/30 bg-destructive/10 text-destructive">
                  <AlertTriangleIcon aria-hidden="true" className="size-4" />
                </span>
                <div>
                  <h3
                    id="merge-pr-dialog-title"
                    className="font-rox text-[17px] font-semibold text-ink"
                  >
                    Switch to Merge PR?
                  </h3>
                  <p className="text-[12px] text-ink-muted">
                    Open PR is recommended
                  </p>
                </div>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setConfirmMerge(false)}
                className="focusable grid size-7 place-items-center rounded-md text-ink/60 hover:bg-ink/8 hover:text-ink"
              >
                <XIcon aria-hidden="true" className="size-4" />
              </button>
            </div>

            <p
              id="merge-pr-dialog-desc"
              className="mt-4 text-[13px] leading-relaxed text-ink-soft"
            >
              Are you sure you want to let Rox merge pull requests
              automatically? With <strong>Open PR</strong> (Recommended), humans
              always review and merge every verified fix.
            </p>

            <div className="mt-4 rounded-lg border border-ink/20 bg-paper p-3.5 text-[12.5px] leading-relaxed text-ink">
              Switching to <strong>Merge PR</strong> skips manual review once
              all verification gates pass.
            </div>

            <div className="mt-5 flex items-center justify-end gap-2 border-t border-ink/20 pt-4">
              <button
                type="button"
                onClick={() => setConfirmMerge(false)}
                className="btn btn-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setPrAction("merge_pr");
                  setConfirmMerge(false);
                }}
                className="btn btn-danger"
              >
                Yes, switch to Merge PR
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
