"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { removeProviderKey } from "@/app/(app)/home/actions";
import { Brand } from "@/components/setup/brand";
import { KeyForm } from "@/components/setup/key-form";
import { StepError } from "@/components/setup/step-error";
import {
  findModel,
  PROVIDERS,
  type Provider,
  type SavedKey,
  type SetupState,
} from "@/lib/models";

// A fixed time zone, so the server and the browser print the same date.
const day = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function Variable({
  provider,
  saved,
  usedBy,
  onChanged,
}: {
  provider: Provider;
  saved: SavedKey;
  /** The chosen models that need this key. */
  usedBy: string[];
  onChanged: (message: string) => void;
}) {
  const id = useId();
  const [mode, setMode] = useState<"view" | "replace" | "delete">("view");
  const [error, setError] = useState<string | null>(null);
  const [deleting, startDeleting] = useTransition();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { name, envName } = PROVIDERS[provider];

  useEffect(() => {
    if (mode === "delete") cancelRef.current?.focus();
    if (mode === "replace") document.getElementById(id)?.focus();
  }, [mode, id]);

  function remove() {
    setError(null);
    startDeleting(async () => {
      const result = await removeProviderKey(provider);
      if (result.ok) onChanged(`${envName} was deleted.`);
      else setError(result.error);
    });
  }

  return (
    <li className="py-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
        <Brand id={provider} size={24} />
        <div className="min-w-0 flex-1 text-[13px]">
          <label
            htmlFor={id}
            className="block truncate font-mono font-medium text-ink"
          >
            {envName}
          </label>
          <p className="text-ink-muted">
            <span className="font-mono">
              <span aria-hidden="true">••••••••</span>
              <span className="sr-only">Ends in </span>
              {saved.last4}
            </span>
            <span className="mx-1.5" aria-hidden="true">
              ·
            </span>
            Saved {day.format(new Date(saved.savedAt))}
          </p>
        </div>
        {mode === "view" && (
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              aria-label={`Replace ${envName}`}
              onClick={() => setMode("replace")}
              className="btn btn-secondary h-7 px-2.5"
            >
              Replace
            </button>
            <button
              type="button"
              aria-label={`Delete ${envName}`}
              onClick={() => setMode("delete")}
              className="btn btn-danger h-7 px-2.5"
            >
              Delete
            </button>
          </div>
        )}
      </div>

      <KeyForm
        id={id}
        provider={provider}
        open={mode === "replace"}
        onSaved={() => {
          setMode("view");
          onChanged(`${envName} was replaced.`);
        }}
        onCancel={() => setMode("view")}
      />

      <div
        className="reveal"
        data-open={mode === "delete"}
        inert={mode !== "delete"}
      >
        <div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pb-1 pt-2.5">
            <p className="min-w-0 flex-1 basis-60 text-[13px] text-ink">
              Delete your {name} key?{" "}
              {usedBy.length > 0
                ? `${usedBy.join(" and ")} cannot run without it.`
                : "You can add it again later."}
            </p>
            <div className="flex shrink-0 gap-2">
              <button
                ref={cancelRef}
                type="button"
                onClick={() => {
                  setMode("view");
                  setError(null);
                }}
                className="btn btn-quiet h-7 px-2.5"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={remove}
                disabled={deleting}
                className="btn btn-danger h-7 px-2.5"
              >
                {deleting ? "Deleting" : "Delete key"}
              </button>
            </div>
          </div>
        </div>
      </div>
      <StepError message={error} />
    </li>
  );
}

export function EnvVariables({ setup }: { setup: SetupState }) {
  const [message, setMessage] = useState("");
  const saved = (Object.keys(PROVIDERS) as Provider[]).flatMap((provider) => {
    const key = setup.keys[provider];
    return key ? [{ provider, key }] : [];
  });
  const models = [
    ...new Set([findModel(setup.orchestrator), findModel(setup.subagent)]),
  ];
  const usedBy = (provider: Provider) =>
    models.flatMap((model) =>
      model?.provider === provider ? [model.label] : [],
    );

  return (
    <section aria-label="API keys">
      {saved.length > 0 ? (
        <ul className="divide-y divide-ink/10 border-b border-ink/10">
          {saved.map(({ provider, key }) => (
            <Variable
              key={provider}
              provider={provider}
              saved={key}
              usedBy={usedBy(provider)}
              onChanged={setMessage}
            />
          ))}
        </ul>
      ) : (
        <p className="py-6 text-[13px] text-ink-soft">
          No saved variables. Add a model key on{" "}
          <Link
            href="/home"
            className="focusable rounded text-ink underline decoration-ink/25 underline-offset-[3px] hover:decoration-ink"
          >
            Home
          </Link>{" "}
          and it appears here.
        </p>
      )}

      <p className="mt-3 min-h-5 text-[13px] text-ink-soft" aria-live="polite">
        {message}
      </p>
    </section>
  );
}
