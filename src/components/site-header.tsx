import Link from "next/link";

export function RoxMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Rox"
      width="28"
      height="28"
    >
      <circle
        cx="32"
        cy="32"
        r="29"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        d="M32 10 L38 32 L32 54 L26 32 Z M10 32 L32 26 L54 32 L32 38 Z"
        fill="currentColor"
        opacity=".85"
      />
    </svg>
  );
}

const LINKS = [
  { label: "Product", href: "#product" },
  { label: "Integrations", href: "#integrations" },
  { label: "Contact", href: "#contact" },
];

export function SiteHeader() {
  return (
    <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
      <Link href="/web" className="flex items-center gap-2 text-ink">
        <RoxMark />
        <span className="font-serif text-xl font-semibold tracking-tight">
          rox
        </span>
      </Link>

      <nav aria-label="Primary" className="hidden items-center gap-8 sm:flex">
        {LINKS.map((link) => (
          <a
            key={link.label}
            href={link.href}
            className="text-sm text-ink transition-colors hover:text-ink-soft"
          >
            {link.label}
          </a>
        ))}
      </nav>

      <div className="flex items-center gap-2">
        <Link
          href="/auth"
          className="border border-ink/40 px-4 py-2 text-sm text-ink transition-colors hover:bg-ink/5"
        >
          Sign in
        </Link>
        <Link
          href="/auth"
          className="hidden border border-ink bg-ink px-4 py-2 text-sm text-paper transition-opacity hover:opacity-90 sm:inline-block"
        >
          Judge mode
        </Link>
      </div>
    </header>
  );
}
