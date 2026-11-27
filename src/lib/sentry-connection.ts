// The user's Sentry connection. The token stays in .env; user_setup only records which project is
// theirs, so a webhook for that project can find them.
import { listProjects, sentryFromEnv } from "@agent/integrations/sentry";
import { withUser } from "./db";

export type SentryConnection = {
  org: string;
  project: string;
  projectId: string;
  connectedAt: string;
};

export type SentryCheck = {
  ready: boolean;
  org: string | null;
  /** SENTRY_CLIENT_SECRET is set, so Sentry's webhooks can be verified. */
  webhooks: boolean;
  projects: { id: string; slug: string; name: string }[];
  error: string | null;
};

/** Checks SENTRY_AUTH_TOKEN and SENTRY_ORG against Sentry. Never returns the token. */
export async function checkSentry(): Promise<SentryCheck> {
  const webhooks = Boolean(process.env.SENTRY_CLIENT_SECRET?.trim());
  const s = sentryFromEnv();
  if (!s)
    return {
      ready: false,
      org: null,
      webhooks,
      projects: [],
      error: "SENTRY_AUTH_TOKEN and SENTRY_ORG are not set in .env.",
    };
  try {
    const projects = await listProjects(s);
    return {
      ready: true,
      org: s.org,
      webhooks,
      projects: projects.map((p) => ({
        id: String(p.id),
        slug: p.slug,
        name: p.name,
      })),
      error: projects.length ? null : `The token sees no project in ${s.org}.`,
    };
  } catch (error) {
    return {
      ready: false,
      org: s.org,
      webhooks,
      projects: [],
      error: `Sentry refused the token: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function getSentryConnection(
  userId: string,
): Promise<SentryConnection | null> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{
      sentry_org: string | null;
      sentry_project: string | null;
      sentry_project_id: string | null;
      sentry_connected_at: Date | null;
    }>(
      "SELECT sentry_org, sentry_project, sentry_project_id, sentry_connected_at FROM user_setup WHERE user_id = $1",
      [userId],
    );
    const r = rows[0];
    return r?.sentry_project_id &&
      r.sentry_org &&
      r.sentry_project &&
      r.sentry_connected_at
      ? {
          org: r.sentry_org,
          project: r.sentry_project,
          projectId: r.sentry_project_id,
          connectedAt: r.sentry_connected_at.toISOString(),
        }
      : null;
  });
}

export async function saveSentryConnection(
  userId: string,
  c: { org: string; project: string; projectId: string } | null,
) {
  await withUser(userId, (client) =>
    client.query(
      `INSERT INTO user_setup (user_id, sentry_org, sentry_project, sentry_project_id, sentry_connected_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END)
       ON CONFLICT (user_id) DO UPDATE
         SET sentry_org = EXCLUDED.sentry_org, sentry_project = EXCLUDED.sentry_project,
             sentry_project_id = EXCLUDED.sentry_project_id,
             sentry_connected_at = EXCLUDED.sentry_connected_at`,
      [userId, c?.org ?? null, c?.project ?? null, c?.projectId ?? null],
    ),
  );
}

export async function getTriggers(userId: string): Promise<string[] | null> {
  return withUser(userId, async (c) => {
    const { rows } = await c.query<{ triggers: string[] }>(
      "SELECT triggers FROM user_setup WHERE user_id = $1",
      [userId],
    );
    return rows[0]?.triggers ?? null;
  });
}

export async function saveTriggers(userId: string, ids: string[]) {
  await withUser(userId, (c) =>
    c.query(
      `INSERT INTO user_setup (user_id, triggers) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET triggers = EXCLUDED.triggers`,
      [userId, ids],
    ),
  );
}
