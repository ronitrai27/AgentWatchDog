// Sentry Web API adapter. One org-level token in .env (SENTRY_AUTH_TOKEN) reads projects and
// issue events; SENTRY_CLIENT_SECRET signs the webhooks Sentry sends to Rox.
import { createHmac, timingSafeEqual } from "node:crypto";

export type SentryEnv = {
  token: string;
  org: string;
  /** https://sentry.io, or the region (https://de.sentry.io for EU orgs). */
  baseUrl: string;
};

export function sentryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SentryEnv | null {
  const token = env.SENTRY_AUTH_TOKEN?.trim();
  const org = env.SENTRY_ORG?.trim();
  if (!token || !org) return null;
  const baseUrl = (env.SENTRY_URL?.trim() || "https://sentry.io").replace(
    /\/$/,
    "",
  );
  return { token, org, baseUrl };
}

async function call<T>(
  s: SentryEnv,
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`${s.baseUrl}/api/0${path}`, {
    headers: { Authorization: `Bearer ${s.token}` },
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Sentry answered ${res.status} for ${path}: ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as T;
}

export type SentryProject = {
  id: string;
  slug: string;
  name: string;
  platform: string | null;
};

export function listProjects(s: SentryEnv, signal?: AbortSignal) {
  return call<SentryProject[]>(s, `/organizations/${s.org}/projects/`, signal);
}

/** Sentry's own HMAC-SHA256 (hex) of the raw body, with the integration's client secret. */
export function validSentrySignature(
  body: string,
  signature: string | null,
  secret: string,
) {
  if (!signature) return false;
  const expected = createHmac("sha256", secret)
    .update(body, "utf8")
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

export type SentryTrigger =
  | "sentry:new_issue"
  | "sentry:error_spike"
  | "sentry:regression";

export type SentryIncident = {
  trigger: SentryTrigger;
  issueId: string;
  projectId: string;
  title: string;
  culprit: string | null;
  link: string | null;
  why: string;
};

type Issue = {
  id?: string | number;
  title?: string;
  culprit?: string;
  permalink?: string;
  web_url?: string;
  substatus?: string;
  project?: { id?: string | number } | string | number;
};

function projectIdOf(p: Issue["project"]): string {
  if (p && typeof p === "object") return String(p.id ?? "");
  return p == null ? "" : String(p);
}

/**
 * What a Sentry webhook means for Rox, or a reason it is ignored.
 * - issue.created                          -> new issue
 * - issue.unresolved, substatus regressed  -> regression
 * - event_alert.triggered                  -> by the alert rule's name ("spike", "regress", "new")
 */
export function decideSentry(
  resource: string,
  payload: unknown,
): { incident: SentryIncident } | { ignored: string } {
  const p = payload as {
    action?: string;
    data?: {
      issue?: Issue;
      event?: Issue & { issue_id?: string | number; issue_url?: string };
      triggered_rule?: string;
    };
  };
  if (resource === "issue") {
    const issue = p.data?.issue;
    if (!issue?.id) return { ignored: "issue event without an issue" };
    const base = {
      issueId: String(issue.id),
      projectId: projectIdOf(issue.project),
      title: issue.title ?? "Untitled issue",
      culprit: issue.culprit ?? null,
      link: issue.permalink ?? issue.web_url ?? null,
    };
    if (p.action === "created")
      return {
        incident: {
          ...base,
          trigger: "sentry:new_issue",
          why: "a new issue was created",
        },
      };
    if (p.action === "unresolved" && issue.substatus === "regressed")
      return {
        incident: {
          ...base,
          trigger: "sentry:regression",
          why: "a resolved issue came back",
        },
      };
    return { ignored: `issue.${p.action ?? "?"} is not a trigger` };
  }
  if (resource === "event_alert") {
    const event = p.data?.event;
    const rule = (p.data?.triggered_rule ?? "").toLowerCase();
    if (!event?.issue_id) return { ignored: "alert without an issue" };
    const trigger: SentryTrigger | null = rule.includes("spike")
      ? "sentry:error_spike"
      : rule.includes("regress")
        ? "sentry:regression"
        : rule.includes("new")
          ? "sentry:new_issue"
          : null;
    if (!trigger)
      return {
        ignored: `alert rule "${p.data?.triggered_rule}" does not name spike, regression or new`,
      };
    return {
      incident: {
        trigger,
        issueId: String(event.issue_id),
        projectId: projectIdOf(event.project),
        title: event.title ?? "Untitled issue",
        culprit: event.culprit ?? null,
        link: event.web_url ?? event.issue_url ?? null,
        why: `alert rule "${p.data?.triggered_rule}" fired`,
      },
    };
  }
  return { ignored: `${resource} events are not triggers` };
}

export type IncidentFacts = {
  title: string;
  level: string | null;
  release: string | null;
  environment: string | null;
  service: string | null;
  exception: string | null;
  /** The innermost in-app frame: where the code broke. */
  frame: string | null;
  link: string | null;
};

type LatestEvent = {
  title?: string;
  tags?: { key: string; value: string }[];
  release?: { version?: string } | null;
  entries?: {
    type: string;
    data?: {
      values?: {
        type?: string;
        value?: string;
        stacktrace?: {
          frames?: {
            filename?: string;
            function?: string;
            lineNo?: number;
            inApp?: boolean;
          }[];
        } | null;
      }[];
    };
  }[];
};

/** The latest event of an issue: exception, top in-app frame, release and tags. */
export async function incidentFacts(
  s: SentryEnv,
  issueId: string,
  signal?: AbortSignal,
): Promise<IncidentFacts> {
  const e = await call<LatestEvent>(
    s,
    `/organizations/${s.org}/issues/${issueId}/events/latest/`,
    signal,
  );
  const tag = (k: string) => e.tags?.find((t) => t.key === k)?.value ?? null;
  const exc = e.entries
    ?.find((x) => x.type === "exception")
    ?.data?.values?.at(-1);
  const frames = exc?.stacktrace?.frames ?? [];
  const top = [...frames].reverse().find((f) => f.inApp) ?? frames.at(-1);
  return {
    title: e.title ?? "Untitled issue",
    level: tag("level"),
    release: e.release?.version ?? tag("release"),
    environment: tag("environment"),
    service: tag("service"),
    exception: exc ? `${exc.type ?? "Error"}: ${exc.value ?? ""}`.trim() : null,
    frame: top
      ? `${top.filename ?? "?"}:${top.lineNo ?? "?"} in ${top.function ?? "?"}`
      : null,
    // The org subdomain works for every region.
    link: `https://${s.org}.sentry.io/issues/${issueId}/`,
  };
}
