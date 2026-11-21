type Status = "done" | "todo" | "soon";

type Step = {
  title: string;
  body: string;
  status: Status;
  action?: { label: string; href: string };
};

const BADGE: Record<Status, { label: string; className: string }> = {
  done: { label: "Done", className: "bg-[#2f7d4f]/12 text-[#24603c]" },
  todo: { label: "To do", className: "bg-[#c98a1c]/15 text-[#8a5d0c]" },
  soon: { label: "Coming next", className: "bg-ink/8 text-muted" },
};

function judgeSteps(): Step[] {
  return [
    {
      title: "Quick Demo Mode is on",
      body: "No accounts and no keys. You are signed in as a temporary user, and nothing connects to your GitHub, Linear or Slack.",
      status: "done",
    },
    {
      title: "Choose the model",
      body: "Rox's own demo budget runs the agent by default. You can add your own model API key to lift the limit. That is the only credential Rox would ever ask for, and it is optional.",
      status: "soon",
    },
    {
      title: "Run the demo incident",
      body: "Rox takes an alert from the bundled demo app, reproduces the bug in a local Docker sandbox, writes a fix, then runs tests, k6 and security scans.",
      status: "soon",
    },
    {
      title: "Watch the run",
      body: "A live trace, the verification gates as they pass, and a tamper-evident audit trail you can check.",
      status: "soon",
    },
    {
      title: "Review the result",
      body: "The pull request, Linear issue and Slack message appear here in test mode.",
      status: "soon",
    },
  ];
}

function realSteps(installations: number): Step[] {
  const installed = installations > 0;
  return [
    {
      title: "Signed in with GitHub",
      body: "GitHub only verified who you are. Rox has not seen any repository yet.",
      status: "done",
    },
    {
      title: "Choose which repositories Rox can see",
      body: installed
        ? `Rox is installed on ${installations} account${installations === 1 ? "" : "s"}. You can add or remove repositories at any time on GitHub.`
        : "You pick the repositories on GitHub's own page. Rox writes only to branches that start with awd/ and has no way to merge.",
      status: installed ? "done" : "todo",
      action: installed
        ? { label: "Add more repositories", href: "/api/auth/github/install" }
        : { label: "Choose repositories", href: "/api/auth/github/install" },
    },
    {
      title: "Connect an alert source",
      body: "Point Sentry, Vercel or PostHog at your Rox webhook address so incidents reach the agent.",
      status: "soon",
    },
    {
      title: "Connect Linear and Slack (optional)",
      body: "Rox files the issue and posts the report. Without them, results stay in Rox and on the pull request.",
      status: "soon",
    },
    {
      title: "Add a model API key",
      body: "The agent uses your model key. It is stored encrypted and is only used inside Rox's tool proxy.",
      status: "soon",
    },
  ];
}

function StatusIcon({ status }: { status: Status }) {
  if (status === "done") {
    return (
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#2f7d4f] text-white">
        <svg
          viewBox="0 0 20 20"
          className="size-4"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M5 10.5l3.2 3.2L15 6.8"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }
  return (
    <span
      className={`grid size-6 shrink-0 place-items-center rounded-full border-2 ${
        status === "todo" ? "border-[#c98a1c]" : "border-ink/20"
      }`}
    >
      <span
        className={`size-1.5 rounded-full ${status === "todo" ? "bg-[#c98a1c]" : "bg-ink/20"}`}
      />
    </span>
  );
}

export function SetupGuide({
  isJudge,
  installations,
}: {
  isJudge: boolean;
  installations: number;
}) {
  const steps = isJudge ? judgeSteps() : realSteps(installations);

  return (
    <section aria-labelledby="guide-title">
      <h2
        id="guide-title"
        className="font-serif text-xl font-semibold text-ink"
      >
        {isJudge ? "Your Quick Demo walkthrough" : "Setup guide"}
      </h2>
      <p className="mt-1 text-sm text-ink-soft">
        {isJudge
          ? "Here is what happens, in order. Steps marked Coming next arrive with the agent service."
          : "Rox only asks for what each step needs, one step at a time."}
      </p>

      <ol className="mt-5 border border-ink/25 bg-white/70">
        {steps.map((step, index) => (
          <li
            key={step.title}
            className="flex gap-4 border-b border-ink/15 p-4 last:border-b-0"
          >
            <StatusIcon status={step.status} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-ink">
                  {index + 1}. {step.title}
                </h3>
                <span
                  className={`rounded px-1.5 text-[10px] font-medium leading-5 ${BADGE[step.status].className}`}
                >
                  {BADGE[step.status].label}
                </span>
              </div>
              <p className="mt-1 text-sm leading-relaxed text-ink-soft">
                {step.body}
              </p>
              {step.action && (
                <a
                  href={step.action.href}
                  className="mt-3 inline-block border border-ink/50 px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-ink/5"
                >
                  {step.action.label}
                </a>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

type Row = { part: string; demo: string; demoReal: boolean; real: string };

const ROWS: Row[] = [
  {
    part: "Running code, tests, k6 and security scans",
    demo: "Real, in a local Docker sandbox, on the bundled demo app",
    demoReal: true,
    real: "Real, in a local Docker sandbox, on your repository",
  },
  {
    part: "The alert (Sentry, Vercel, PostHog)",
    demo: "A recorded alert from a test fixture",
    demoReal: false,
    real: "Your real webhook",
  },
  {
    part: "The pull request",
    demo: "A real git branch and diff, shown as a PR card in Rox. Nothing is pushed to GitHub.",
    demoReal: false,
    real: "A draft PR on an awd/ branch in your repository",
  },
  {
    part: "The Linear issue",
    demo: "A preview card",
    demoReal: false,
    real: "A real issue in your Linear",
  },
  {
    part: "The Slack report and Approve button",
    demo: "A preview card with a working Approve button",
    demoReal: false,
    real: "A real message in your Slack",
  },
  {
    part: "Credentials needed",
    demo: "None. A model key is optional.",
    demoReal: true,
    real: "The GitHub App install. Slack, Linear and a model key are optional.",
  },
];

export function TestModePanel() {
  return (
    <section aria-labelledby="test-title" className="mt-10">
      <div className="flex flex-wrap items-center gap-2">
        <h2
          id="test-title"
          className="font-serif text-xl font-semibold text-ink"
        >
          What is real and what is test mode
        </h2>
        <span className="rounded bg-ink/8 px-1.5 text-[10px] font-medium leading-5 text-muted">
          Design preview
        </span>
      </div>
      <p className="mt-1 text-sm text-ink-soft">
        Quick Demo Mode never asks for your credentials. Where a real account
        would be needed, Rox shows the same result in test mode instead.
      </p>

      <div className="mt-5 overflow-x-auto border border-ink/25 bg-white/70">
        <table className="w-full min-w-[640px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-ink/20 text-[11px] uppercase tracking-wider text-muted">
              <th className="px-4 py-2.5 font-medium">Part of the run</th>
              <th className="px-4 py-2.5 font-medium">In Quick Demo Mode</th>
              <th className="px-4 py-2.5 font-medium">
                With your own accounts
              </th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr
                key={row.part}
                className="border-b border-ink/10 align-top last:border-b-0"
              >
                <th scope="row" className="px-4 py-3 font-medium text-ink">
                  {row.part}
                </th>
                <td className="px-4 py-3 text-ink-soft">
                  <span
                    className={`mr-2 rounded px-1.5 text-[10px] font-semibold uppercase leading-5 ${
                      row.demoReal
                        ? "bg-[#2f7d4f]/12 text-[#24603c]"
                        : "bg-[#c98a1c]/15 text-[#8a5d0c]"
                    }`}
                  >
                    {row.demoReal ? "Real" : "Test mode"}
                  </span>
                  {row.demo}
                </td>
                <td className="px-4 py-3 text-ink-soft">{row.real}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
