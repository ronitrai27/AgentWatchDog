"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { findModel, type SetupState, setupProgress } from "@/lib/models";
import { Brand, type BrandId } from "./brand";
import { ModelsStep } from "./models-step";
import { RepoStep } from "./repo-step";
import { SandboxStep } from "./sandbox-step";

type StepId = "signIn" | "repo" | "models" | "sandbox";
const ORDER: StepId[] = ["signIn", "repo", "models", "sandbox"];
/** Lets the check and the rail finish drawing before the next step opens. */
const ADVANCE_DELAY = 520;

function Checkpoint({ done, current }: { done: boolean; current: boolean }) {
  return (
    <span
      className={`relative z-10 grid size-5 place-items-center rounded-full border-[1.5px] transition-colors duration-300 ${
        done
          ? "border-[#2f7d4f] bg-[#2f7d4f]"
          : current
            ? "border-ink bg-paper"
            : "border-ink/25 bg-paper"
      }`}
    >
      <svg
        viewBox="0 0 16 16"
        className="size-3 text-white"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path
          className="setup-check"
          data-done={done}
          d="M3.5 8.5 6.5 11.5 12.5 4.5"
        />
      </svg>
    </span>
  );
}

function Step({
  icon,
  title,
  summary,
  done,
  open,
  locked,
  last = false,
  onToggle,
  children,
}: {
  icon?: BrandId;
  title: string;
  /** What was chosen, shown while the step is closed. */
  summary: ReactNode;
  done: boolean;
  open: boolean;
  locked: boolean;
  last?: boolean;
  /** Omitted for a step that has nothing to change. */
  onToggle?: () => void;
  children?: ReactNode;
}) {
  const canOpen = onToggle && !locked;
  const heading = (
    <>
      {icon && <Brand id={icon} size={28} />}
      <span
        className={`text-[15px] font-medium ${locked ? "text-muted" : "text-ink"}`}
      >
        {title}
      </span>
      <span
        className={`ml-auto flex min-w-0 items-center gap-2 text-[13px] text-muted transition-opacity duration-200 ${open ? "opacity-0" : ""}`}
      >
        {done && summary}
      </span>
      {canOpen && done && (
        <span className="shrink-0 text-[13px] text-ink-soft underline decoration-ink/25 underline-offset-[3px] group-hover:decoration-ink">
          {open ? "Close" : "Change"}
        </span>
      )}
    </>
  );

  return (
    <li className="relative grid grid-cols-[20px_minmax(0,1fr)] gap-x-4">
      {!last && (
        <span className="absolute -bottom-3.5 left-[9.25px] top-3.5 w-[1.5px] bg-ink/15">
          <span
            className="setup-rail absolute inset-0 bg-[#2f7d4f]"
            data-done={done}
          />
        </span>
      )}
      <span className="pt-1">
        <Checkpoint done={done} current={open} />
      </span>
      <div className={last ? "" : "pb-9"}>
        {canOpen ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="focusable group flex min-h-[28px] w-full items-center gap-3 rounded text-left"
          >
            {heading}
          </button>
        ) : (
          <div className="flex min-h-[28px] items-center gap-3">{heading}</div>
        )}
        {children && (
          <div className="reveal" data-open={open} inert={!open}>
            <div>
              <div className="pb-1 pt-3">{children}</div>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

function Progress({ done }: { done: boolean[] }) {
  const count = done.filter(Boolean).length;
  return (
    <div className="mt-6 flex items-center gap-4">
      <div
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={0}
        aria-valuemax={done.length}
        aria-valuenow={count}
        className="grid flex-1 grid-cols-4 gap-1"
      >
        {done.map((isDone, index) => (
          <span
            key={ORDER[index]}
            className="h-1 overflow-hidden rounded-full bg-ink/12"
          >
            <span
              className="setup-fill block h-full rounded-full bg-[#2f7d4f]"
              data-done={isDone}
            />
          </span>
        ))}
      </div>
      <p className="text-[13px] tabular-nums text-ink-soft" aria-live="polite">
        {count} of {done.length} complete
      </p>
    </div>
  );
}

function ModelsSummary({ state }: { state: SetupState }) {
  const model = findModel(state.orchestrator);
  if (!model) return null;
  const sub = findModel(state.subagent);
  return (
    <>
      <Brand id={model.provider} size={18} />
      <span className="truncate">
        {model.label}
        {sub && sub.id !== model.id && ` with ${sub.label}`}
      </span>
    </>
  );
}

export function SetupGuide({
  initial,
  isJudge,
  login,
}: {
  initial: SetupState;
  isJudge: boolean;
  login: string;
}) {
  const [state, setState] = useState(initial);
  const progress = setupProgress(state, isJudge);
  const firstOpen = (from: ReturnType<typeof setupProgress>) =>
    ORDER.find((id) => !from[id]) ?? null;

  const [open, setOpen] = useState<StepId | null>(() => firstOpen(progress));
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  /** Saves the change, lets the checkpoint draw, then opens what is next. */
  function complete(change: Partial<SetupState>) {
    const next = { ...state, ...change };
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setOpen(firstOpen(setupProgress(next, isJudge))),
      ADVANCE_DELAY,
    );
  }

  const step = (id: StepId) => {
    const index = ORDER.indexOf(id);
    const locked =
      !progress[id] && ORDER.slice(0, index).some((other) => !progress[other]);
    return {
      done: progress[id],
      open: open === id,
      locked,
      onToggle: () => {
        clearTimeout(timer.current);
        setOpen(open === id ? firstOpen(progress) : id);
      },
    };
  };

  const finished = ORDER.every((id) => progress[id]);

  return (
    <section aria-labelledby="setup-title">
      <h2
        id="setup-title"
        className="font-serif text-[28px] font-semibold leading-tight tracking-tight text-ink"
      >
        {finished ? "Rox is set up" : "Set up Rox"}
      </h2>
      <p className="mt-2 text-[15px] leading-relaxed text-ink-soft">
        {finished
          ? `Everything Rox needs for ${state.repo} is in place. The agent service is not running yet, so nothing is being watched.`
          : isJudge
            ? "Four short steps on the bundled demo app. No accounts and no keys."
            : "Four steps, then Rox has what it needs to work on your repository."}
      </p>

      <Progress done={ORDER.map((id) => progress[id])} />

      <ol className="mt-10">
        <Step
          {...step("signIn")}
          onToggle={undefined}
          icon={isJudge ? undefined : "github"}
          title={isJudge ? "Sign in" : "Sign in with GitHub"}
          summary={
            isJudge ? (
              "Demo user, no GitHub needed"
            ) : (
              <span className="truncate text-ink">{login}</span>
            )
          }
        />
        <Step
          {...step("repo")}
          title="Choose a repository"
          summary={
            <>
              <Brand id="github" size={22} />
              <span className="truncate">{state.repo}</span>
            </>
          }
        >
          <RepoStep
            current={state.repo}
            isJudge={isJudge}
            onSaved={(repo) => complete({ repo })}
          />
        </Step>
        <Step
          {...step("models")}
          title="Choose models"
          summary={<ModelsSummary state={state} />}
        >
          <ModelsStep
            state={state}
            isJudge={isJudge}
            onKeys={(keys) => setState((now) => ({ ...now, keys }))}
            onSaved={(choice) => complete(choice)}
          />
        </Step>
        <Step
          {...step("sandbox")}
          last
          title="Choose a sandbox"
          summary={
            <>
              <Brand id="docker" size={20} />
              Docker
            </>
          }
        >
          <SandboxStep onSaved={() => complete({ sandbox: "docker" })} />
        </Step>
      </ol>
    </section>
  );
}
