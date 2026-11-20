import Image from "next/image";
import Link from "next/link";
import { AuthButtons } from "@/components/auth-buttons";
import { LogoMarquee } from "@/components/logo-marquee";
import { RoxHub } from "@/components/rox-hub";

const ERRORS: Record<string, string> = {
  denied: "GitHub sign-in was cancelled. Nothing was changed.",
  state: "That sign-in link expired or did not start here. Please try again.",
  token: "GitHub did not accept the sign-in. Please try again.",
  github: "GitHub could not be reached. Please try again.",
  db: "Rox could not reach its database. Please try again in a moment.",
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
    <main className="grid min-h-svh lg:grid-cols-2">
      <section className="relative flex items-center bg-paper px-6 pb-10 pt-24 sm:px-12 lg:px-20 lg:py-24">
        <Link
          href="/"
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
          <p className="mt-4 text-xs leading-relaxed text-muted">
            GitHub only asks to verify who you are, then you pick which repos
            Rox can see. Quick Judge Mode needs no GitHub account, keys or
            credentials.
          </p>
        </div>
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
