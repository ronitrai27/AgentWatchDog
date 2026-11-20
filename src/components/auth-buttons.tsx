"use client";

import { useEffect, useState } from "react";
import { Toast } from "./toast";

function GithubIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.7 5.4-5.27 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

export function AuthButtons() {
  const [busy, setBusy] = useState(false);

  // Coming back with the Back button restores this page from cache, still
  // marked busy. Reset it.
  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  // Plain anchors: these are API routes, so no client-side prefetch.
  const common = busy ? "pointer-events-none opacity-70" : "";

  return (
    <>
      {busy && <Toast message="Signing in…" busy />}
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <a
          href="/api/auth/github/start"
          onClick={() => setBusy(true)}
          aria-disabled={busy}
          className={`flex items-center justify-center gap-2 whitespace-nowrap rounded bg-ink px-5 py-3 text-sm font-medium text-paper transition-opacity hover:opacity-90 ${common}`}
        >
          <GithubIcon />
          Continue with GitHub
        </a>
        <a
          href="/api/auth/demo"
          onClick={() => setBusy(true)}
          aria-disabled={busy}
          className={`whitespace-nowrap rounded border border-ink/50 px-5 py-3 text-center text-sm font-medium text-ink transition-colors hover:bg-ink/5 ${common}`}
        >
          Quick Judge Mode
        </a>
      </div>
    </>
  );
}
