// Better Stack webhooks: what arrived and what Rox does with it. The body only says WHICH incident
// changed; everything else is read back from Better Stack's API, so a forged body cannot wake Rox.
// The incident's heartbeat or monitor finds the Rox user who connected it; their trigger choice in
// Settings > Workflow decides. Starting the pipeline run is the next step: the pipeline's incident
// run reads Sentry today, so for now the decision is logged ("would start Rox").
import {
  type BetterStackIncident,
  betterstackFromEnv,
  decideBetterStack,
  getIncident,
} from "@agent/integrations/betterstack";
import { db } from "@/lib/db";

/** The Rox user who connected this heartbeat or monitor. */
async function owner(source: { kind: string; id: string }) {
  const { rows } = await db().query<{
    user_id: string;
    triggers: string[];
    repo: string | null;
  }>(
    `SELECT user_id, triggers, repo FROM user_setup
      WHERE betterstack_source_kind = $1 AND betterstack_source_id = $2`,
    [source.kind, source.id],
  );
  return rows[0] ?? null;
}

export type BetterStackOutcome =
  | { status: "ignored"; why: string }
  | {
      status: "would_start";
      userId: string;
      trigger: string;
      incident: BetterStackIncident;
    };

/** Handles one delivery. Event text is data: only printed, never followed. */
export async function handleBetterStackWebhook(
  payload: unknown,
): Promise<BetterStackOutcome> {
  const id = (payload as { data?: { id?: unknown } })?.data?.id;
  const incidentId =
    typeof id === "string" || typeof id === "number" ? String(id) : "";
  if (!/^\d{1,20}$/.test(incidentId))
    return log(null, { status: "ignored", why: "no incident id in the body" });

  const s = betterstackFromEnv();
  if (!s)
    return log(null, {
      status: "ignored",
      why: "BETTERSTACK_API_TOKEN is not set, so the incident cannot be checked",
    });

  let incident: BetterStackIncident;
  try {
    incident = await getIncident(s, incidentId);
  } catch (error) {
    return log(null, {
      status: "ignored",
      why: `Better Stack does not confirm incident ${incidentId}: ${error instanceof Error ? error.message : error}`,
    });
  }

  const decision = decideBetterStack(incident);
  if (!decision.wake)
    return log(incident, { status: "ignored", why: decision.ignored });
  const source = incident.source;
  const user = source ? await owner(source).catch(() => null) : null;
  if (!user)
    return log(incident, {
      status: "ignored",
      why: `no Rox user connected ${source?.kind} ${source?.id}`,
    });
  if (!user.triggers.includes(decision.trigger))
    return log(incident, {
      status: "ignored",
      why: `${decision.trigger} is OFF in Settings > Workflow for user ${user.user_id.slice(0, 8)}`,
    });
  return log(incident, {
    status: "would_start",
    userId: user.user_id,
    trigger: decision.trigger,
    incident,
  });
}

function log(
  incident: BetterStackIncident | null,
  outcome: BetterStackOutcome,
): BetterStackOutcome {
  const row = (k: string, v: unknown) =>
    v == null || v === "" ? null : `  ${k.padEnd(12)}${String(v)}`;
  const lines = [
    `[betterstack] incident ${incident?.id ?? "?"}`,
    row("name", incident?.name),
    row("cause", incident?.cause),
    row("status", incident?.status),
    row(
      "source",
      incident?.source && `${incident.source.kind} ${incident.source.id}`,
    ),
    row("started", incident?.startedAt),
    row("resolved", incident?.resolvedAt),
    row(
      "decision",
      outcome.status === "would_start"
        ? `${outcome.trigger} is ON for user ${outcome.userId.slice(0, 8)}: would start Rox (pipeline wiring is next)`
        : `ignored: ${outcome.why}`,
    ),
  ].filter(Boolean);
  console.log(`\n${lines.join("\n")}\n`);
  return outcome;
}
