// Sentry webhooks: what arrived and what Rox would do with it. For now it only prints to the
// console; starting a run comes later (startIncidentRun in src/lib/rox-runs.ts).
// One file per source lives in this folder (sentry now, vercel/grafana/betterstack later).
import { decideSentry } from "@agent/integrations/sentry";
import { db } from "@/lib/db";

/** The Rox user who connected this Sentry project, with the triggers they turned on. */
async function owner(projectId: string) {
  const { rows } = await db().query<{ user_id: string; triggers: string[] }>(
    "SELECT user_id, triggers FROM user_setup WHERE sentry_project_id = $1",
    [projectId],
  );
  return rows[0] ?? null;
}

type Issue = {
  id?: string | number;
  shortId?: string;
  title?: string;
  culprit?: string;
  level?: string;
  status?: string;
  substatus?: string;
  count?: string | number;
  permalink?: string;
  web_url?: string;
  project?: { slug?: string };
};

/** Prints one Sentry delivery. Event text is data: only printed, never followed. */
export async function logSentryWebhook(
  resource: string,
  headers: Headers,
  payload: unknown,
) {
  const p = payload as {
    action?: string;
    installation?: { uuid?: string };
    data?: { issue?: Issue; event?: Issue; triggered_rule?: string };
  };
  const issue = p.data?.issue ?? p.data?.event;
  const decision = decideSentry(resource, payload);
  const incident = "incident" in decision ? decision.incident : null;
  const user = incident
    ? await owner(incident.projectId).catch(() => null)
    : null;
  const on = Boolean(incident && user?.triggers.includes(incident.trigger));

  const row = (k: string, v: unknown) =>
    v == null || v === "" ? null : `  ${k.padEnd(12)}${String(v)}`;
  const lines = [
    `[sentry] ${resource}.${p.action ?? "?"}  request=${headers.get("request-id") ?? "-"}`,
    row("issue", issue?.shortId ?? issue?.id),
    row("title", issue?.title),
    row("culprit", issue?.culprit),
    row("level", issue?.level),
    row(
      "status",
      issue?.substatus ? `${issue.status} (${issue.substatus})` : issue?.status,
    ),
    row("count", issue?.count),
    row("project", issue?.project?.slug),
    row("rule", p.data?.triggered_rule),
    row("link", issue?.permalink ?? issue?.web_url),
    row(
      "decision",
      incident
        ? `${incident.trigger}: ${incident.why}`
        : `ignored: ${(decision as { ignored: string }).ignored}`,
    ),
    incident
      ? row(
          "rox user",
          !user
            ? `none: no Rox user connected Sentry project ${incident.projectId}`
            : on
              ? `${user.user_id.slice(0, 8)}, trigger is ON (would wake Rox)`
              : `${user.user_id.slice(0, 8)}, ${incident.trigger} is OFF in Settings > Workflow`,
        )
      : null,
  ].filter(Boolean);
  console.log(`\n${lines.join("\n")}\n`);
}
