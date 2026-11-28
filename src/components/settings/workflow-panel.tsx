"use client";

import { CheckIcon } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { saveTriggerSelection } from "@/app/(app)/home/actions";
import { Select } from "@/components/setup/select";
import { TRIGGER_PROVIDERS, type TriggerProvider } from "@/lib/triggers";

const REPORT_CHANNELS = [
  {
    value: "slack",
    label: "Slack",
    badge: "Default",
    src: "/slack.png",
    fill: false,
  },
  {
    value: "telegram",
    label: "Telegram",
    src: "/telegram.jpeg",
    fill: true,
  },
] as const;

type ReportChannel = (typeof REPORT_CHANNELS)[number]["value"];

function ProviderBadge({
  src,
  dark,
  fill,
}: {
  src: string;
  dark?: boolean;
  fill?: boolean;
}) {
  return (
    <span
      className={`grid size-7 shrink-0 place-items-center overflow-hidden rounded ${
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
        width={32}
        height={32}
        unoptimized
        className={
          fill ? "size-full object-cover" : "size-[58%] object-contain"
        }
      />
    </span>
  );
}

export function WorkflowPanel({
  visible,
  saved,
}: {
  visible: boolean;
  /** The triggers saved for this user; null when none were saved yet (defaults apply). */
  saved: string[] | null;
}) {
  const [channel, setChannel] = useState<ReportChannel>("slack");
  const [selected, setSelected] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const provider of TRIGGER_PROVIDERS) {
      for (const trigger of provider.triggers) {
        initial[trigger.id] = saved
          ? saved.includes(trigger.id)
          : Boolean(trigger.defaultEnabled);
      }
    }
    return initial;
  });
  const [saveError, setSaveError] = useState<string | null>(null);

  /** Every change is saved at once: the webhook routes read it to decide whether Rox wakes. */
  const apply = (next: Record<string, boolean>) => {
    setSelected(next);
    setSaveError(null);
    void saveTriggerSelection(Object.keys(next).filter((id) => next[id])).then(
      (r) => {
        if (!r.ok) setSaveError(r.error);
      },
    );
  };

  if (!visible) return null;

  const toggle = (id: string) => apply({ ...selected, [id]: !selected[id] });

  const toggleProvider = (provider: TriggerProvider) => {
    const allOn = provider.triggers.every((t) => selected[t.id]);
    const next = { ...selected };
    for (const t of provider.triggers) next[t.id] = !allOn;
    apply(next);
  };

  const totalEnabled = Object.values(selected).filter(Boolean).length;

  return (
    <div>
      <div className="grid items-center gap-x-10 gap-y-3 border-b border-ink/20 py-6 sm:grid-cols-[minmax(0,1fr)_280px]">
        <div>
          <p className="block text-[13px] font-medium text-ink">
            Pipeline report channel
          </p>
          <p className="mt-0.5 text-[13px] text-ink/60">
            Where Rox reports results automatically after a pipeline run.
          </p>
        </div>
        <Select
          label="Pipeline report channel"
          value={channel}
          options={REPORT_CHANNELS.map((c) => ({
            value: c.value,
            label: c.label,
            ...("badge" in c ? { badge: c.badge } : {}),
            icon: (
              <Image
                src={c.src}
                alt=""
                width={18}
                height={18}
                unoptimized
                className={
                  c.fill
                    ? "size-4 shrink-0 rounded-full object-cover"
                    : "size-4 shrink-0 object-contain"
                }
              />
            ),
          }))}
          onChange={(v) => setChannel(v as ReportChannel)}
          placeholder="Choose a channel"
        />
      </div>

      <section className="pt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2 pb-4">
          <div>
            <h4 className="font-rox text-[15px] font-semibold text-ink">
              Invocation triggers
            </h4>
            <p className="mt-0.5 text-[13px] text-ink/60">
              Choose which events wake Rox to investigate and fix issues.
            </p>
            {saveError && (
              <p className="mt-1 text-[13px] text-red-700">{saveError}</p>
            )}
          </div>
          <span className="rounded-full border border-ink/20 bg-paper px-2.5 py-0.5 text-[12px] font-medium tabular-nums text-ink">
            {totalEnabled} active
          </span>
        </div>

        <div className="space-y-4">
          {TRIGGER_PROVIDERS.map((provider) => {
            const activeCount = provider.triggers.filter(
              (t) => selected[t.id],
            ).length;
            const allOn = activeCount === provider.triggers.length;

            return (
              <div
                key={provider.id}
                className="overflow-hidden rounded-lg border border-ink/20 bg-white"
              >
                <div className="flex items-center justify-between gap-3 border-b border-ink/15 bg-paper/55 px-4 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <ProviderBadge
                      src={provider.src}
                      dark={provider.dark}
                      fill={provider.fill}
                    />
                    <span className="font-rox text-[14px] font-semibold text-ink">
                      {provider.name}
                    </span>
                    <span className="text-[12px] tabular-nums text-ink/55">
                      {activeCount}/{provider.triggers.length}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleProvider(provider)}
                    className="focusable rounded px-2 py-1 text-[12px] font-medium text-ink/70 transition-colors hover:bg-ink/6 hover:text-ink"
                  >
                    {allOn ? "Clear all" : "Select all"}
                  </button>
                </div>

                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b border-ink/12 text-[11px] font-semibold uppercase tracking-wider text-ink/50">
                      <th className="w-10 py-2 pl-4 pr-2 font-semibold">
                        <span className="sr-only">Enabled</span>
                      </th>
                      <th className="py-2 pr-4 font-semibold">Trigger</th>
                      <th className="hidden py-2 pr-4 font-semibold sm:table-cell">
                        Behavior
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink/12">
                    {provider.triggers.map((trigger) => {
                      const checked = Boolean(selected[trigger.id]);
                      return (
                        <tr
                          key={trigger.id}
                          onClick={() => toggle(trigger.id)}
                          className={`cursor-pointer transition-colors hover:bg-paper/45 ${
                            checked ? "bg-green-800/[0.03]" : ""
                          }`}
                        >
                          <td className="py-2.5 pl-4 pr-2 align-middle">
                            <label
                              className="relative inline-flex cursor-pointer items-center"
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => e.stopPropagation()}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggle(trigger.id)}
                                aria-label={`${provider.name}: ${trigger.label}`}
                                className="peer sr-only"
                              />
                              <span
                                aria-hidden="true"
                                className={`grid size-4 place-items-center rounded-[4px] border transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink ${
                                  checked
                                    ? "border-[#246440] bg-[#2f7d4f] text-white"
                                    : "border-ink/35 bg-white text-transparent hover:border-ink/60"
                                }`}
                              >
                                <CheckIcon className="size-3 stroke-[2.75]" />
                              </span>
                            </label>
                          </td>
                          <td className="py-2.5 pr-4 text-[13px] font-medium text-ink">
                            {trigger.label}
                          </td>
                          <td className="hidden py-2.5 pr-4 text-[12.5px] text-ink/60 sm:table-cell">
                            {trigger.detail}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
