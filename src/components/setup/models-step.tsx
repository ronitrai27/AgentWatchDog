"use client";

import { type FormEvent, useId, useState, useTransition } from "react";
import { saveModels, saveProviderKey } from "@/app/(app)/home/actions";
import {
  findModel,
  MODELS,
  type ModelId,
  PROVIDERS,
  type Provider,
  providersFor,
  type SavedKey,
  type SetupState,
} from "@/lib/models";
import { Brand } from "./brand";
import { type Option, Select } from "./select";
import { StepError } from "./step-error";

type Keys = SetupState["keys"];
function modelOptions(keys: Keys): Option[] {
  return MODELS.map((model) => {
    // Once a key is saved we know which models it can use.
    const key = keys[model.provider];
    const blocked = key !== undefined && !key.models.includes(model.id);
    return {
      value: model.id,
      label: model.label,
      group: PROVIDERS[model.provider].name,
      icon: <Brand id={model.provider} size={18} />,
      disabled: blocked,
      hint: blocked ? "Not on your key" : undefined,
    };
  });
}

function Row({
  label,
  help,
  children,
}: {
  label: string;
  help: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid items-center gap-x-6 gap-y-1.5 py-2 sm:grid-cols-[minmax(0,1fr)_256px]">
      <div>
        <p className="text-[13px] font-medium text-ink">{label}</p>
        <p className="text-[13px] text-muted">{help}</p>
      </div>
      {children}
    </div>
  );
}

function KeyRow({
  provider,
  saved,
  optional,
  onSaved,
}: {
  provider: Provider;
  saved: SavedKey | undefined;
  optional: boolean;
  onSaved: (key: SavedKey) => void;
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, startChecking] = useTransition();
  const { name, keyHint } = PROVIDERS[provider];
  const showField = editing || (!saved && !optional);

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    startChecking(async () => {
      const result = await saveProviderKey(provider, value);
      if (!result.ok) return setError(result.error);
      setValue("");
      setEditing(false);
      onSaved(result.key);
    });
  }

  return (
    <div className="py-2">
      <div className="flex min-h-8 items-center gap-2.5">
        <Brand id={provider} size={20} />
        <label
          htmlFor={id}
          className="text-[13px] font-medium text-ink"
        >{`${name} API key`}</label>
        {!showField && (
          <span className="ml-auto flex items-center gap-3 text-[13px] text-muted">
            {saved ? `Verified, ends in ${saved.last4}` : "Not needed"}
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="btn btn-secondary h-7 px-2.5"
            >
              {saved ? "Replace" : "Use my own"}
            </button>
          </span>
        )}
      </div>
      <div className="reveal" data-open={showField} inert={!showField}>
        <div>
          <form onSubmit={submit} className="flex gap-2 pb-1 pt-1.5">
            <input
              id={id}
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={keyHint}
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
            {(saved || optional) && (
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setValue("");
                  setError(null);
                }}
                className="btn btn-quiet h-9"
              >
                Cancel
              </button>
            )}
          </form>
        </div>
      </div>
      <StepError message={error} />
    </div>
  );
}

export function ModelsStep({
  state,
  isJudge,
  onKeys,
  onSaved,
}: {
  state: SetupState;
  isJudge: boolean;
  onKeys: (keys: Keys) => void;
  onSaved: (choice: { orchestrator: ModelId; subagent: ModelId }) => void;
}) {
  const [orchestrator, setOrchestrator] = useState(state.orchestrator);
  const [subagent, setSubagent] = useState(state.subagent);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const options = modelOptions(state.keys);
  const providers = providersFor(orchestrator, subagent);
  const chosen = orchestrator !== null && subagent !== null;
  const missing = isJudge ? [] : providers.filter((p) => !state.keys[p]);

  function save() {
    if (!orchestrator || !subagent) return;
    setError(null);
    startSaving(async () => {
      const result = await saveModels(orchestrator, subagent);
      if (result.ok) onSaved({ orchestrator, subagent });
      else setError(result.error);
    });
  }

  return (
    <>
      <Row label="Orchestrator" help="Plans the run and decides each next step">
        <Select
          label="Orchestrator model"
          value={orchestrator}
          onChange={(value) => setOrchestrator(findModel(value)?.id ?? null)}
          placeholder="Select a model"
          options={options}
        />
      </Row>
      <Row label="Sub agents" help="Investigate, reproduce, fix and verify">
        <Select
          label="Sub agent model"
          value={subagent}
          onChange={(value) => setSubagent(findModel(value)?.id ?? null)}
          placeholder="Select a model"
          options={options}
        />
      </Row>

      <div className="reveal" data-open={chosen} inert={!chosen}>
        <div>
          <div className="mt-2 border-t border-ink/12 pt-2">
            {providers.map((provider) => (
              <KeyRow
                key={provider}
                provider={provider}
                saved={state.keys[provider]}
                optional={isJudge}
                onSaved={(key) => onKeys({ ...state.keys, [provider]: key })}
              />
            ))}
            <p className="py-1 text-[13px] text-muted">
              {isJudge
                ? "Quick Demo Mode does not ask for a key."
                : "Keys are checked with the provider, then stored encrypted."}
            </p>
          </div>

          <div className="flex items-center gap-3 pb-1 pt-3">
            <button
              type="button"
              onClick={save}
              disabled={missing.length > 0 || saving}
              className="btn btn-primary"
            >
              {saving ? "Saving" : "Save models"}
            </button>
            {missing.length > 0 && (
              <p className="text-[13px] text-muted">
                Add your {missing.map((p) => PROVIDERS[p].name).join(" and ")}{" "}
                key to continue.
              </p>
            )}
          </div>
        </div>
      </div>
      <StepError message={error} />
    </>
  );
}
