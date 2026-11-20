import Link from "next/link";
import { RunPanel } from "./run-panel";

const INTEGRATIONS = ["GitHub", "Sentry", "Linear", "Slack"];

function Hatch({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`hatch h-3 w-full ${className}`} />;
}

export function Hero() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">
      <div className="border border-ink/50">
        <Hatch />

        <div className="px-4 pt-16 text-center sm:px-8 sm:pt-20">
          <h1 className="font-serif text-4xl font-semibold leading-[1.1] tracking-tight text-ink sm:text-6xl">
            For Developers Who Swear,
            <span className="block text-ink/45">It Wasn't Their Fault.</span>
          </h1>
          <p className="mt-6 font-serif text-xl text-ink sm:text-2xl">
            Production breaks at 3 a.m.
            <span className="block">Rox is already on it.</span>
          </p>
          <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-ink-soft">
            It investigates the alert, reproduces the bug in a sandbox, proves
            the fix, opens the PR and files the ticket. You wake up and merge.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/auth"
              className="bg-ink px-5 py-2.5 text-sm text-paper transition-opacity hover:opacity-90"
            >
              Launch demo workspace
            </Link>
            <a
              href="#product"
              className="border border-ink/60 px-5 py-2.5 text-sm text-ink transition-colors hover:bg-ink/5"
            >
              Watch a run
            </a>
          </div>
        </div>

        <div
          id="product"
          className="mx-auto mt-14 w-full max-w-5xl scroll-mt-8 px-4 sm:px-6"
        >
          <RunPanel />
          <p className="mt-3 text-center text-xs text-muted">
            Simulated run for illustration. Numbers are sample data.
          </p>
        </div>

        <div className="mt-16">
          <Hatch />
        </div>
        <ul
          id="integrations"
          className="grid scroll-mt-8 grid-cols-2 divide-x divide-y divide-ink/30 border-t border-ink/30 sm:grid-cols-4 sm:divide-y-0"
        >
          {INTEGRATIONS.map((name) => (
            <li
              key={name}
              className="flex items-center justify-center px-4 py-5 font-serif text-lg font-semibold text-ink-soft"
            >
              {name}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
