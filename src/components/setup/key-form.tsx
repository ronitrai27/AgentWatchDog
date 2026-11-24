"use client";

import { type FormEvent, useState, useTransition } from "react";
import { saveProviderKey } from "@/app/(app)/home/actions";
import { PROVIDERS, type Provider, type SavedKey } from "@/lib/models";
import { StepError } from "./step-error";

/** Verifies a key with its provider and saves it. Slides open and closed. */
export function KeyForm({
  id,
  provider,
  open,
  onSaved,
  onCancel,
}: {
  /** Id of the input, for the caller's label. */
  id: string;
  provider: Provider;
  open: boolean;
  onSaved: (key: SavedKey) => void;
  /** Omitted when a key is required. */
  onCancel?: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, startChecking] = useTransition();

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    startChecking(async () => {
      const result = await saveProviderKey(provider, value);
      if (!result.ok) return setError(result.error);
      setValue("");
      onSaved(result.key);
    });
  }

  function cancel() {
    setValue("");
    setError(null);
    onCancel?.();
  }

  return (
    <>
      <div className="reveal" data-open={open} inert={!open}>
        <div>
          <form onSubmit={submit} className="flex gap-2 pb-1 pt-1.5">
            <input
              id={id}
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={PROVIDERS[provider].keyHint}
              autoComplete="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              aria-invalid={error !== null}
              className="field h-9 min-w-0 flex-1 px-2.5 text-[13px] placeholder:text-muted/70"
            />
            <button
              type="submit"
              disabled={!value.trim() || checking}
              className="btn btn-secondary h-9"
            >
              {checking ? "Checking" : "Verify and save"}
            </button>
            {onCancel && (
              <button
                type="button"
                onClick={cancel}
                className="btn btn-quiet h-9"
              >
                Cancel
              </button>
            )}
          </form>
        </div>
      </div>
      <StepError message={error} />
    </>
  );
}
