import { randomBytes } from "node:crypto";
import { db } from "./db";

export type DbUser = {
  id: string;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  is_demo: boolean;
};

/** Creates the user on first sign-in, refreshes their profile on later ones. */
export async function upsertGithubUser(input: {
  githubId: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}): Promise<DbUser> {
  const { rows } = await db().query<DbUser>(
    `INSERT INTO users (github_id, login, name, email, avatar_url)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (github_id) DO UPDATE
       SET login = EXCLUDED.login,
           name = EXCLUDED.name,
           email = EXCLUDED.email,
           avatar_url = EXCLUDED.avatar_url,
           last_seen_at = now()
     RETURNING id, login, name, email, avatar_url, is_demo`,
    [input.githubId, input.login, input.name, input.email, input.avatarUrl],
  );
  return rows[0];
}

/**
 * Quick Judge Mode: a brand-new user for this session. No GitHub, no
 * credentials. The login is random and the display name is "User".
 */
export async function createJudgeUser(): Promise<DbUser> {
  const login = `user-${randomBytes(4).toString("hex")}`;
  const { rows } = await db().query<DbUser>(
    `INSERT INTO users (login, name, is_demo)
     VALUES ($1, 'User', true)
     RETURNING id, login, name, email, avatar_url, is_demo`,
    [login],
  );
  return rows[0];
}

type AuditInput = {
  userId: string | null;
  actor: string;
  type: string;
  verdict?: "ALLOW" | "DENY" | "PASS" | "FAIL" | "INFO";
  data?: Record<string, unknown>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Appends one audit event. Never throws: losing an audit row must not block a
 * sign-in, but the failure is logged so it is not silent.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    const userId =
      input.userId && UUID.test(input.userId) ? input.userId : null;
    await db().query(
      `INSERT INTO audit_events (user_id, actor, type, verdict, data)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        userId,
        input.actor,
        input.type,
        input.verdict ?? "INFO",
        input.data ?? {},
      ],
    );
  } catch (error) {
    console.error("audit write failed:", (error as Error).message);
  }
}
