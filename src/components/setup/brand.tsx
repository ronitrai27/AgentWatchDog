import Image from "next/image";

// Company logos, from public/. White logos sit on a dark tile, and logos that
// are already a full square fill it.
const BRANDS = {
  github: { src: "/github-dark.svg", dark: true },
  openai: { src: "/openai-chatgpt.svg" },
  anthropic: { src: "/claude.svg" },
  google: { src: "/gemini.svg" },
  docker: { src: "/docker.svg" },
  daytona: { src: "/Icon%20512x512.png", fill: true },
  e2b: { src: "/e2b.jpeg", fill: true },
  slack: { src: "/slack.png" },
  telegram: { src: "/telegram.jpeg", fill: true },
  linear: { src: "/linear.png", dark: true },
  sentry: { src: "/sentry.svg", dark: true },
  posthog: { src: "/posthog.svg" },
  vercel: { src: "/vercel.png", dark: true },
  betterstack: { src: "/beter-stack.svg", fill: true },
} satisfies Record<string, { src: string; dark?: boolean; fill?: boolean }>;

export type BrandId = keyof typeof BRANDS;

/** A company's own logo. Decorative: the name is always written next to it. */
export function Brand({ id, size = 16 }: { id: BrandId; size?: number }) {
  const brand: { src: string; dark?: boolean; fill?: boolean } = BRANDS[id];
  const tiled = brand.dark || brand.fill;
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: tiled ? size / 4.5 : 0,
      }}
      className={`grid shrink-0 place-items-center overflow-hidden ${
        brand.dark ? "bg-ink" : ""
      }`}
    >
      <Image
        src={brand.src}
        alt=""
        width={size * 2}
        height={size * 2}
        unoptimized
        className={
          brand.dark ? "size-[70%] object-contain" : "size-full object-contain"
        }
      />
    </span>
  );
}
