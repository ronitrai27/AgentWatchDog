// Better Stack (Uptime / Incidents) API adapter. One API token in .env (BETTERSTACK_API_TOKEN) lists
// heartbeats and monitors, reads incidents and registers Rox's outgoing webhook. Better Stack does
// not sign webhooks, so Rox's webhook carries a secret header (BETTERSTACK_WEBHOOK_SECRET), and every
// incident is read back from the API before Rox trusts it: the webhook body is never the source of truth.
import { timingSafeEqual } from "node:crypto";

const API = "https://incidents.betterstack.com/api";

/** The header Rox's outgoing webhook sends with BETTERSTACK_WEBHOOK_SECRET. */
export const BETTERSTACK_SECRET_HEADER = "x-rox-secret";

/** The name of Rox's outgoing webhook in Better Stack, so a second connect finds it. */
const WEBHOOK_NAME = "Rox (wakes the SRE agent)";

export type BetterStackEnv = { token: string };

export function betterstackFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BetterStackEnv | null {
  const token = env.BETTERSTACK_API_TOKEN?.trim();
  return token ? { token } : null;
}

async function call<T>(
  s: BetterStackEnv,
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${s.token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: init.signal ?? AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Better Stack answered ${res.status} for ${path}: ${text.slice(0, 200)}`,
    );
  }
  return (await res.json()) as T;
}

type Page<T> = { data: T[]; pagination?: { next: string | null } };

/** Follows pagination, at most `pages` pages. */
async function listAll<T>(
  s: BetterStackEnv,
  path: string,
  pages = 5,
  signal?: AbortSignal,
): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = path;
  for (let i = 0; next && i < pages; i++) {
    const page: Page<T> = await call<Page<T>>(s, next, { signal });
    out.push(...page.data);
    next = page.pagination?.next
      ? page.pagination.next.replace(/^https:\/\/[^/]+\/api/, "")
      : null;
  }
  return out;
}

/** Something whose incidents can wake Rox: a heartbeat or an uptime monitor. */
export type BetterStackSource = {
  kind: "heartbeat" | "monitor";
  id: string;
  name: string;
  status: string;
  /** What it checks: the monitored URL, or the heartbeat's period. */
  detail: string;
};

type Resource = { id: string; attributes: Record<string, unknown> };

export async function listSources(
  s: BetterStackEnv,
  signal?: AbortSignal,
): Promise<BetterStackSource[]> {
  const [heartbeats, monitors] = await Promise.all([
    listAll<Resource>(s, "/v2/heartbeats", 5, signal),
    listAll<Resource>(s, "/v2/monitors", 5, signal),
  ]);
  const text = (v: unknown) => (v == null ? "" : String(v));
  return [
    ...heartbeats.map((h) => ({
      kind: "heartbeat" as const,
      id: String(h.id),
      name: text(h.attributes.name) || `Heartbeat ${h.id}`,
      status: text(h.attributes.status),
      detail: `heartbeat every ${text(h.attributes.period)}s`,
    })),
    ...monitors.map((m) => ({
      kind: "monitor" as const,
      id: String(m.id),
      name:
        text(m.attributes.pronounceable_name) ||
        text(m.attributes.url) ||
        `Monitor ${m.id}`,
      status: text(m.attributes.status),
      detail: text(m.attributes.url),
    })),
  ];
}

/**
 * Makes sure Better Stack sends incident changes to Rox: finds Rox's outgoing webhook by name, or
 * creates it. It carries the secret header the webhook route checks. Returns its id.
 */
export async function ensureWebhook(
  s: BetterStackEnv,
  url: string,
  secret: string,
  signal?: AbortSignal,
): Promise<{ id: string; created: boolean }> {
  const existing = await listAll<Resource>(
    s,
    "/v2/outgoing-webhooks",
    5,
    signal,
  );
  const ours = existing.find((w) => w.attributes.name === WEBHOOK_NAME);
  const body = {
    name: WEBHOOK_NAME,
    url,
    trigger_type: "incident_change",
    on_incident_started: true,
    on_incident_resolved: true,
    on_incident_acknowledged: false,
    on_incident_reopened: true,
    on_incident_comment: false,
    custom_webhook_template_attributes: {
      http_method: "post",
      headers_template: [
        { name: "Content-Type", value: "application/json" },
        { name: BETTERSTACK_SECRET_HEADER, value: secret },
      ],
    },
  };
  if (ours) {
    // Kept in step with .env: the URL or the secret may have changed since.
    await call(s, `/v2/outgoing-webhooks/${ours.id}`, {
      method: "PATCH",
      body,
      signal,
    });
    return { id: String(ours.id), created: false };
  }
  const made = await call<{ data: Resource }>(s, "/v2/outgoing-webhooks", {
    method: "POST",
    body,
    signal,
  });
  return { id: String(made.data.id), created: true };
}

/** An incident as Better Stack's API reports it (not as a webhook body claims). */
export type BetterStackIncident = {
  id: string;
  name: string;
  cause: string | null;
  url: string | null;
  status: string;
  startedAt: string | null;
  resolvedAt: string | null;
  responseContent: string | null;
  source: { kind: "heartbeat" | "monitor"; id: string } | null;
};

export async function getIncident(
  s: BetterStackEnv,
  id: string,
  signal?: AbortSignal,
): Promise<BetterStackIncident> {
  const { data } = await call<{
    data: Resource & {
      relationships?: Record<string, { data?: { id?: string } | null }>;
    };
  }>(s, `/v3/incidents/${encodeURIComponent(id)}`, { signal });
  const a = data.attributes;
  const str = (v: unknown) => (v == null || v === "" ? null : String(v));
  const rel = data.relationships ?? {};
  const heartbeat = rel.heartbeat?.data?.id;
  const monitor = rel.monitor?.data?.id;
  return {
    id: String(data.id),
    name: str(a.name) ?? `Incident ${data.id}`,
    cause: str(a.cause),
    url: str(a.url),
    status: str(a.status) ?? "unknown",
    startedAt: str(a.started_at),
    resolvedAt: str(a.resolved_at),
    responseContent: str(a.response_content)?.slice(0, 2000) ?? null,
    source: heartbeat
      ? { kind: "heartbeat", id: String(heartbeat) }
      : monitor
        ? { kind: "monitor", id: String(monitor) }
        : null,
  };
}

/** The secret header, compared in constant time. */
export function validBetterStackSecret(
  header: string | null,
  secret: string,
): boolean {
  if (!header) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(header.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

export type BetterStackTrigger = "betterstack:monitor_incident";

/**
 * What an incident means for Rox, or why it is ignored. Read from the API's incident, never from
 * the webhook body. Only a started (or reopened) incident wakes Rox; a resolved one is logged.
 */
export function decideBetterStack(
  incident: BetterStackIncident,
):
  | { wake: true; trigger: BetterStackTrigger; why: string }
  | { wake: false; ignored: string } {
  if (!incident.source)
    return {
      wake: false,
      ignored: "the incident has no heartbeat or monitor behind it",
    };
  if (incident.resolvedAt)
    return { wake: false, ignored: "the incident is resolved" };
  return {
    wake: true,
    trigger: "betterstack:monitor_incident",
    why: `${incident.source.kind === "heartbeat" ? "Heartbeat" : "Monitor"} "${incident.name}" is down${incident.cause ? `: ${incident.cause}` : ""}`,
  };
}
