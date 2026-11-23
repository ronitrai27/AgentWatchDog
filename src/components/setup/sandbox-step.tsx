"use client";

import { useState, useTransition } from "react";
import { checkDocker } from "@/app/(app)/home/actions";
import { Brand, type BrandId } from "./brand";
import { StepError } from "./step-error";

const SANDBOXES: {
  id: BrandId;
  name: string;
  body: string;
  ready: boolean;
}[] = [
  {
    id: "docker",
    name: "Docker",
    body: "Runs on this machine. No account or key.",
    ready: true,
  },
  {
    id: "daytona",
    name: "Daytona",
    body: "Cloud sandboxes with your own key.",
    ready: false,
  },
  {
    id: "e2b",
    name: "E2B",
    body: "Cloud sandboxes with your own key.",
    ready: false,
  },
];

export function SandboxStep({ onSaved }: { onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [checking, startChecking] = useTransition();

  function check() {
    setError(null);
    startChecking(async () => {
      const result = await checkDocker();
      if (!result.ok) return setError(result.error);
      setVersion(result.version);
      onSaved();
    });
  }

  return (
    <>
      <p className="text-[13px] leading-relaxed text-ink-soft">
        Rox reproduces bugs and tests fixes here, isolated from your files and
        your production.
      </p>

      <fieldset className="mt-3 divide-y divide-ink/10 rounded-lg border border-ink/15 bg-white">
        <legend className="sr-only">Sandbox</legend>
        {SANDBOXES.map((sandbox) => (
          <label
            key={sandbox.id}
            className={`flex items-center gap-3 px-3.5 py-3 ${sandbox.ready ? "" : "cursor-not-allowed"}`}
          >
            <Brand id={sandbox.id} size={28} />
            <span className="min-w-0 flex-1 text-[13px]">
              <span
                className={`block font-medium ${sandbox.ready ? "text-ink" : "text-muted"}`}
              >
                {sandbox.name}
              </span>
              <span className="block text-muted">{sandbox.body}</span>
            </span>
            {!sandbox.ready && (
              <span className="text-[13px] text-muted">Soon</span>
            )}
            <input
              type="radio"
              name="sandbox"
              defaultChecked={sandbox.ready}
              disabled={!sandbox.ready}
              className="size-4 accent-[#2b3a30]"
            />
          </label>
        ))}
      </fieldset>

      <div className="flex items-center gap-3 pt-3">
        <button
          type="button"
          onClick={check}
          disabled={checking}
          className="btn btn-primary"
        >
          {checking ? "Checking Docker" : "Check Docker"}
        </button>
        {version && (
          <p className="text-[13px] text-ink-soft" aria-live="polite">
            Docker {version} is running.
          </p>
        )}
      </div>
      <StepError message={error} />
    </>
  );
}
