const ROWS: { part: string; demo: string; real: string }[] = [
  {
    part: "Code, tests, k6 and security scans",
    demo: "Real. Runs in a local Docker sandbox on the demo app.",
    real: "Real. Runs in a local Docker sandbox on your repository.",
  },
  {
    part: "Alert",
    demo: "Test mode. A recorded alert is replayed.",
    real: "Your own webhook.",
  },
  {
    part: "Pull request",
    demo: "Test mode. A real branch and diff, shown in Rox and never pushed.",
    real: "A draft pull request on an awd/ branch.",
  },
  {
    part: "Linear issue",
    demo: "Test mode. A preview in Rox.",
    real: "An issue in your Linear.",
  },
  {
    part: "Slack report",
    demo: "Test mode. A preview with a working Approve button.",
    real: "A message in your Slack.",
  },
];

/** Judges only: what is real in the demo. It describes the plan. */
export function TestMode() {
  return (
    <details className="group mt-10 border-t border-ink/12 pt-6">
      <summary className="focusable cursor-pointer list-none rounded text-[15px] font-medium text-ink">
        What is real and what is test mode
        <span className="ml-3 text-[13px] font-normal text-ink-soft underline decoration-ink/25 underline-offset-[3px]">
          <span className="group-open:hidden">Show</span>
          <span className="hidden group-open:inline">Hide</span>
        </span>
      </summary>
      <p className="mt-2 text-[13px] text-ink-muted">
        How a run will work once the agent service is connected. Rox never asks
        a judge for credentials.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-[13px]">
          <thead className="text-ink-muted">
            <tr className="border-b border-ink/12">
              <th className="py-2 pr-6 font-normal">Part of a run</th>
              <th className="py-2 pr-6 font-normal">Quick Demo Mode</th>
              <th className="py-2 font-normal">Your accounts</th>
            </tr>
          </thead>
          <tbody className="align-top text-ink-soft">
            {ROWS.map((row) => (
              <tr key={row.part} className="border-b border-ink/8">
                <th scope="row" className="py-2.5 pr-6 font-medium text-ink">
                  {row.part}
                </th>
                <td className="py-2.5 pr-6">{row.demo}</td>
                <td className="py-2.5">{row.real}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
