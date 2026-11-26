// The final report of a run, sent to the app the user chose in Connections (Slack today,
// Telegram later). Called by the graph's report node, which is code: every run that ends with a
// pull request or an honest stop is reported, whatever the models did. The model never writes
// or sends this message, and nothing in the repository can choose where it goes.
import {
  type FixReportStatus,
  slackFromEnv,
} from "../../../agent/src/integrations/slack";
import { emit, readEvents } from "../events";

export type ReportTarget = {
  to: "slack" | "telegram";
  /** Slack channel id (Telegram chat id later). Chosen by the user in Connections. */
  channel: string;
  channelName?: string | null;
};

export type RunReport = {
  run: string;
  repo: string;
  status: FixReportStatus;
  /** What Rox changed, or why it stopped. */
  summary: string;
  /** What was wrong. */
  rootCause: string;
  failing: string[];
  checksPassed: string[];
  prUrl?: string;
  prNumber?: number;
  /** Text that tried to steer the agent, already ignored. */
  injections: string[];
};

type Sender = (target: ReportTarget, report: RunReport) => Promise<string>;

const SENDERS: Record<ReportTarget["to"], Sender> = {
  async slack(target, r) {
    const slack = slackFromEnv();
    if (!slack) throw new Error("SLACK_BOT_TOKEN is not set");
    const extra = [
      r.failing.length ? `Failing: ${r.failing.join("; ")}` : "",
      r.injections.length
        ? `Warning: the change contains text aimed at AI agents (${r.injections.join(", ")}); it was ignored.`
        : "",
    ].filter(Boolean);
    const sent = await slack.postFixReport({
      repo: r.repo,
      status: r.status,
      summary: [r.summary, ...extra].join("\n"),
      rootCause: r.rootCause,
      checksPassed: r.checksPassed,
      prUrl: r.prUrl,
      prNumber: r.prNumber,
      channel: target.channel,
      signal: AbortSignal.timeout(15_000),
    });
    return `${sent.channel}/${sent.ts}`;
  },
  async telegram() {
    throw new Error("Telegram reports are not built yet");
  },
};

/**
 * Sends the report once per run: a report node run again after a crash finds the earlier
 * `report.sent` in the trace and does not post twice. A failed send is traced, never thrown, so a
 * Slack outage cannot turn a good fix into a failed run.
 */
export async function sendReport(
  target: ReportTarget,
  report: RunReport,
  send: Sender = SENDERS[target.to],
): Promise<boolean> {
  const done = (await readEvents(report.run)).some(
    (e) => e.kind === "report.sent",
  );
  if (done) return true;
  const t0 = Date.now();
  try {
    const where = await send(target, report);
    await emit(report.run, {
      step: "report",
      kind: "report.sent",
      title: `Report sent to ${target.to}${target.channelName ? ` #${target.channelName}` : ""}`,
      status: "pass",
      ms: Date.now() - t0,
      data: { to: target.to, channel: target.channel, message: where },
    });
    return true;
  } catch (error) {
    await emit(report.run, {
      step: "report",
      kind: "report.failed",
      title:
        `The report to ${target.to} failed: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          300,
        ),
      status: "error",
      ms: Date.now() - t0,
    });
    return false;
  }
}
