import Link from "next/link";
import { ConnectionLogos } from "@/components/connection-logos";
import { RoxStack } from "@/components/rox-stack";
import { RoxMark } from "@/components/site-header";

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

const ERRORS: Record<string, string> = {
  denied: "GitHub sign-in was cancelled. Nothing was changed.",
  state: "That sign-in link expired or did not start here. Please try again.",
  token: "GitHub did not accept the sign-in. Please try again.",
  github: "GitHub could not be reached. Please try again.",
  not_configured: "GitHub sign-in is not configured on this server yet.",
};

export default async function AuthPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { error } = await searchParams;
  const message = typeof error === "string" ? ERRORS[error] : undefined;

  return (
    <main className="relative grid min-h-svh bg-paper lg:grid-cols-2">
      <Link
        href="/"
        className="absolute left-4 top-4 z-10 flex items-center gap-2 text-sm text-ink-soft transition-colors hover:text-ink sm:left-6 sm:top-6"
      >
        <span aria-hidden="true">←</span> Back
      </Link>

      <section className="flex items-center px-6 pb-8 pt-24 sm:px-12 lg:px-20 lg:py-24">
        <div className="w-full max-w-lg">
          <h1 className="font-serif text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-4xl">
            Built for 3 a.m. incidents without 3 a.m. mistakes.
          </h1>

          <div className="mt-8 flex items-center gap-2 text-ink">
            <span className="grid size-6 place-items-center rounded-md bg-ink text-paper">
              <RoxMark className="size-4" />
            </span>
            <span className="text-xs font-medium">Rox</span>
          </div>

          <p className="mt-4 text-[17px] leading-relaxed text-ink-soft">
            Reproduces live crashes in an air-gapped sandbox, stress-tests
            latency and security before proposing a fix, and halts in code
            whenever boundaries are hit.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            {/* Plain anchors: these are API routes, so no client-side prefetch */}
            <a
              href="/api/auth/github/start"
              className="flex items-center justify-center gap-2 whitespace-nowrap rounded bg-ink px-5 py-3 text-sm font-medium text-paper transition-opacity hover:opacity-90"
            >
              <GithubIcon />
              Continue with GitHub
            </a>
            <a
              href="/api/auth/demo"
              className="whitespace-nowrap rounded! border border-ink/50 px-5 py-3 text-center text-sm font-medium text-ink transition-colors hover:bg-ink/5"
            >
              Quick Judge Mode
            </a>
          </div>
          {message && (
            <p
              role="alert"
              className="mt-4 border border-[#b4443a]/40 bg-[#b4443a]/8 px-3 py-2 text-sm text-[#9a352c]"
            >
              {message}
            </p>
          )}
          <p className="mt-4 text-xs text-muted">
            GitHub only asks to verify who you are, then you pick which repos
            Rox can see. Judge Mode runs on a bundled demo app. No account, keys
            or credentials needed.
          </p>
        </div>
      </section>

      <section className="flex flex-col items-center justify-center gap-8 px-6 pb-14 pt-4 lg:py-12">
        <RoxStack />
        <ConnectionLogos />
      </section>
    </main>
  );
}
