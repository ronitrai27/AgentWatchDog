import Image from "next/image";
import Link from "next/link";
import { AuthButtons } from "@/components/auth-buttons";
import { LogoMarquee } from "@/components/logo-marquee";
import { ResumeSession } from "@/components/resume-session";
import { RoxHub } from "@/components/rox-hub";
import { Toast } from "@/components/toast";
import { getSession } from "@/lib/session";

const ERRORS: Record<string, string> = {
  denied: "GitHub sign-in was cancelled. Nothing was changed.",
  state: "That sign-in link expired or did not start here. Please try again.",
  token: "GitHub did not accept the sign-in. Please try again.",
  github: "GitHub could not be reached. Please try again.",
  db: "Rox could not reach its database. Please try again in a moment.",
  not_configured: "GitHub sign-in is not configured on this server yet.",
};

const NOTICES: Record<string, string> = {
  github: "Recommended: sign in with GitHub for a real try.",
  judge: "Log in with Quick Judge Mode to try the demo.",
};

export default async function AuthPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // Already signed in (GitHub or Judge Mode, and not expired): skip this page.
  const session = await getSession();
  if (session) {
    return (
      <ResumeSession
        name={
          session.mode === "demo" ? "User" : (session.name ?? session.login)
        }
      />
    );
  }

  const { error, notice } = await searchParams;
  const message = typeof error === "string" ? ERRORS[error] : undefined;
  // Set by the logout buttons in the Home header (see api/auth/logout).
  const noticeText = typeof notice === "string" ? NOTICES[notice] : undefined;

  return (
    <main className="grid min-h-svh lg:grid-cols-2">
      {noticeText && <Toast message={noticeText} duration={7000} />}
      <section className="relative flex flex-col justify-center bg-paper px-6 pb-10 pt-24 sm:px-12 lg:px-20 lg:pb-52 lg:pt-24">
        <Link
          href="/auth"
          className="absolute left-5 top-5 flex items-center gap-2.5 text-ink sm:left-8 sm:top-7"
        >
          <Image
            src="/brand/rox-logo.png"
            alt=""
            width={32}
            height={32}
            className="rounded-lg"
            priority
          />
          <span className="font-serif text-2xl font-semibold tracking-tight">
            rox
          </span>
        </Link>

        <div className="w-full max-w-lg">
          <h1 className="font-serif text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-4xl">
            Built for 3 a.m. incidents without 3 a.m. mistakes.
          </h1>

          <p className="mt-6 text-[17px] leading-relaxed text-ink-soft">
            Reproduces live crashes in an air-gapped sandbox, stress-tests
            latency and security before proposing a fix, and halts in code
            whenever boundaries are hit.
          </p>

          <AuthButtons />

          {message && (
            <p
              role="alert"
              className="mt-4 border border-[#b4443a]/40 bg-[#b4443a]/8 px-3 py-2 text-sm text-[#9a352c]"
            >
              {message}
            </p>
          )}
        </div>

        <aside
          aria-label="Which sign-in to use"
          className="mt-10 w-full max-w-md border rounded border-ink bg-white/40 lg:absolute lg:bottom-10 lg:left-20 lg:right-20 lg:mt-0"
        >
          <p className="flex items-start gap-3 border-b border-ink/20 p-4 text-[12px] leading-snug text-ink">
            <span className="mt-0.5 shrink-0 rounded bg-ink/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-ink">
              Quick look
            </span>
            <span>
              If you want a quick demo with no or low setup, try{" "}
              <strong>Quick Judge Mode</strong>.
            </span>
          </p>
          <p className="flex items-start gap-3 p-4 text-[12px] leading-snug text-ink">
            <span className="mt-0.5 shrink-0 rounded bg-[#2f7d4f] px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-white">
              Recommended
            </span>
            <span>
              For personal and real use, use <strong>GitHub</strong>. It only
              asks to verify who you are.
            </span>
          </p>
        </aside>
      </section>

      <section className="flex min-h-[640px] flex-col bg-white lg:min-h-svh">
        <div className="flex flex-1 items-center justify-center px-6 pt-10">
          <RoxHub />
        </div>
        <div className="pb-8 pt-4">
          <LogoMarquee />
        </div>
      </section>
    </main>
  );
}
