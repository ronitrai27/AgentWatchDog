import Image from "next/image";

type Logo = {
  name: string;
  src: string;
  /** The source file is white; darken it so it shows on the paper background. */
  darken?: boolean;
};

const LOGOS: Logo[] = [
  { name: "Sentry", src: "/sentry.svg", darken: true },
  { name: "Linear", src: "/linear.png", darken: true },
  { name: "Slack", src: "/slack.png" },
  { name: "PostHog", src: "/posthog.svg" },
  { name: "Better Stack", src: "/beter-stack.svg" },
  { name: "Notion", src: "/Notion-logo.png" },
  { name: "Plane", src: "/plane.jpeg" },
];

function GithubGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className="size-7"
      role="img"
      aria-label="GitHub"
    >
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.7 5.4-5.27 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

function VercelGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className="size-6"
      role="img"
      aria-label="Vercel"
    >
      <path d="M12 3 23 21H1Z" />
    </svg>
  );
}

export function ConnectionLogos() {
  return (
    <div className="w-full max-w-[440px]">
      <p className="mb-3 text-center text-[10px] font-medium uppercase tracking-[0.18em] text-muted">
        Connects to your stack
      </p>
      <ul className="flex flex-wrap items-center justify-center gap-x-6 gap-y-4 text-ink">
        <li className="opacity-80">
          <GithubGlyph />
        </li>
        <li className="opacity-80">
          <VercelGlyph />
        </li>
        {LOGOS.map((logo) => (
          <li key={logo.name}>
            <Image
              src={logo.src}
              alt={logo.name}
              width={28}
              height={28}
              className={`size-7 object-contain opacity-85 ${logo.darken ? "brightness-0" : ""}`}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
