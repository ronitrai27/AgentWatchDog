import Image from "next/image";
import type { ReactNode } from "react";

type Logo = {
  name: string;
  /** Public file, or omit and pass a glyph. */
  src?: string;
  glyph?: ReactNode;
  /** Logo is white or has white text: sit it on a dark tile. */
  dark?: boolean;
  /** Image already has its own background: fill the tile. */
  fill?: boolean;
};

const GithubGlyph = (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    className="size-[18px]"
    aria-hidden="true"
  >
    <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.7 5.4-5.27 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
  </svg>
);

const LOGOS: Logo[] = [
  { name: "GitHub", glyph: GithubGlyph, dark: true },
  { name: "Vercel", src: "/vercel.png", dark: true },
  { name: "Sentry", src: "/sentry.svg", dark: true },
  { name: "Linear", src: "/linear.png", dark: true },
  { name: "Slack", src: "/slack.png" },
  { name: "AWS", src: "/aws-color.png", dark: true },
  { name: "Cloudflare", src: "/cloudflare-color.png" },
  { name: "PostHog", src: "/posthog.svg" },
  { name: "Better Stack", src: "/beter-stack.svg", fill: true },
  { name: "Notion", src: "/Notion-logo.png" },
  { name: "Plane", src: "/plane.jpeg", fill: true },
];

function Tile({ logo }: { logo: Logo }) {
  return (
    <li className="mr-8 flex shrink-0 items-center gap-2.5">
      <span
        className={`grid size-8 place-items-center overflow-hidden rounded-lg ${
          logo.dark
            ? "bg-ink text-paper"
            : logo.fill
              ? ""
              : "border border-ink/20 bg-[#f4f6f2]"
        }`}
      >
        {logo.glyph ??
          (logo.src && (
            <Image
              src={logo.src}
              alt=""
              width={32}
              height={32}
              loading="eager"
              className={
                logo.fill ? "size-8 object-cover" : "size-[18px] object-contain"
              }
            />
          ))}
      </span>
      <span className="text-[13px] font-medium text-ink-soft">{logo.name}</span>
    </li>
  );
}

function Row({ logos, reverse = false }: { logos: Logo[]; reverse?: boolean }) {
  // The list is shown twice; the track slides by exactly half, so it loops
  // with no jump.
  return (
    <div className="marquee">
      <ul
        className={`marquee__track ${reverse ? "marquee__track--reverse" : ""}`}
        aria-hidden={reverse}
      >
        {[...logos, ...logos].map((logo, index) => (
          <Tile key={`${logo.name}-${index}`} logo={logo} />
        ))}
      </ul>
    </div>
  );
}

export function LogoMarquee() {
  return (
    <div className="w-full space-y-5">
      <Row logos={LOGOS} />
      <Row logos={[...LOGOS].reverse()} reverse />
    </div>
  );
}
