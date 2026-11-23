"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { saveRepo } from "@/app/(app)/home/actions";
import { DEMO_REPO } from "@/lib/models";
import { Brand } from "./brand";
import { Select } from "./select";
import { StepError } from "./step-error";

type Repo = { name: string; hidden: boolean };
type Load =
  | { status: "loading" }
  | { status: "ready"; repos: Repo[] }
  | { status: "failed" };

export function RepoStep({
  current,
  isJudge,
  onSaved,
}: {
  current: string | null;
  isJudge: boolean;
  onSaved: (repo: string) => void;
}) {
  const [load, setLoad] = useState<Load>(
    isJudge
      ? { status: "ready", repos: [{ name: DEMO_REPO, hidden: false }] }
      : { status: "loading" },
  );
  const [repo, setRepo] = useState(current ?? (isJudge ? DEMO_REPO : null));
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const fetchRepos = useCallback(async () => {
    try {
      const response = await fetch("/api/setup/repos");
      if (!response.ok) throw new Error();
      const { repos } = (await response.json()) as { repos: Repo[] };
      setLoad({ status: "ready", repos });
    } catch {
      // Keep a list we already have if only a refresh failed.
      setLoad((now) => (now.status === "ready" ? now : { status: "failed" }));
    }
  }, []);

  // Load once, and again when the person comes back from GitHub's own page.
  useEffect(() => {
    if (isJudge) return;
    fetchRepos();
    window.addEventListener("focus", fetchRepos);
    return () => window.removeEventListener("focus", fetchRepos);
  }, [isJudge, fetchRepos]);

  const repos = load.status === "ready" ? load.repos : [];

  function save() {
    if (!repo) return;
    setError(null);
    startSaving(async () => {
      const result = await saveRepo(repo);
      if (result.ok) onSaved(repo);
      else setError(result.error);
    });
  }

  return (
    <>
      <p className="text-[13px] leading-relaxed text-ink-soft">
        {isJudge
          ? "Quick Demo Mode uses an app that comes with Rox."
          : "Rox works on this repository only. It writes to branches that start with awd/ and has no way to merge."}
      </p>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Select
          className="min-w-0 flex-1"
          label="Repository"
          value={repo}
          onChange={setRepo}
          placeholder={
            load.status === "loading"
              ? "Loading your repositories"
              : "Select a repository"
          }
          searchPlaceholder={repos.length > 6 ? "Find a repository" : undefined}
          emptyText={
            load.status === "loading"
              ? "Loading your repositories from GitHub."
              : load.status === "failed"
                ? "GitHub did not answer. Reload the page to try again."
                : "Rox cannot see any repository yet. Add one on GitHub."
          }
          options={repos.map(({ name, hidden }) => ({
            value: name,
            label: name,
            icon: <Brand id="github" size={20} />,
            hint: isJudge ? "Bundled" : hidden ? "Private" : undefined,
          }))}
          footer={
            isJudge ? undefined : (
              <a
                href="/api/auth/github/install"
                className="focusable flex h-8 items-center rounded px-2 text-[13px] text-ink-soft hover:bg-ink/7"
              >
                Add repositories on GitHub
              </a>
            )
          }
        />
        <button
          type="button"
          onClick={save}
          disabled={!repo || saving}
          className="btn btn-primary h-9"
        >
          {saving ? "Connecting" : "Connect repository"}
        </button>
      </div>
      <StepError message={error} />
    </>
  );
}
