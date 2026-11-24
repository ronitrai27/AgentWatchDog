"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const STEPS = [
  "Starting Agent server",
  "Loading environment",
  "Checking server health",
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function StartingAgent() {
  const router = useRouter();
  // 0, 1, 2 = that step is running; 3 = all done
  const [current, setCurrent] = useState(0);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt only exists to re-run this effect on "Try again"
  useEffect(() => {
    let cancelled = false;

    async function run() {
      setFailed(false);
      setCurrent(0);
      await sleep(700);
      if (cancelled) return;
      setCurrent(1);
      await sleep(700);
      if (cancelled) return;
      setCurrent(2);

      // The only real check here: the database must answer and the server
      // must be configured. Held for a moment so the step is readable.
      const [health] = await Promise.all([
        fetch("/api/health", { cache: "no-store" })
          .then((response) => response.json() as Promise<{ ok: boolean }>)
          .catch(() => null),
        sleep(800),
      ]);
      if (cancelled) return;

      if (health?.ok) {
        setCurrent(3);
        await sleep(400);
        if (!cancelled) router.replace("/home?welcome=1");
      } else {
        setFailed(true);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [router, attempt]);

  return (
    <main className="grid min-h-svh place-items-center bg-paper px-6">
      <div className="w-full max-w-xs">
        <Image
          src="/brand/rox-logo.png"
          alt="Rox"
          width={48}
          height={48}
          className="rounded-lg"
          priority
        />
        <h1 className="mt-5 font-serif text-2xl font-semibold tracking-tight text-ink">
          Getting Rox ready
        </h1>

        <ol className="mt-6 space-y-3 text-sm">
          {STEPS.map((label, index) => {
            const done = current > index;
            const active = current === index && !failed;
            const broken = failed && current === index;
            return (
              <li key={label} className="flex items-center gap-3">
                <span className="grid size-5 place-items-center">
                  {done ? (
                    <svg
                      viewBox="0 0 20 20"
                      className="size-5 text-[#2f7d4f]"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M5 10.5l3.2 3.2L15 6.8"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : active ? (
                    <svg
                      viewBox="0 0 24 24"
                      className="size-4 animate-spin text-ink"
                      fill="none"
                      aria-hidden="true"
                    >
                      <circle
                        cx="12"
                        cy="12"
                        r="9"
                        stroke="currentColor"
                        strokeOpacity="0.25"
                        strokeWidth="3"
                      />
                      <path
                        d="M21 12a9 9 0 0 0-9-9"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                      />
                    </svg>
                  ) : broken ? (
                    <span className="text-base leading-none text-[#9a352c]">
                      ×
                    </span>
                  ) : (
                    <span className="size-1.5 rounded-full bg-ink/25" />
                  )}
                </span>
                <span
                  className={
                    done
                      ? "text-ink"
                      : active
                        ? "text-ink"
                        : broken
                          ? "text-[#9a352c]"
                          : "text-ink-muted"
                  }
                >
                  {label}
                  {active ? "…" : ""}
                </span>
              </li>
            );
          })}
        </ol>

        {failed && (
          <div
            role="alert"
            className="mt-6 border border-[#b4443a]/40 bg-[#b4443a]/8 p-3 text-sm text-[#9a352c]"
          >
            The server did not pass its health check. The database may not be
            running.
            <div className="mt-3 flex gap-3">
              <button
                type="button"
                onClick={() => setAttempt((value) => value + 1)}
                className="bg-ink px-3 py-1.5 text-xs text-paper"
              >
                Try again
              </button>
              <a
                href="/auth"
                className="px-1 py-1.5 text-xs text-ink underline underline-offset-4"
              >
                Back to sign in
              </a>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
