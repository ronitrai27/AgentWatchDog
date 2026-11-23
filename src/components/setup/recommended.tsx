import { Brand, type BrandId } from "./brand";

const ITEMS: { id: BrandId; name: string; body: string }[] = [
  { id: "slack", name: "Slack", body: "Reports and approvals in a thread" },
  { id: "linear", name: "Linear", body: "Open and close issues for you" },
  { id: "sentry", name: "Sentry", body: "Wake Rox when an error appears" },
  { id: "posthog", name: "PostHog", body: "Wake Rox when a metric drops" },
  { id: "vercel", name: "Vercel", body: "Wake Rox when a deploy fails" },
  { id: "betterstack", name: "Better Stack", body: "Wake Rox on downtime" },
];

export function Recommended({ isJudge }: { isJudge: boolean }) {
  return (
    <section
      aria-labelledby="recommended-title"
      className="mt-14 border-t border-ink/12 pt-8"
    >
      <h2 id="recommended-title" className="text-[15px] font-medium text-ink">
        Recommended connections
      </h2>
      <p className="mt-1 text-[13px] text-muted">
        {isJudge
          ? "Optional. In Quick Demo Mode these run in test mode, with nothing to connect."
          : "Optional. Where Rox hears about problems and where it reports."}
      </p>
      <ul className="mt-4 grid gap-x-10 sm:grid-cols-2">
        {ITEMS.map((item) => (
          <li
            key={item.id}
            className="flex items-center gap-3 border-b border-ink/8 py-3"
          >
            <Brand id={item.id} size={22} />
            <span className="min-w-0 flex-1 text-[13px]">
              <span className="block font-medium text-ink">{item.name}</span>
              <span className="block truncate text-muted">{item.body}</span>
            </span>
            <span className="text-[13px] text-muted">
              {isJudge ? "Test mode" : "Soon"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
