"use client";

import { useSearchParams } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import { saveAgentConfig } from "@/app/(app)/home/actions";
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
    <div className="grid items-center gap-x-10 gap-y-3 border-b border-ink/10 py-6 sm:grid-cols-[minmax(0,1fr)_280px]">
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
      <h4 className="border-b border-ink/10 pt-10 pb-3 font-rox text-[15px] font-semibold text-ink">
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
}: {
  /** Null when the saved config could not be read. */
  initial: AgentConfig | null;
  spentTodayUsd: number;
  workspace: ReactNode;
  keys: ReactNode;
}) {
  const asked = useSearchParams().get("tab");
  const tab = TABS.find((t) => t.id === asked) ?? TABS[0];

  const open = (id: TabId) =>
    window.history.replaceState(null, "", `/home/settings?tab=${id}`);

  return (
    <div className="-mx-4 -my-8 sm:-mx-6 sm:-my-12 flex min-h-[calc(100svh-3.5rem)] flex-col bg-white">
      <div className="border-b border-ink/10 bg-paper px-6 py-8 sm:px-12">
        <h2 className="font-rox text-[26px] font-semibold leading-tight tracking-tight text-ink">
          Settings
        </h2>
        <p className="mt-1.5 text-[14px] text-ink/60">
          Manage where Rox works and how it behaves.
        </p>
      </div>

      <div className="flex flex-1 flex-col md:flex-row">
        <nav
          aria-label="Settings"
          className="flex shrink-0 overflow-x-auto border-b border-ink/10 px-4 py-2 md:w-56 md:flex-col md:overflow-visible md:border-r md:border-b-0 md:py-8 md:pr-0 md:pl-12"
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
          <div className="border-b border-ink/10 px-6 py-7 sm:px-12">
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
  const [saved, setSaved] = useState(initial);
  const [config, setConfig] = useState(initial);
  // Kept as typed, so a half-written number is not rewritten under the cursor.
  const [day, setDay] = useState(String(initial.dayBudgetUsd));
  const [minutes, setMinutes] = useState(String(initial.maxMinutes));
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [saving, startSaving] = useTransition();

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
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Row label="Tone" hint="How Rox writes to you.">
        <Select
          label="Tone"
          value={config.tone}
          options={TONES.map((t) => ({ value: t.id, label: t.label }))}
          onChange={(tone) => change({ tone: tone as Tone })}
          placeholder="Choose a tone"
        />
      </Row>
      <div className="border-b border-ink/10 py-6">
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
            onChange={(schedule) => change({ schedule: schedule as Schedule })}
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
  );
}
